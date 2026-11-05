import linq from "@linqapp/convex/convex.config.js";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    LINQ_API_KEY: v.optional(v.string()),
    LINQ_BASE_URL: v.optional(v.string()),
    LINQ_WEBHOOK_SECRET: v.optional(v.string()),
  },
});

// The component reads only the env vars bound here.
app.use(linq, {
  env: { LINQ_API_KEY: app.env.LINQ_API_KEY, LINQ_BASE_URL: app.env.LINQ_BASE_URL },
});

export default app;
