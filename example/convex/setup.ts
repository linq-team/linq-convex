import { v } from "convex/values";
import { internalAction } from "./_generated/server.js";
import { linq } from "./linq.js";

/**
 * Subscribe this deployment to Linq webhooks:
 *   npx convex run setup:webhook
 * then store the printed secret:
 *   npx convex env set LINQ_WEBHOOK_SECRET <signingSecret>
 */
export const webhook = internalAction({
  args: { phoneNumbers: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (ctx, args) => await linq.registerWebhook(ctx, args),
});

/** npx convex run setup:lines */
export const lines = internalAction({
  args: {},
  returns: v.any(),
  handler: async (ctx) => await linq.listLines(ctx),
});

/**
 * Send a test message:
 *   npx convex run setup:send '{"to":["+15551234567"],"text":"hi","idempotencyKey":"test-send-1"}'
 * Omit `from` and `chatId` to let Linq pick the line.
 * Reuse the key only when retrying this same send; use a new key for a new message.
 */
export const send = internalAction({
  args: {
    text: v.string(),
    idempotencyKey: v.string(),
    to: v.optional(v.array(v.string())),
    from: v.optional(v.string()),
    chatId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, { text, to, from, chatId, idempotencyKey }) =>
    chatId
      ? await linq.sendMessage(ctx, { chatId, text, idempotencyKey })
      : await linq.sendMessage(ctx, { from, to: to ?? [], text, idempotencyKey }),
});
