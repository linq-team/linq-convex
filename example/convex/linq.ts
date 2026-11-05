import { Linq } from "@linqapp/convex";
import { components, internal } from "./_generated/api.js";

// Typed explicitly: this module reads `internal.*` while bot.ts imports `linq`.
export const linq: Linq = new Linq(components.linq, {
  onMessage: internal.bot.reply,
});
