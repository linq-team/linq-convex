import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { linq } from "./linq.js";

/** Echo bot: one call per turn. A real agent calls an LLM here. */
export const reply = internalAction({
  args: {
    turnId: v.string(),
    chatId: v.string(),
    line: v.optional(v.string()),
    isGroup: v.optional(v.boolean()),
    messages: v.array(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, turn) => {
    await ctx.runMutation(internal.bot.ack, { chatId: turn.chatId, turnId: turn.turnId });

    const texts = turn.messages.map((m: { text: string }) => m.text || "[attachment]");
    const answer = `you said: ${texts.join(" / ")}`;

    // Slow work happened? A newer message may have interrupted this turn.
    if (await linq.isInterrupted(ctx, { turnId: turn.turnId })) return null;

    await ctx.runMutation(internal.bot.send, {
      chatId: turn.chatId,
      turnId: turn.turnId,
      text: answer,
    });
    return null;
  },
});

export const ack = internalMutation({
  args: { chatId: v.string(), turnId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await linq.markRead(ctx, args);
    await linq.startTyping(ctx, args);
    return null;
  },
});

export const send = internalMutation({
  args: { chatId: v.string(), turnId: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await linq.sendMessage(ctx, args);
    return null;
  },
});
