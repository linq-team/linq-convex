# @linqapp/convex

A [Convex component](https://docs.convex.dev/components) for [Linq](https://linqapp.com). Your Convex
backend can receive and send iMessage, RCS and SMS without running a server or a queue, and without
writing retry code.

- **Durable webhooks.** Each delivery's Standard Webhooks signature is verified, and the event is
  stored before Linq gets its `200`. Redeliveries are deduped by event id.
- **Turns.** Your handler runs once per turn with every message the chat queued. A chat runs one
  turn at a time, so a bot never talks over itself. Optionally, a burst of texts is folded into one
  turn (`debounceMs`), or a newer message interrupts a stale reply (`interrupt`).
- **Transactional outbox.** `sendMessage` is a mutation, so a reply commits together with your own
  writes. Sends go out in order per chat. Timeouts, 429s and 5xx are retried with backoff, and every
  attempt carries the same idempotency key, so a retry never sends twice.
- **Delivery status.** `sent → delivered → read`, or `failed` with Linq's error, read reactively
  from a query.
- **Default runtime.** No `"use node"` and no extra services.

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
   gives you a sandbox line in a minute:

   ```sh
   npx @linqapp/cli signup --phone +1YOURCELL   # token lands in ~/.linq/config.json
   npx convex env set LINQ_API_KEY <token>
   ```

2. **Subscribe the deployment to Linq webhooks.** Add an action that calls `linq.registerWebhook`
   (the example app has one in `setup.ts`), run it, then store the secret it prints. Linq shows the
   secret only once.

   ```sh
   npx convex run setup:webhook
   npx convex env set LINQ_WEBHOOK_SECRET <signingSecret>
   ```

   `registerWebhook` subscribes to the events the component handles, using the `2026-02-03`
   payload version the component parses. To use only some lines, pass `phoneNumbers`.

| Variable              | Read by         | Purpose                                                     |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `LINQ_API_KEY`        | the component   | Linq Partner API key. Never stored in a table.              |
| `LINQ_WEBHOOK_SECRET` | the app's route | Verifies webhook signatures.                                |
| `LINQ_BASE_URL`       | the component   | Optional API origin override, e.g. a sandbox.               |

## Reply to messages

`onMessage` must be an action. It receives a `Turn`:

```ts
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { linq } from "./linq.js";

export const reply = internalAction({
  args: {
    turnId: v.string(),
    chatId: v.string(),
    line: v.optional(v.string()),
    isGroup: v.optional(v.boolean()),
    messages: v.array(v.any()), // TurnMessage[]: { messageId, from, text, service, sentAt, raw }
  },
  handler: async (ctx, turn) => {
    const prompt = turn.messages.map((m) => m.text).join("\n");
    const answer = await callYourModel(prompt);
    await ctx.runMutation(internal.bot.send, { chatId: turn.chatId, turnId: turn.turnId, text: answer });
  },
});

export const send = internalMutation({
  args: { chatId: v.string(), turnId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    await linq.sendMessage(ctx, args);
  },
});
```

When the handler returns, its turn is closed. If it throws, the turn is marked failed and the next
message still starts a new one. Late messages that Linq recovered through reconciliation are stored
but never start a turn, so a bot doesn't answer stale history.

### Bursts and interruptions

```ts
new Linq(components.linq, {
  onMessage: internal.bot.reply,
  debounceMs: 1500, // wait for the burst to finish before starting a turn
  interrupt: true,  // a newer message cancels this turn's unsent replies
});
```

With `interrupt`, a message that arrives mid-turn marks the running turn interrupted. Replies the
turn queues after that point are dropped. If the turn had not replied yet, its messages join the next
turn, so nothing goes unanswered. A running action cannot be stopped from outside, so check
`linq.isInterrupted(ctx, { turnId })` before doing slow work.

## Send

```ts
// Into a chat you know
await linq.sendMessage(ctx, { chatId, text: "your order shipped" });

// Start a conversation (or reuse the existing chat with these recipients)
const { id } = await linq.sendMessage(ctx, {
  from: "+18885550123",
  to: ["+15551234567"],
  text: "hi! following up on your order",
  idempotencyKey: `order-${orderId}-followup`, // dedupes your own retries
});

// Full Linq message content: media, links, effects, replies
await linq.sendMessage(ctx, {
  chatId,
  message: { parts: [{ type: "media", url: "https://example.com/receipt.png" }] },
});

await linq.markRead(ctx, { chatId });
await linq.startTyping(ctx, { chatId }); // DMs only
```

Each call returns `{ id, status }`. Read progress reactively:

```ts
export const sendStatus = query({
  args: { id: v.string() },
  handler: (ctx, { id }) => linq.getSend(ctx, { id }),
  // → { status: "sent", delivery: "read", attempts: 1, messageId, chatId, error? }
});
```

`status` tracks the API call (`queued`, `sending`, `sent`, `failed`, `cancelled`). `delivery` tracks
what Linq reported afterwards (`sent`, `delivered`, `read`, `failed`) and never moves backwards.

Transient failures (network errors, 408, 425, 429 and 5xx) are retried after 2 s, 10 s, 30 s, 2 min
and 10 min, honoring `Retry-After`. Other 4xx responses fail the send immediately, and the error is
recorded. Either way the chat's next send proceeds.

## Other events

Pass `onEvent` to receive every verified webhook event, including reactions, polls, line health and
the delivery statuses the component also records:

```ts
new Linq(components.linq, { onMessage: internal.bot.reply, onEvent: internal.bot.event });
```

## Reading data

| Method                                     | Returns                                       |
| ------------------------------------------ | --------------------------------------------- |
| `linq.listMessages(ctx, { chatId, limit })` | Inbound messages, oldest first                |
| `linq.listSends(ctx, { chatId, limit })`    | Outbound sends with status and delivery       |
| `linq.getSend(ctx, { id })`                 | One send                                      |
| `linq.getChat(ctx, { chatId })`             | Line, group flag, last inbound time           |
| `linq.listLines(ctx)`                       | Lines this API key can send from (action)     |

The component's tables (`events`, `chats`, `messages`, `turns`, `outbox`) are visible under the
component dropdown in the Convex dashboard.

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
npm test           # convex-test suite, edge runtime
npm run typecheck
```

`npm run build:codegen` regenerates `src/component/_generated` and builds `dist`. Run it before
`convex dev` when you change the component's API.

## License

Apache-2.0
