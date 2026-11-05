import { defineTestApp } from "convex-test";
import { defineSchema, httpActionGeneric, httpRouter } from "convex/server";
import { v } from "convex/values";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Linq } from "../src/client/index.js";
import linqTest from "../src/test.js";

const SECRET = `whsec_${btoa("linq-convex-test-secret-0123456789")}`;
const LINE = "+18885550123";
const USER = "+15551234567";

// --- fake Linq API -----------------------------------------------------------

type Call = { method: string; path: string; body: any; auth: string | null };
let calls: Call[] = [];
let responses: Array<() => Response> = [];

function stubLinq() {
  calls = [];
  responses = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/partner", "");
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? "GET", path, body, auth: new Headers(init.headers).get("authorization") });
    const next = responses.shift();
    if (next) return next();
    const chat = path.match(/^\/v3\/chats\/([^/]+)\/messages$/);
    if (chat) return Response.json({ chat_id: chat[1], message: { id: `out-${++n}` } });
    if (path === "/v3/chats") return Response.json({ chat: { id: "chat-new", message: { id: `out-${++n}` } } });
    return new Response(null, { status: 204 });
  });
}

// --- a small host app --------------------------------------------------------

const app = defineTestApp({
  schema: defineSchema({}),
  components: { linq: linqTest },
});

let linq: Linq;
/** Runs inside a turn's handler before it replies; lets a test act mid-turn. */
let midTurn: ((turn: { turnId: string; messages: { text: string }[] }) => Promise<void>) | undefined;
let turnsSeen: string[] = [];

const { api, internal, createTest } = app.defineModules({
  bot: {
    reply: app.internalAction({
      args: {
        turnId: v.string(),
        chatId: v.string(),
        line: v.optional(v.string()),
        isGroup: v.optional(v.boolean()),
        messages: v.array(v.any()),
      },
      returns: v.null(),
      handler: async (ctx, turn): Promise<null> => {
        turnsSeen.push(turn.turnId);
        if (midTurn) await midTurn(turn);
        const text = turn.messages.map((m: { text: string }) => m.text).join(" / ");
        await linq.sendMessage(ctx, { chatId: turn.chatId, turnId: turn.turnId, text: `echo: ${text}` });
        return null;
      },
    }),
  },
  outbound: {
    send: app.mutation({
      args: { text: v.string(), key: v.optional(v.string()) },
      returns: v.any(),
      handler: async (ctx, args) =>
        linq.sendMessage(ctx, { from: LINE, to: [USER], text: args.text, idempotencyKey: args.key }),
    }),
  },
  http: {
    default: (() => {
      const http = httpRouter();
      // Delegates to the current client, which each test may reconfigure.
      http.route({
        path: "/linq/webhook",
        method: "POST",
        handler: httpActionGeneric((ctx, req) => linq.handleWebhook(ctx, req)),
      });
      return http;
    })(),
  },
} as any) as any;

// --- helpers ------------------------------------------------------------------

function inbound(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    direction: "inbound",
    chat: { id: "chat-1", is_group: false, owner_handle: { id: "h0", handle: LINE, is_me: true } },
    sender_handle: { id: "h1", handle: USER, is_me: false },
    service: "iMessage",
    sent_at: "2026-11-04T19:30:00Z",
    parts: [{ type: "text", value: text }],
    ...extra,
  };
}

async function deliver(
  t: ReturnType<typeof createTest>,
  eventType: string,
  data: unknown,
  eventId = `evt-${crypto.randomUUID()}`,
  secret = SECRET,
) {
  const body = JSON.stringify({ event_id: eventId, event_type: eventType, api_version: "v3", data });
  const ts = new Date();
  return t.fetch("/linq/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign(eventId, ts, body),
    },
    body,
  });
}

async function settle(t: ReturnType<typeof createTest>) {
  // Give each worker's promises time to settle before advancing to its lease.
  for (let i = 0; i < 100; i++) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else {
      await t.finishInProgressScheduledFunctions();
      if (vi.getTimerCount() === 0) return;
    }
  }
  throw new Error("Scheduled work did not settle");
}

