/**
 * One-time setup against the Linq API, run by the app (see the client's
 * `registerWebhook`) or from the CLI.
 */

import { v } from "convex/values";
import { action, env } from "./_generated/server.js";
import { linqRequest } from "./transport.js";

function requireKey(): string {
  const apiKey = env.LINQ_API_KEY;
  if (!apiKey) throw new Error("LINQ_API_KEY is not set for the linq component (see README: Configure)");
  return apiKey;
}

/**
 * Point a Linq webhook subscription at this deployment. Returns the signing
 * secret, which Linq shows only once: store it as LINQ_WEBHOOK_SECRET.
 */
export const registerWebhook = action({
  args: {
    targetUrl: v.string(),
    events: v.array(v.string()),
    phoneNumbers: v.optional(v.array(v.string())),
  },
  returns: v.object({ subscriptionId: v.string(), signingSecret: v.string(), targetUrl: v.string() }),
  handler: async (_ctx, args) => {
    const result = await linqRequest(
      { apiKey: requireKey(), baseUrl: env.LINQ_BASE_URL },
      "POST",
      "/v3/webhook-subscriptions",
      {
        target_url: args.targetUrl,
        subscribed_events: args.events,
        ...(args.phoneNumbers?.length ? { phone_numbers: args.phoneNumbers } : {}),
      },
    );
    if (!result.ok) throw new Error(`linq: webhook subscription failed: ${result.error}`);
    const body = result.body as { id: string; signing_secret: string };
    return { subscriptionId: body.id, signingSecret: body.signing_secret, targetUrl: args.targetUrl };
  },
});

/** The lines (phone numbers) this API key can send from. */
export const listLines = action({
  args: {},
  returns: v.any(),
  handler: async () => {
    const result = await linqRequest(
      { apiKey: requireKey(), baseUrl: env.LINQ_BASE_URL },
      "GET",
      "/v3/phone_numbers",
    );
    if (!result.ok) throw new Error(`linq: listing lines failed: ${result.error}`);
    return result.body;
  },
});
