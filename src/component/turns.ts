/**
 * Turns: one call of the app's message handler with the messages a chat has
 * queued. A chat runs one turn at a time, so a bot never talks over itself;
 * messages that arrive meanwhile wait for the next turn.
 */

import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  query,
} from "./_generated/server.js";

export const turnMessage = v.object({
  messageId: v.string(),
  from: v.string(),
  text: v.string(),
  service: v.optional(v.string()),
  sentAt: v.optional(v.string()),
  raw: v.any(),
});

/** Schedule the chat's next turn, replacing one that has not started yet. */
export async function scheduleTurn(
  ctx: MutationCtx,
  chatId: string,
  delayMs: number,
): Promise<void> {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
    .unique();
  if (!chat) return;
  if (chat.pendingTurnJob) {
    const job = await ctx.db.system.get("_scheduled_functions", chat.pendingTurnJob);
    if (job?.state.kind === "pending") {
      await ctx.scheduler.cancel(chat.pendingTurnJob);
    }
  }
  const pendingTurnJob = await ctx.scheduler.runAfter(delayMs, internal.turns.start, {
    chatId,
  });
  await ctx.db.patch("chats", chat._id, { pendingTurnJob });
}

/**
 * Interrupt the chat's running turn: drop its unsent replies, and hand its
 * messages to the next turn unless it already answered them.
 */
export async function interruptRunningTurn(ctx: MutationCtx, chatId: string): Promise<void> {
  const running = await ctx.db
    .query("turns")
    .withIndex("by_chatId_and_status", (q) => q.eq("chatId", chatId).eq("status", "running"))
    .collect();
  for (const turn of running) {
    await ctx.db.patch("turns", turn._id, { status: "interrupted", endedAt: Date.now() });

    let answered = false;
    const sends = await ctx.db
      .query("outbox")
      .withIndex("by_turnId", (q) => q.eq("turnId", turn._id))
      .collect();
    for (const send of sends) {
      if (send.status === "queued") {
        await ctx.db.patch("outbox", send._id, { status: "cancelled" });
      } else if (send.kind === "message" && (send.status === "sent" || send.status === "sending")) {
        answered = true;
      }
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_turnId", (q) => q.eq("turnId", turn._id))
      .collect();
    for (const m of messages) {
      await ctx.db.patch(
        "messages",
        m._id,
        answered ? { status: "handled" } : { status: "queued", turnId: undefined },
      );
    }
  }
}

/** Start a turn with every queued message, unless one is already running. */
export const start = internalMutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) return null;
    await ctx.db.patch("chats", chat._id, { pendingTurnJob: undefined });
    if (!chat.onMessage) return null;

    const running = await ctx.db
      .query("turns")
      .withIndex("by_chatId_and_status", (q) => q.eq("chatId", chatId).eq("status", "running"))
      .first();
    // `finish` starts the next turn when this one ends.
    if (running) return null;

    const queued = await ctx.db
      .query("messages")
      .withIndex("by_chatId_and_status", (q) => q.eq("chatId", chatId).eq("status", "queued"))
      .collect();
    if (queued.length === 0) return null;

    const turnId = await ctx.db.insert("turns", {
      chatId,
      status: "running",
      startedAt: Date.now(),
    });
    for (const m of queued) {
      await ctx.db.patch("messages", m._id, { status: "inTurn", turnId });
    }
    await ctx.scheduler.runAfter(0, internal.turns.run, {
      turnId,
      chatId,
      line: chat.line,
      isGroup: chat.isGroup,
      onMessage: chat.onMessage,
      messages: queued.map((m) => ({
        messageId: m.messageId,
        from: m.from,
        text: m.text,
        service: m.service,
        sentAt: m.sentAt,
        raw: m.raw,
      })),
    });
    return null;
  },
});

/** Call the app's handler, then close the turn whatever it did. */
export const run = internalAction({
  args: {
    turnId: v.id("turns"),
    chatId: v.string(),
    line: v.optional(v.string()),
    isGroup: v.optional(v.boolean()),
    onMessage: v.string(),
    messages: v.array(turnMessage),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let error: string | undefined;
    try {
      await ctx.runAction(args.onMessage as FunctionHandle<"action">, {
        turnId: args.turnId,
        chatId: args.chatId,
        line: args.line,
        isGroup: args.isGroup,
        messages: args.messages,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`linq: message handler failed for chat ${args.chatId}: ${error}`);
    }
    await ctx.runMutation(internal.turns.finish, { turnId: args.turnId, error });
    return null;
  },
});

export const finish = internalMutation({
  args: { turnId: v.id("turns"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { turnId, error }) => {
    const turn = await ctx.db.get("turns", turnId);
    if (!turn) return null;
    // An interrupted turn already handed its messages on.
    if (turn.status === "running") {
      await ctx.db.patch("turns", turnId, {
        status: error === undefined ? "done" : "failed",
        endedAt: Date.now(),
        error,
      });
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_turnId", (q) => q.eq("turnId", turnId))
        .collect();
      for (const m of messages) {
        await ctx.db.patch("messages", m._id, { status: "handled" });
      }
    }
    const next = await ctx.db
      .query("messages")
      .withIndex("by_chatId_and_status", (q) =>
        q.eq("chatId", turn.chatId).eq("status", "queued"),
      )
      .first();
    if (next) await scheduleTurn(ctx, turn.chatId, 0);
    return null;
  },
});

/**
 * Has a newer message interrupted this turn? Only with `interrupt: true`. A
 * running action cannot be stopped from outside, so a handler doing slow work
 * should check this before spending more; its queued replies are dropped
 * either way.
 */
export const isInterrupted = query({
  args: { turnId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { turnId }) => {
    const id = ctx.db.normalizeId("turns", turnId);
    if (!id) return false;
    const turn = await ctx.db.get("turns", id);
    return turn?.status === "interrupted";
  },
});

export type TurnId = Id<"turns">;