beforeEach(() => {
  vi.useFakeTimers();
  stubLinq();
  process.env.LINQ_API_KEY = "test-key";
  midTurn = undefined;
  turnsSeen = [];
  linq = new Linq(app.components.linq as any, {
    onMessage: internal.bot.reply,
    webhookSecret: SECRET,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- tests --------------------------------------------------------------------

describe("webhook", () => {
  test("rejects a forged signature and stores nothing", async () => {
    const t = createTest();
    const res = await deliver(t, "message.received", inbound("m1", "hi"), "evt-1", `whsec_${btoa("some-other-secret-value-xyz")}`);
    expect(res.status).toBe(401);
    expect(await linq.listMessages(t as any, { chatId: "chat-1" })).toEqual([]);
  });

  test("a redelivered event is processed once", async () => {
    const t = createTest();
    expect((await deliver(t, "message.received", inbound("m1", "hi"), "evt-1")).status).toBe(200);
    expect((await deliver(t, "message.received", inbound("m1", "hi"), "evt-1")).status).toBe(200);
    await settle(t);
    expect(await linq.listMessages(t as any, { chatId: "chat-1" })).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
  });

  test("own outbound messages and reconciled history start no turn", async () => {
    const t = createTest();
    await deliver(t, "message.received", { ...inbound("m1", "mine"), direction: "outbound" });
    await deliver(t, "message.received", inbound("m2", "old", { reconciled_at: "2026-11-04T20:00:00Z" }));
    await settle(t);
    const stored = await linq.listMessages(t as any, { chatId: "chat-1" });
    expect(stored.map((m) => [m.messageId, m.status])).toEqual([["m2", "handled"]]);
    expect(calls).toEqual([]);
  });
});

describe("turns and outbox", () => {
  test("replies through the Linq API with the component's key and an idempotency key", async () => {
    const t = createTest();
    await deliver(t, "message.received", inbound("m1", "hello"));
    await settle(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v3/chats/chat-1/messages",
      auth: "Bearer test-key",
      body: { message: { parts: [{ type: "text", value: "echo: hello" }] } },
    });
    expect(calls[0]!.body.message.idempotency_key).toMatch(/^convex-/);
  });

  test("debounce folds a burst into one turn", async () => {
    linq = new Linq(app.components.linq as any, { onMessage: internal.bot.reply, webhookSecret: SECRET, debounceMs: 1000 });
    const t = createTest();
    await deliver(t, "message.received", inbound("m1", "hey"));
    await deliver(t, "message.received", inbound("m2", "you there?"));
    await settle(t);
    expect(calls.map((c) => c.body?.message?.parts?.[0]?.value)).toEqual(["echo: hey / you there?"]);
  });

  test("interrupt drops the stale reply and answers everything in the next turn", async () => {
    linq = new Linq(app.components.linq as any, { onMessage: internal.bot.reply, webhookSecret: SECRET, interrupt: true });
    const t = createTest();
    // While turn 1 is running, a second message arrives.
    midTurn = async (turn) => {
      if (turn.messages.some((m) => m.text === "first") && turnsSeen.length === 1) {
        await deliver(t, "message.received", inbound("m2", "second"));
        expect(await linq.isInterrupted(t as any, { turnId: turn.turnId })).toBe(true);
      }
    };
    await deliver(t, "message.received", inbound("m1", "first"));
    await settle(t);

    expect(turnsSeen).toHaveLength(2);
    // Turn 1's reply was queued after the interrupt, so it was dropped.
    expect(await linq.isInterrupted(t as any, { turnId: turnsSeen[0]! })).toBe(true);
    expect(calls.map((c) => c.body?.message?.parts?.[0]?.value)).toEqual(["echo: first / second"]);
  });

  test("without interrupt, a message that arrives mid-turn waits for the next turn", async () => {
    const t = createTest();
    midTurn = async () => {
      if (turnsSeen.length === 1) await deliver(t, "message.received", inbound("m2", "second"));
    };
    await deliver(t, "message.received", inbound("m1", "first"));
    await settle(t);
    expect(turnsSeen).toHaveLength(2);
    expect(calls.map((c) => c.body?.message?.parts?.[0]?.value)).toEqual(["echo: first", "echo: second"]);
  });

  test("retries transient failures with the same idempotency key, in order", async () => {
    const t = createTest();
    responses.push(() => new Response("busy", { status: 503 }));
    const a = await t.mutation(api.outbound.send, { text: "one" });
    await t.mutation(api.outbound.send, { text: "two" });
    await settle(t);
    expect(calls.map((c) => c.body.message.parts[0].value)).toEqual(["one", "one", "two"]);
    expect(calls[0]!.body.message.idempotency_key).toBe(calls[1]!.body.message.idempotency_key);
    expect(calls[0]!.path).toBe("/v3/chats");
    const status = await linq.getSend(t as any, { id: a.id });
    expect(status).toMatchObject({ status: "sent", attempts: 2, chatId: "chat-new", delivery: "sent" });
  });

  test("a permanent failure is recorded and does not block the chat", async () => {
    const t = createTest();
    responses.push(() => new Response('{"error":"opted out"}', { status: 403 }));
    const a = await t.mutation(api.outbound.send, { text: "one" });
    await t.mutation(api.outbound.send, { text: "two" });
    await settle(t);
    expect(await linq.getSend(t as any, { id: a.id })).toMatchObject({ status: "failed", attempts: 1 });
    expect(calls.map((c) => c.body.message.parts[0].value)).toEqual(["one", "two"]);
  });

  test("the app's idempotency key dedupes its own retries", async () => {
    const t = createTest();
    const a = await t.mutation(api.outbound.send, { text: "once", key: "order-42" });
    const b = await t.mutation(api.outbound.send, { text: "once", key: "order-42" });
    await settle(t);
    expect(b.id).toBe(a.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.message.idempotency_key).toBe("order-42");
  });

  test("delivery webhooks advance status and never go backwards", async () => {
    const t = createTest();
    const a = await t.mutation(api.outbound.send, { text: "hi" });
    await settle(t);
    const { messageId } = (await linq.getSend(t as any, { id: a.id }))!;
    const status = { id: messageId, direction: "outbound", chat: { id: "chat-new" }, parts: [] };
    await deliver(t, "message.read", status);
    await deliver(t, "message.delivered", status);
    expect(await linq.getSend(t as any, { id: a.id })).toMatchObject({ delivery: "read" });
  });

  test("a missing API key fails the send with a clear error", async () => {
    delete process.env.LINQ_API_KEY;
    const t = createTest();
    const a = await t.mutation(api.outbound.send, { text: "hi" });
    await settle(t);
    expect((await linq.getSend(t as any, { id: a.id }))!.error).toMatch(/LINQ_API_KEY/);
    expect(calls).toEqual([]);
  });
});

describe("outbox recovery", () => {
  test("a broken response stream retries instead of leaving the lane stuck", async () => {
    const t = createTest();
    responses.push(() => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection lost while reading response")); },
    }), { status: 200 }));
    const queued = await t.mutation(api.outbound.send, { text: "first" });
    await t.mutation(api.outbound.send, { text: "second" });
    await settle(t);
    expect(await linq.getSend(t as any, { id: queued.id })).toMatchObject({ status: "sent" });
    expect(calls.map(c => c.body.message.parts[0].value)).toEqual(["first", "first", "second"]);
  });
});
