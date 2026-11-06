import { defineTestApp } from "convex-test";
import { defineSchema, httpActionGeneric, httpRouter } from "convex/server";
import { v } from "convex/values";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Linq, onEventArgs, onMessageArgs } from "../src/client/index.js";
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
    if (path === "/v3/messages") return Response.json({ chat_id: "chat-auto", from: LINE, message: { id: `out-${++n}` } });
    return new Response(null, { status: 204 });
  });
}

// --- a small host app --------------------------------------------------------

const app = defineTestApp({
  schema: defineSchema({}),
  components: { linq: linqTest },
});

let linq: Linq;
let seen: Array<{ eventId: string; message: any }> = [];
let events: any[] = [];
let failHandler = false;

const { api, internal, createTest } = app.defineModules({
  bot: {
    reply: app.internalAction({
      args: onMessageArgs,
      returns: v.null(),
      handler: async (ctx, args): Promise<null> => {
        seen.push({ eventId: args.eventId, message: args.message });
        if (failHandler) throw new Error("model timed out");
        await linq.sendMessage(ctx, {
          chatId: args.message.chatId,
          text: `echo: ${args.message.text}`,
          idempotencyKey: `reply:${args.message.messageId}`,
        });
        return null;
      },
    }),
    event: app.internalAction({
      args: onEventArgs,
      returns: v.null(),
      handler: async (_ctx, args): Promise<null> => {
        events.push(args.event);
        return null;
      },
    }),
  },
  outbound: {
    send: app.action({
      args: { text: v.string(), from: v.optional(v.string()), chatId: v.optional(v.string()) },
      returns: v.any(),
      handler: async (ctx, args): Promise<any> =>
        args.chatId
          ? linq.sendMessage(ctx, { chatId: args.chatId, text: args.text })
          : linq.sendMessage(ctx, { from: args.from, to: [USER], text: args.text }),
    }),
    subscribe: app.action({
      args: {},
      returns: v.any(),
      handler: async (ctx): Promise<any> =>
        linq.registerWebhook(ctx, { siteUrl: "https://example.convex.site" }),
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

beforeEach(() => {
  stubLinq();
  process.env.LINQ_API_KEY = "test-key";
  seen = [];
  events = [];
  failHandler = false;
  linq = new Linq(app.components.linq as any, {
    onMessage: internal.bot.reply,
    onEvent: internal.bot.event,
    webhookSecret: SECRET,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- tests --------------------------------------------------------------------

test("does not retry before a long Retry-After interval", async () => {
  const t = createTest();
  responses.push(() => new Response("private body", { status: 429, headers: { "Retry-After": "60" } }));
  await expect(t.action(api.outbound.send, { text: "hello" })).rejects.toThrow("retry after 60 seconds");
  expect(calls).toHaveLength(1);
});

test("a permanent failure with Retry-After does not advise retrying", async () => {
  const t = createTest();
  responses.push(() => new Response("private body", { status: 403, headers: { "Retry-After": "60" } }));
  let failure: unknown;
  try {
    await t.action(api.outbound.send, { text: "hello" });
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("403");
  expect(String(failure)).not.toContain("retry after");
  expect(calls).toHaveLength(1);
});

test.each([null, {}, { id: 1, signing_secret: SECRET }, { id: "sub-1", signing_secret: [] },
  { id: "sub-1", signing_secret: "whsec_PRIVATE_INVALID!" }])(
  "invalid subscription response fails safely before Convex return validation: %j", async (body) => {
    const t = createTest();
    responses.push(() => Response.json(body));
    let failure: unknown;
    try {
      await t.action(api.outbound.subscribe, {});
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("invalid webhook subscription response");
    expect(String(failure)).not.toContain(SECRET);
    expect(String(failure)).not.toContain("PRIVATE_INVALID");
    expect(calls).toHaveLength(1);
  },
);

test("a valid subscription returns its credentials", async () => {
  const t = createTest();
  responses.push(() => Response.json({ id: "sub-1", signing_secret: SECRET }));
  await expect(t.action(api.outbound.subscribe, {})).resolves.toMatchObject({
    subscriptionId: "sub-1", signingSecret: SECRET,
  });
});

test("retries a provisioning conflict without changing the send key", async () => {
  const t = createTest();
  responses.push(() => Response.json({ error: { code: 2009 } }, { status: 409 }));
  await t.action(api.outbound.send, { text: "hello" });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).toEqual(calls[1]!.body);
});

test.each(["", "<html>private content</html>", "{}"])("retries an indeterminate send response without changing the key: %s", async (body) => {
  const t = createTest();
  responses.push(() => new Response(body, { status: 200 }));
  await expect(t.action(api.outbound.send, { text: "hello" })).resolves.toMatchObject({ messageId: expect.any(String) });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).toEqual(calls[1]!.body);
});

test("never acknowledges a send when all successful responses are malformed", async () => {
  const t = createTest();
  responses.push(...Array.from({ length: 3 }, () => () => Response.json({})));
  await expect(t.action(api.outbound.send, { text: "hello" })).rejects.toThrow("same idempotency key");
  expect(calls).toHaveLength(3);
  expect(calls[0]!.body).toEqual(calls[2]!.body);
});

describe("webhook", () => {
  test.each(["whsec_", "whsec_INVALID!SECRET"])("invalid local signing secret returns a safe retriable error: %s", async (secret) => {
    linq = new Linq(app.components.linq as any, { onMessage: internal.bot.reply, webhookSecret: secret });
    const res = await deliver(createTest(), "message.received", inbound("m1", "hi"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("LINQ_WEBHOOK_SECRET is invalid");
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejects a forged signature and runs nothing", async () => {
    const t = createTest();
    const res = await deliver(t, "message.received", inbound("m1", "hi"), "evt-1", `whsec_${btoa("some-other-secret-value-xyz")}`);
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("runs the handler inline and replies before answering 200", async () => {
    const t = createTest();
    const res = await deliver(t, "message.received", inbound("m1", "hello"), "evt-1");
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        eventId: "evt-1",
        message: expect.objectContaining({ messageId: "m1", chatId: "chat-1", from: USER, line: LINE, text: "hello", zeroRetention: false }),
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v3/chats/chat-1/messages",
      auth: "Bearer test-key",
      body: { message: { parts: [{ type: "text", value: "echo: hello" }], idempotency_key: "reply:m1" } },
    });
  });

  test("a handler failure answers 500 so Linq redelivers", async () => {
    failHandler = true;
    const t = createTest();
    const res = await deliver(t, "message.received", inbound("m1", "hello"));
    expect(res.status).toBe(500);
    // The error text is not echoed: it could contain message content.
    expect(await res.text()).toBe("handler failed");
  });

  test("a redelivery replies with the same idempotency key, so Linq sends once", async () => {
    const t = createTest();
    await deliver(t, "message.received", inbound("m1", "hi"), "evt-1");
    await deliver(t, "message.received", inbound("m1", "hi"), "evt-1");
    expect(calls.map((c) => c.body.message.idempotency_key)).toEqual(["reply:m1", "reply:m1"]);
  });

  test("own outbound messages and reconciled history do not reach onMessage", async () => {
    const t = createTest();
    await deliver(t, "message.received", { ...inbound("m1", "mine"), direction: "outbound" });
    await deliver(t, "message.received", inbound("m2", "old", { reconciled_at: "2026-11-04T20:00:00Z" }));
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("includeReconciled opts in to late messages", async () => {
    linq = new Linq(app.components.linq as any, { onMessage: internal.bot.reply, webhookSecret: SECRET, includeReconciled: true });
    const t = createTest();
    await deliver(t, "message.received", inbound("m2", "old", { reconciled_at: "2026-11-04T20:00:00Z" }));
    expect(seen.map((s) => s.message.reconciledAt)).toEqual(["2026-11-04T20:00:00Z"]);
  });

  test("passes the zero-retention flag through", async () => {
    const t = createTest();
    await deliver(t, "message.received", inbound("m1", "private", { zero_retention: true }));
    expect(seen[0]!.message.zeroRetention).toBe(true);
  });

  test("other events go to onEvent", async () => {
    const t = createTest();
    await deliver(t, "message.delivered", { id: "out-9", direction: "outbound", chat: { id: "chat-1" }, parts: [] });
    await deliver(t, "reaction.added", { message_id: "m1", reaction: "love" });
    expect(events.map((e) => e.event_type)).toEqual(["message.delivered", "reaction.added"]);
  });
});

describe("stores nothing", () => {
  test("a full inbound + reply leaves no rows and no scheduled jobs", async () => {
    const t = createTest();
    await deliver(t, "message.received", inbound("m1", "secret text"));
    await deliver(t, "message.delivered", { id: "out-1", direction: "outbound", chat: { id: "chat-1" }, parts: [] });
    const jobs = await t.run(async (ctx: any) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toEqual([]);
    // The component's schema declares no tables, so it has nowhere to write.
    expect(Object.keys(linqTest.schema.tables)).toEqual([]);
  });
});

describe("sending", () => {
  test.each([".", "..", "../messages", "%2e%2e", "a/b", "a?b", "a#b", ""])(
    "unsafe chat id never reaches the network: %s", async (chatId) => {
      const t = createTest();
      await expect(t.action(async (ctx: any) => linq.sendMessage(ctx, { chatId, text: "hello" })))
        .rejects.toThrow("chatId is not a valid Linq identifier");
      await expect(t.action(async (ctx: any) => linq.markRead(ctx, { chatId })))
        .rejects.toThrow("chatId is not a valid Linq identifier");
      expect(calls).toEqual([]);
    },
  );

  test("retries a transient failure in place with one idempotency key", async () => {
    const t = createTest();
    responses.push(() => new Response("busy", { status: 503 }));
    const sent = await t.action(api.outbound.send, { chatId: "chat-1", text: "one" });
    expect(sent).toMatchObject({ chatId: "chat-1", messageId: "out-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.message.idempotency_key).toBe(calls[1]!.body.message.idempotency_key);
  });

  test("a permanent failure throws without retrying", async () => {
    const t = createTest();
    responses.push(() => new Response('{"error":"opted out"}', { status: 403 }));
    await expect(t.action(api.outbound.send, { chatId: "chat-1", text: "one" })).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });

  test("a pinned line uses POST /v3/chats", async () => {
    const t = createTest();
    const sent = await t.action(api.outbound.send, { from: LINE, text: "hi" });
    expect(calls[0]).toMatchObject({ path: "/v3/chats", body: { from: LINE, to: [USER] } });
    expect(sent).toMatchObject({ chatId: "chat-new", messageId: "out-1" });
  });

  test("no line lets Linq pick one via POST /v3/messages", async () => {
    const t = createTest();
    const sent = await t.action(api.outbound.send, { text: "hi" });
    expect(calls[0]).toMatchObject({ path: "/v3/messages", body: { to: [USER] } });
    expect(calls[0]!.body.from).toBeUndefined();
    expect(sent).toEqual({ chatId: "chat-auto", from: LINE, messageId: "out-1" });
  });

  test("typing, stop typing and read", async () => {
    const t = createTest();
    await t.action(async (ctx: any) => {
      await linq.startTyping(ctx, { chatId: "chat-1" });
      await linq.stopTyping(ctx, { chatId: "chat-1" });
      await linq.markRead(ctx, { chatId: "chat-1" });
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v3/chats/chat-1/typing",
      "DELETE /v3/chats/chat-1/typing",
      "POST /v3/chats/chat-1/read",
    ]);
  });

  test("a missing API key fails with a clear error", async () => {
    delete process.env.LINQ_API_KEY;
    const t = createTest();
    await expect(t.action(api.outbound.send, { chatId: "chat-1", text: "hi" })).rejects.toThrow(/LINQ_API_KEY/);
    expect(calls).toEqual([]);
  });
});
