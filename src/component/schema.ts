import { defineSchema } from "convex/server";

/**
 * Deliberately empty. This component stores nothing: no messages, events or
 * metadata. Messages exist only inside the calls that handle them, and Linq's
 * webhook retries are the only queue. Keep it that way; see README "Data".
 */
export default defineSchema({});
