/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { linqRequest, REQUEST_TIMEOUT_MS } from "./transport.js";
import { interruptRunningTurn } from "./turns.js";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("bounds the entire request, including a stalled response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start() {} })));
  const request = linqRequest({ apiKey: "test" }, "POST", "/v3/messages", {});
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  expect(await request).toMatchObject({ ok: false, retryable: true });
});

test("recovers a lost worker and fences its late result", async () => {
  vi.useFakeTimers();
  process.env.LINQ_API_KEY = "test-key";
  const fetch = vi.fn().mockResolvedValue(Response.json({ chat_id: "chat-1", message: { id: "out-1" } }));
  vi.stubGlobal("fetch", fetch);
  const t = convexTest(schema, modules);
  const queued = await t.mutation(api.outbox.enqueue, { kind: "message", chatId: "chat-1",
    message: { parts: [{ type: "text", value: "hello" }] } });
  const id = queued.id as Id<"outbox">;
  await t.run(async ctx => {
    const row = (await ctx.db.get("outbox", id))!;
    // Simulate termination before the worker starts; leave the recovery job.
    await ctx.scheduler.cancel(row.job!);
  });
  for (let i = 0; i < 20 && vi.getTimerCount(); i++) await vi.advanceTimersToNextTimerAsync();
  await t.finishInProgressScheduledFunctions();
  expect(await t.query(api.outbox.get, { id })).toMatchObject({ status: "sent", attempts: 2, messageId: "out-1" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const key = JSON.parse(fetch.mock.calls[0]![1].body).message.idempotency_key;
  expect(key).toBe(`convex-${id}`);
  await t.mutation(internal.outbox.settle, { id, generation: 1, outcome: "failed", error: "late worker" });
  expect(await t.query(api.outbox.get, { id })).toMatchObject({ status: "sent", messageId: "out-1" });
});

test("an interruption preserves an already-dispatched send", async () => {
  vi.useFakeTimers();
  process.env.LINQ_API_KEY = "test-key";
  const fetch = vi.fn().mockResolvedValue(Response.json({ chat_id: "chat-1", message: { id: "out-1" } }));
  vi.stubGlobal("fetch", fetch);
  const t = convexTest(schema, modules);
  const turnId = await t.run(ctx => ctx.db.insert("turns", { chatId: "chat-1", status: "running", startedAt: Date.now() }));
  const queued = await t.mutation(api.outbox.enqueue, { kind: "message", chatId: "chat-1", turnId,
    message: { parts: [{ type: "text", value: "hello" }] } });
  const id = queued.id as Id<"outbox">;
  await t.mutation(internal.outbox.claim, { id, generation: 1 });
  await t.run(ctx => interruptRunningTurn(ctx, "chat-1"));
  for (let i = 0; i < 20 && vi.getTimerCount(); i++) await vi.advanceTimersToNextTimerAsync();
  await t.finishInProgressScheduledFunctions();
  expect(await t.query(api.outbox.get, { id })).toMatchObject({ status: "sent" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
