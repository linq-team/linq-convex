# @linqapp/convex

A [Convex component](https://docs.convex.dev/components) for [Linq](https://linqapp.com): receive and
send iMessage, RCS and SMS from your Convex backend.

It is **stateless**. It stores no messages, events or metadata, in its own tables or in yours, and
schedules no background jobs. A message exists only inside the call that handles it, the same as with
any webhook consumer. That makes it safe for zero-day-retention lines. See [Data](#data).

- Verifies every webhook's Standard Webhooks signature before your code sees it.
- Calls your handler in the webhook request. If the handler throws, Linq redelivers the event.
- Sends with in-place retries under one idempotency key, so a retry never sends twice.
- Runs in Convex's default runtime; no `"use node"`.

## Install

```sh
npm install @linqapp/convex
```

`convex/convex.config.ts`:

```ts
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

// The component can read only the env vars you bind to it.
app.use(linq, {
  env: { LINQ_API_KEY: app.env.LINQ_API_KEY, LINQ_BASE_URL: app.env.LINQ_BASE_URL },
});

export default app;
```

`convex/linq.ts`:

```ts
import { Linq } from "@linqapp/convex";
import { components, internal } from "./_generated/api.js";

export const linq: Linq = new Linq(components.linq, {
  onMessage: internal.bot.reply,
});
```

`convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { linq } from "./linq.js";

const http = httpRouter();
linq.registerRoutes(http); // POST https://<deployment>.convex.site/linq/webhook
export default http;
```

## Configure

1. **Get an API key and a line.** If you have none yet, the [Linq CLI](https://www.npmjs.com/package/@linqapp/cli)
   gives you a sandbox line:

   ```sh
   npx @linqapp/cli signup --phone +1YOURCELL   # token lands in ~/.linq/config.json
   npx convex env set LINQ_API_KEY <token>
   ```

2. **Subscribe the deployment to Linq webhooks.** Call `linq.registerWebhook` from an action (the
   example app has one in `setup.ts`), then store the secret it returns. Linq shows it only once.

   ```sh
   npx convex run setup:webhook
   npx convex env set LINQ_WEBHOOK_SECRET <signingSecret>
   ```

| Variable              | Read by         | Purpose                                       |
| --------------------- | --------------- | --------------------------------------------- |
| `LINQ_API_KEY`        | the component   | Linq Partner API key                          |
| `LINQ_WEBHOOK_SECRET` | the app's route | Verifies webhook signatures                   |
| `LINQ_BASE_URL`       | the component   | Optional API origin override, e.g. a sandbox  |

## Reply to messages

`onMessage` must be an action. Use `onMessageArgs` for its arguments:

```ts
import { onMessageArgs } from "@linqapp/convex";
import { internalAction } from "./_generated/server.js";
import { linq } from "./linq.js";

export const reply = internalAction({
  args: onMessageArgs, // { eventId, message: { messageId, chatId, from, text, line, ... }, raw }
  handler: async (ctx, { message }) => {
    const answer = await callYourModel(message.text);
    await linq.sendMessage(ctx, {
      chatId: message.chatId,
      text: answer,
      idempotencyKey: `reply:${message.messageId}`,
    });
  },
});
```

`raw` is the full Linq message event, for media, links and replies. Messages from your own line, and
late messages Linq recovered through reconciliation, are not passed to `onMessage` (opt in with
`includeReconciled: true`). Every other event (reactions, delivery status, line health) goes to
`onEvent` if you set it, with `onEventArgs`.

### Handler time limit

Your handler runs inside the webhook request, and Linq waits **10 seconds** for the response. If the
handler throws or runs longer, Linq redelivers the event, retrying for up to 30 minutes, and your
handler runs again.

- **Make replies safe to repeat.** Derive `idempotencyKey` from the message you are answering, as
  above. Linq sends each key at most once, so a redelivery cannot send the reply twice.
- **Slow work** (a long LLM call, tools) that won't fit in 10 seconds has to leave the request. In
  Convex that means `ctx.scheduler.runAfter`, which stores the job's arguments in your deployment.
  Convex keeps scheduled-job records for 7 days after they finish. That is your data on your
  infrastructure, but it is storage, so on zero-day-retention lines (`message.zeroRetention`) pass
  ids rather than message text, or keep the work inside the request.

## Send

```ts
// Into a chat you know
await linq.sendMessage(ctx, { chatId, text: "your order shipped" });

// Let Linq pick the line and reuse the right chat
const { chatId, messageId, from } = await linq.sendMessage(ctx, {
  to: ["+15551234567"],
  text: "hi! following up on your order",
  idempotencyKey: `order-${orderId}-followup`,
});

// Pin a line
await linq.sendMessage(ctx, { from: "+18885550123", to: ["+15551234567"], text: "hi" });

// Full Linq message content: media, links, effects, replies
await linq.sendMessage(ctx, {
  chatId,
  message: { parts: [{ type: "media", url: "https://example.com/receipt.png" }] },
});

await linq.markRead(ctx, { chatId });
await linq.startTyping(ctx, { chatId }); // DMs only
await linq.stopTyping(ctx, { chatId });
```

All of these are action helpers (they make HTTP calls). Network errors, 408, 425, 429 and 5xx are
retried after 0.5 s and 2 s with the same idempotency key, and each attempt has a 10-second deadline.
Other errors, or a failure after the retries, throw.

Delivery status (`message.delivered`, `message.read`, `message.failed`) arrives as webhook events at
`onEvent`. The component doesn't record it; keep it yourself if you need it.

## Data

What this package stores: **nothing.** The component's schema declares no tables, it schedules no
jobs, and it never logs message content.

Where message data goes:

- **Inbound:** Linq's webhook request, verified, then the arguments of your `onMessage` action, in
  memory. On zero-day-retention lines Linq keeps no copy either, so that call is the only time the
  content exists anywhere.
- **Outbound:** the arguments of the component's send action, then Linq's API.
- **Your code:** anything you write to your own tables or pass to `ctx.scheduler` is yours to keep
  or delete. The package never does it for you.

## Testing your app

```ts
import { convexTest } from "convex-test";
import linqTest from "@linqapp/convex/test";

const t = convexTest(schema, modules);
linqTest.register(t); // installs the component as "linq"
```

## Developing this package

```sh
npm install
npm run dev        # local backend + codegen + build on change; example app in example/convex
npm test
npm run typecheck
```

## License

Apache-2.0
