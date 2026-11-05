/**
 * Outbound sends. Queuing is a mutation, so a reply commits atomically with
 * whatever the app wrote alongside it. Each lane (one chat) sends one row at a
 * time in queue order, and every attempt carries the same idempotency key, so
 * a retry after a lost response never double-sends.
 */

import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  env,
  internalAction,
  internalMutation,
  mutation,
  type MutationCtx,
  query,
} from "./_generated/server.js";
import { deliveryStatus, sendKind, sendStatus } from "./schema.js";
import { receiptForMessage } from "./delivery.js";
import { linqRequest, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, type CallResult } from "./transport.js";

// A durable mutation recovers a worker that exits without settling its row.
export const ATTEMPT_LEASE_MS = REQUEST_TIMEOUT_MS + 30_000;

async function cancelPending(ctx: MutationCtx, jobId?: Id<"_scheduled_functions">) {
  if (!jobId) return;
  const job = await ctx.db.system.get("_scheduled_functions", jobId);
  if (job?.state.kind === "pending") await ctx.scheduler.cancel(jobId);
}

async function scheduleAttempt(ctx: MutationCtx, row: Doc<"outbox">, delay = 0) {
  const generation = (row.generation ?? 0) + 1;
  const args = { id: row._id, generation };
  const job = await ctx.scheduler.runAfter(delay, internal.outbox.deliver, args);
  const recoveryJob = await ctx.scheduler.runAfter(delay + ATTEMPT_LEASE_MS, internal.outbox.recover, args);
  await ctx.db.patch("outbox", row._id, { status: "sending", generation, job, recoveryJob });
}

function laneFor(args: { chatId?: string; from?: string; to?: string[] }): string {
  if (args.chatId) return `chat:${args.chatId}`;
  return `new:${args.from}:${[...(args.to ?? [])].sort().join(",")}`;
}

/** Hand the lane's oldest queued row to `deliver`, unless one is in flight. */
async function pump(ctx: MutationCtx, lane: string): Promise<void> {
  const inFlight = await ctx.db
    .query("outbox")
    .withIndex("by_lane_and_status", (q) => q.eq("lane", lane).eq("status", "sending"))
    .first();
  if (inFlight) return;
  const next = await ctx.db
    .query("outbox")
    .withIndex("by_lane_and_status", (q) => q.eq("lane", lane).eq("status", "queued"))
    .first();
  if (!next) return;
  await scheduleAttempt(ctx, next);
}

