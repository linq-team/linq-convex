import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const direction = v.union(v.literal("inbound"), v.literal("outbound"));

/** Where an inbound message is in its turn lifecycle. */
export const inboundStatus = v.union(
  // Waiting for the chat's next turn.
  v.literal("queued"),
  // Handed to a turn that is still running.
  v.literal("inTurn"),
  // Its turn finished, or it was stored without triggering one.
  v.literal("handled"),
);

export const turnStatus = v.union(
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
  // A newer inbound message arrived while the turn was running and the app
  // enabled `interrupt`.
  v.literal("interrupted"),
);

export const sendKind = v.union(
  v.literal("message"),
  v.literal("typing"),
  v.literal("read"),
);

export const sendStatus = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  // Dropped because the turn that queued it was interrupted.
  v.literal("cancelled"),
);

/** Delivery state Linq reports for a sent message, from webhooks. */
export const deliveryStatus = v.union(
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("read"),
  v.literal("failed"),
);

export default defineSchema({
  /**
   * Webhook event ids already processed. Linq delivers at least once and
   * retries for up to 30 minutes, so this is the dedupe key for every event.
   */
  events: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    receivedAt: v.number(),
  }).index("by_eventId", ["eventId"]),

  /** One row per Linq chat the deployment has seen. */
  chats: defineTable({
    chatId: v.string(),
    isGroup: v.optional(v.boolean()),
    /** The Linq line (E.164) this chat runs on. */
    line: v.optional(v.string()),
    lastInboundAt: v.optional(v.number()),
    /** The app's message handler (a function handle), from the latest delivery. */
    onMessage: v.optional(v.string()),
    /** Scheduled job that will start the chat's next turn. */
    pendingTurnJob: v.optional(v.id("_scheduled_functions")),
  }).index("by_chatId", ["chatId"]),

  /** Inbound messages, deduped by Linq message id. */
  messages: defineTable({
    chatId: v.string(),
    messageId: v.string(),
    /** Sender handle: E.164 number or email. */
    from: v.string(),
    /** Plain text of the message's text parts, joined by newlines. */
    text: v.string(),
    service: v.optional(v.string()),
    sentAt: v.optional(v.string()),
    /**
     * Set when Linq recovered the message late (reconciliation). Stored but
     * never starts a turn, so a bot does not answer stale history.
     */
    reconciledAt: v.optional(v.string()),
    /** The Linq message event payload, as delivered. */
    raw: v.any(),
    status: inboundStatus,
    turnId: v.optional(v.id("turns")),
  })
    .index("by_messageId", ["messageId"])
    .index("by_chatId", ["chatId"])
    .index("by_chatId_and_status", ["chatId", "status"])
    .index("by_turnId", ["turnId"]),

  /** One invocation of the app's message handler. */
  turns: defineTable({
    chatId: v.string(),
    status: turnStatus,
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_chatId_and_status", ["chatId", "status"]),

  /**
   * Outbound actions. Each lane (a chat, or a not-yet-created chat keyed by its
   * line and recipients) sends one row at a time, in the order queued.
   */
  outbox: defineTable({
    kind: sendKind,
    lane: v.string(),
    chatId: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.array(v.string())),
    /** Linq `MessageContent`, minus the idempotency key. */
    message: v.optional(v.any()),
    turnId: v.optional(v.id("turns")),
    /**
     * The app's key, if it gave one. Sent on every attempt (falling back to a
     * key derived from the row id), so a retry never double-sends.
     */
    idempotencyKey: v.optional(v.string()),
    status: sendStatus,
    attempts: v.number(),
    queuedAt: v.number(),
    sentAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    /** Linq's id for the sent message. */
    messageId: v.optional(v.string()),
    delivery: v.optional(deliveryStatus),
    deliveryError: v.optional(v.string()),
    job: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_lane_and_status", ["lane", "status"])
    .index("by_turnId", ["turnId"])
    .index("by_messageId", ["messageId"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_chatId", ["chatId"]),
});
