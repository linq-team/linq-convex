/**
 * Inbound webhook events. `ingest` runs inside the webhook's HTTP action, so a
 * delivery is stored before Linq gets its 200 and nothing is lost if a later
 * step fails.
 */

import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { mutation, query } from "./_generated/server.js";
import {
  DELIVERY_EVENTS,
  deliveryError,
  deliveryMessageId,
  parseInboundMessage,
} from "../shared/events.js";
import { interruptRunningTurn, scheduleTurn } from "./turns.js";
import { inboundStatus } from "./schema.js";
import { recordDelivery } from "./delivery.js";

export const ingest = mutation({
  args: {
    /** Linq's event id (`webhook-id`), the dedupe key. */
    eventId: v.string(),
    /** The verified webhook envelope. */
    event: v.any(),
    onMessage: v.optional(v.string()),
    onEvent: v.optional(v.string()),
    debounceMs: v.optional(v.number()),
    interrupt: v.optional(v.boolean()),
  },
  returns: v.object({ duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("events")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    if (seen) return { duplicate: true };

    const eventType: string = typeof args.event?.event_type === "string" ? args.event.event_type : "unknown";
    await ctx.db.insert("events", { eventId: args.eventId, eventType, receivedAt: Date.now() });
    const data: unknown = args.event?.data;

    if (eventType === "message.received") {
      const m = parseInboundMessage(data);
      if (m) {
        const existing = await ctx.db
          .query("messages")
          .withIndex("by_messageId", (q) => q.eq("messageId", m.messageId))
          .first();
        if (!existing) {
          const chat = await ctx.db
            .query("chats")
            .withIndex("by_chatId", (q) => q.eq("chatId", m.chatId))
            .unique();
          const facts = {
            lastInboundAt: Date.now(),
            onMessage: args.onMessage,
            ...(m.isGroup === undefined ? {} : { isGroup: m.isGroup }),
            ...(m.line === undefined ? {} : { line: m.line }),
          };
          if (chat) await ctx.db.patch("chats", chat._id, facts);
          else await ctx.db.insert("chats", { chatId: m.chatId, ...facts });

          // Late, reconciled messages are history: store them, answer nothing.
          const startsTurn = args.onMessage !== undefined && m.reconciledAt === undefined;
          await ctx.db.insert("messages", {
            chatId: m.chatId,
            messageId: m.messageId,
            from: m.from,
            text: m.text,
            service: m.service,
            sentAt: m.sentAt,
            reconciledAt: m.reconciledAt,
            raw: data,
            status: startsTurn ? "queued" : "handled",
          });
          if (startsTurn) {
            if (args.interrupt) await interruptRunningTurn(ctx, m.chatId);
            await scheduleTurn(ctx, m.chatId, args.debounceMs ?? 0);
          }
        }
      }
    } else if (eventType in DELIVERY_EVENTS) {
      const status = DELIVERY_EVENTS[eventType as keyof typeof DELIVERY_EVENTS];
      const messageId = deliveryMessageId(eventType, data);
      if (messageId) {
        await recordDelivery(ctx, messageId, status, deliveryError(data));
      }
    }

    if (args.onEvent) {
      await ctx.scheduler.runAfter(0, args.onEvent as FunctionHandle<"action" | "mutation">, {
        event: args.event,
      });
    }
    return { duplicate: false };
  },
});

/** Stored inbound messages for a chat, oldest first. */
export const listMessages = query({
  args: { chatId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      messageId: v.string(),
      from: v.string(),
      text: v.string(),
      service: v.optional(v.string()),
      sentAt: v.optional(v.string()),
      status: inboundStatus,
      receivedAt: v.number(),
    }),
  ),
  handler: async (ctx, { chatId, limit }) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(Math.min(limit ?? 50, 500));
    return rows.reverse().map((m) => ({
      messageId: m.messageId,
      from: m.from,
      text: m.text,
      service: m.service,
      sentAt: m.sentAt,
      status: m.status,
      receivedAt: m._creationTime,
    }));
  },
});

/** What the component knows about a chat, or `null`. */
export const getChat = query({
  args: { chatId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      chatId: v.string(),
      isGroup: v.optional(v.boolean()),
      line: v.optional(v.string()),
      lastInboundAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) return null;
    return {
      chatId: chat.chatId,
      isGroup: chat.isGroup,
      line: chat.line,
      lastInboundAt: chat.lastInboundAt,
    };
  },
});