export const enqueue = mutation({
  args: {
    kind: sendKind,
    chatId: v.optional(v.string()),
    /** With `to`, for a chat that may not exist yet: the line to send from. */
    from: v.optional(v.string()),
    to: v.optional(v.array(v.string())),
    message: v.optional(v.any()),
    turnId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.object({ id: v.string(), status: sendStatus }),
  handler: async (ctx, args) => {
    if (args.kind !== "message" && !args.chatId) {
      throw new Error(`linq: ${args.kind} needs a chatId`);
    }
    if (args.kind === "message") {
      if (!args.chatId && !(args.from && args.to?.length)) {
        throw new Error("linq: sendMessage needs a chatId, or from and to");
      }
      if (!args.message) throw new Error("linq: sendMessage needs text or a message");
    }
    if (args.idempotencyKey) {
      const key = args.idempotencyKey;
      const existing = await ctx.db
        .query("outbox")
        .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
        .first();
      if (existing) return { id: existing._id, status: existing.status };
    }

    let turnId: Id<"turns"> | undefined;
    if (args.turnId) {
      turnId = ctx.db.normalizeId("turns", args.turnId) ?? undefined;
      if (!turnId) throw new Error(`linq: unknown turnId ${args.turnId}`);
    }
    const turn = turnId ? await ctx.db.get("turns", turnId) : null;
    const cancelled = turn?.status === "interrupted";

    const lane = laneFor(args);
    const id = await ctx.db.insert("outbox", {
      kind: args.kind,
      lane,
      chatId: args.chatId,
      from: args.chatId ? undefined : args.from,
      to: args.chatId ? undefined : args.to,
      message: args.message,
      turnId,
      idempotencyKey: args.idempotencyKey,
      status: cancelled ? "cancelled" : "queued",
      attempts: 0,
      queuedAt: Date.now(),
    });
    if (!cancelled) await pump(ctx, lane);
    return { id, status: cancelled ? ("cancelled" as const) : ("queued" as const) };
  },
});

/** Claim dispatch in the same transactional order as an interruption. */
export const claim = internalMutation({
  args: { id: v.id("outbox"), generation: v.number() },
  handler: async (ctx, { id, generation }): Promise<Doc<"outbox"> | null> => {
    const row = await ctx.db.get("outbox", id);
    if (!row || row.status !== "sending" || (row.generation ?? 0) !== generation) return null;
    const turn = row.turnId ? await ctx.db.get("turns", row.turnId) : null;
    if (turn?.status === "interrupted" && row.dispatchedAt === undefined) {
      await ctx.runMutation(internal.outbox.settle, { id, generation, outcome: "cancelled" });
      return null;
    }
    // Once dispatched, retries must resolve the original send with the same key,
    // even if an interruption arrives while its outcome is unknown.
    if (row.dispatchedAt === undefined) await ctx.db.patch("outbox", id, { dispatchedAt: Date.now() });
    return row;
  },
});

/** Cancel only sends that have not crossed the dispatch boundary. */
export async function cancelTurnSends(ctx: MutationCtx, turnId: Id<"turns">): Promise<boolean> {
  const sends = await ctx.db.query("outbox").withIndex("by_turnId", q => q.eq("turnId", turnId)).collect();
  const lanes = new Set<string>();
  let answered = false;
  for (const send of sends) {
    if (send.status === "sent" || (send.status === "sending" && send.dispatchedAt !== undefined)) {
      if (send.kind === "message") answered = true;
    } else if (send.status === "queued" || send.status === "sending") {
      await cancelPending(ctx, send.job);
      await cancelPending(ctx, send.recoveryJob);
      await ctx.db.patch("outbox", send._id, { status: "cancelled", job: undefined, recoveryJob: undefined });
      lanes.add(send.lane);
    }
  }
  for (const lane of lanes) await pump(ctx, lane);
  return answered;
}

function messageBody(row: Doc<"outbox">): Record<string, unknown> {
  return {
    ...(row.message as Record<string, unknown>),
    idempotency_key: row.idempotencyKey ?? `convex-${row._id}`,
  };
}

async function call(row: Doc<"outbox">, apiKey: string, baseUrl?: string): Promise<CallResult> {
  const creds = { apiKey, baseUrl };
  const chat = row.chatId ? encodeURIComponent(row.chatId) : undefined;
  switch (row.kind) {
    case "typing":
      return linqRequest(creds, "POST", `/v3/chats/${chat}/typing`);
    case "read":
      return linqRequest(creds, "POST", `/v3/chats/${chat}/read`);
    case "message":
      return chat
        ? linqRequest(creds, "POST", `/v3/chats/${chat}/messages`, { message: messageBody(row) })
        : linqRequest(creds, "POST", "/v3/chats", {
            from: row.from,
            to: row.to,
            message: messageBody(row),
          });
  }
}

/** Linq's chat and message ids from a send response. */
function sentIds(body: unknown): { chatId?: string; messageId?: string } {
  const b = body as {
    chat_id?: string;
    message?: { id?: string };
    chat?: { id?: string; message?: { id?: string } };
  } | null;
  return {
    chatId: b?.chat_id ?? b?.chat?.id,
    messageId: b?.message?.id ?? b?.chat?.message?.id,
  };
}

export const deliver = internalAction({
  args: { id: v.id("outbox"), generation: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id, generation = 0 }) => {
    const apiKey = env.LINQ_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.outbox.settle, {
        id,
        generation,
        outcome: "failed",
        error: "LINQ_API_KEY is not set for the linq component (see README: Configure)",
      });
      return null;
    }
    const row = await ctx.runMutation(internal.outbox.claim, { id, generation });
    if (!row) return null;
    const result = await call(row, apiKey, env.LINQ_BASE_URL);
    if (result.ok) {
      await ctx.runMutation(internal.outbox.settle, {
        id,
        generation,
        outcome: "sent",
        ...sentIds(result.body),
      });
    } else {
      await ctx.runMutation(internal.outbox.settle, {
        id,
        generation,
        outcome: result.retryable ? "retry" : "failed",
        error: result.error,
        retryAfterMs: result.retryAfterMs,
      });
    }
    return null;
  },
});

