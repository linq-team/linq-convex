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
