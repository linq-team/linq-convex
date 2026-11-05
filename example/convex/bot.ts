import { onMessageArgs } from "@linqapp/convex";
import { internalAction } from "./_generated/server.js";
import { linq } from "./linq.js";

/**
 * Echo bot. Runs inside the webhook request, so it must finish within Linq's
 * 10-second webhook timeout. Nothing here is stored anywhere.
 */
export const reply = internalAction({
  args: onMessageArgs,
  handler: async (ctx, { message }) => {
    await linq.markRead(ctx, { chatId: message.chatId });
    await linq.sendMessage(ctx, {
      chatId: message.chatId,
      text: `you said: ${message.text || "[attachment]"}`,
      // Stable per inbound message: a redelivered webhook can't reply twice.
      idempotencyKey: `reply:${message.messageId}`,
    });
  },
});