export const settle = internalMutation({
  args: {
    id: v.id("outbox"),
    generation: v.optional(v.number()),
    outcome: v.union(
      v.literal("sent"),
      v.literal("retry"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    error: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
    chatId: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("outbox", args.id);
    if (!row || row.status !== "sending" || (row.generation ?? 0) !== (args.generation ?? 0)) return null;
    await cancelPending(ctx, row.recoveryJob);
    const attempts = row.attempts + 1;

    if (args.outcome === "retry" && attempts <= RETRY_DELAYS_MS.length) {
      const delay = Math.max(RETRY_DELAYS_MS[attempts - 1] ?? 0, args.retryAfterMs ?? 0);
      // Still `sending`: the lane stays blocked so later sends keep their order.
      await ctx.db.patch("outbox", row._id, { attempts, lastError: args.error });
      await scheduleAttempt(ctx, row, delay);
      return null;
    }

    if (args.outcome === "sent") {
      await ctx.db.patch("outbox", row._id, {
        status: "sent",
        attempts,
        sentAt: Date.now(),
        lastError: undefined,
        job: undefined,
        recoveryJob: undefined,
        ...(args.messageId ? { messageId: args.messageId, ...await receiptForMessage(ctx, args.messageId) } : {}),
        ...(args.chatId && !row.chatId ? { chatId: args.chatId } : {}),
      });
      if (args.chatId && !row.chatId) {
        const known = await ctx.db
          .query("chats")
          .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId!))
          .unique();
        if (!known) await ctx.db.insert("chats", { chatId: args.chatId, line: row.from });
      }
    } else {
      await ctx.db.patch("outbox", row._id, {
        status: args.outcome === "cancelled" ? "cancelled" : "failed",
        attempts,
        lastError: args.error,
        job: undefined,
        recoveryJob: undefined,
      });
    }
    await pump(ctx, row.lane);
    return null;
  },
});

/** Recover even when an action is terminated before its catch/finally runs. */
export const recover = internalMutation({
  args: { id: v.id("outbox"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get("outbox", args.id);
    if (!row || row.status !== "sending" || row.generation !== args.generation) return null;
    await cancelPending(ctx, row.job);
    await ctx.runMutation(internal.outbox.settle, {
      ...args, outcome: "retry", error: "Delivery worker did not finish before its lease expired",
    });
    return null;
  },
});

const sendView = v.object({
  id: v.string(),
  kind: sendKind,
  chatId: v.optional(v.string()),
  status: sendStatus,
  attempts: v.number(),
  queuedAt: v.number(),
  sentAt: v.optional(v.number()),
  messageId: v.optional(v.string()),
  delivery: v.optional(deliveryStatus),
  error: v.optional(v.string()),
});

function view(row: Doc<"outbox">) {
  return {
    id: row._id,
    kind: row.kind,
    chatId: row.chatId,
    status: row.status,
    attempts: row.attempts,
    queuedAt: row.queuedAt,
    sentAt: row.sentAt,
    messageId: row.messageId,
    delivery: row.delivery,
    error: row.deliveryError ?? row.lastError,
  };
}

/** One send's status, including Linq's delivery report. Reactive. */
export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), sendView),
  handler: async (ctx, { id }) => {
    const rowId = ctx.db.normalizeId("outbox", id);
    const row = rowId ? await ctx.db.get("outbox", rowId) : null;
    return row ? view(row) : null;
  },
});

/** Recent sends into a chat, oldest first. */
export const list = query({
  args: { chatId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(sendView),
  handler: async (ctx, { chatId, limit }) => {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(Math.min(limit ?? 50, 500));
    return rows.reverse().map(view);
  },
});

/** Cursor pagination by queued order, newest first. */
export const paginate = query({
  args: { chatId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(sendView),
  handler: async (ctx, { chatId, paginationOpts }) => {
    const result = await ctx.db.query("outbox")
      .withIndex("by_chatId", q => q.eq("chatId", chatId))
      .order("desc").paginate(paginationOpts);
    return { ...result, page: result.page.map(view) };
  },
});
