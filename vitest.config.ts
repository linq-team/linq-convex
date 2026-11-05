import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Closest match to the Convex V8 runtime: catches accidental Node built-ins
    // in component code.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
