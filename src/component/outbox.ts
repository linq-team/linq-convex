/**
 * Outbound sends. Queuing is a mutation, so a reply commits atomically with
 * whatever the app wrote alongside it. Each lane (one chat) sends one row at a
 * time in queue order, and every attempt carries the same idempotency key, so
 * a retry after a lost response never double-sends.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
} from "./_generated/server.js";
import { deliveryStatus, sendKind, sendStatus } from "./schema.js";
import { linqRequest, RETRY_DELAYS_MS, type CallResult } from "./transport.js";

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
  const job = await ctx.scheduler.runAfter(0, internal.outbox.deliver, { id: next._id });
  await ctx.db.patch("outbox", next._id, { status: "sending", job });
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

export const load = internalQuery({
  args: { id: v.id("outbox") },
  handler: async (ctx, { id }): Promise<{ row: Doc<"outbox">; interrupted: boolean } | null> => {
    const row = await ctx.db.get("outbox", id);
    if (!row) return null;
    const turn = row.turnId ? await ctx.db.get("turns", row.turnId) : null;
    return { row, interrupted: turn?.status === "interrupted" };
  },
});

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
  args: { id: v.id("outbox") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const loaded = await ctx.runQuery(internal.outbox.load, { id });
    if (!loaded || loaded.row.status !== "sending") return null;
    if (loaded.interrupted) {
      await ctx.runMutation(internal.outbox.settle, { id, outcome: "cancelled" });
      return null;
    }
    const apiKey = env.LINQ_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.outbox.settle, {
        id,
        outcome: "failed",
        error: "LINQ_API_KEY is not set for the linq component (see README: Configure)",
      });
      return null;
    }
    const result = await call(loaded.row, apiKey, env.LINQ_BASE_URL);
    if (result.ok) {
      await ctx.runMutation(internal.outbox.settle, {
        id,
        outcome: "sent",
        ...sentIds(result.body),
      });
    } else {
      await ctx.runMutation(internal.outbox.settle, {
        id,
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
    if (!row || row.status !== "sending") return null;
    const attempts = row.attempts + 1;

    if (args.outcome === "retry" && attempts <= RETRY_DELAYS_MS.length) {
      const delay = Math.max(RETRY_DELAYS_MS[attempts - 1] ?? 0, args.retryAfterMs ?? 0);
      const job = await ctx.scheduler.runAfter(delay, internal.outbox.deliver, { id: row._id });
      // Still `sending`: the lane stays blocked so later sends keep their order.
      await ctx.db.patch("outbox", row._id, { attempts, lastError: args.error, job });
      return null;
    }

    if (args.outcome === "sent") {
      await ctx.db.patch("outbox", row._id, {
        status: "sent",
        attempts,
        sentAt: Date.now(),
        lastError: undefined,
        job: undefined,
        ...(args.messageId ? { messageId: args.messageId, delivery: "sent" as const } : {}),
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
      });
    }
    await pump(ctx, row.lane);
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
