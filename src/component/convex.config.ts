import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The Linq component.
 *
 * Its env vars are bound by the installing app (see the README), so the API key
 * lives in the deployment's environment and is never written to a table.
 */
export default defineComponent("linq", {
  env: {
    /** Linq Partner API key, used by the outbox to send. */
    LINQ_API_KEY: v.optional(v.string()),
    /** Override the API origin, e.g. for a sandbox. */
    LINQ_BASE_URL: v.optional(v.string()),
  },
});
