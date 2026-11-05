import { afterEach, expect, test, vi } from "vitest";
import { linqRequest, REQUEST_TIMEOUT_MS } from "../src/component/transport.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("bounds the whole request, including a stalled response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start() {} })));
  const request = linqRequest({ apiKey: "test" }, "POST", "/v3/messages", {});
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  expect(await request).toMatchObject({ ok: false, retryable: true });
});

test("a broken response stream is a retryable failure, not a crash", async () => {
  vi.stubGlobal("fetch", async () =>
    new Response(new ReadableStream({ start(c) { c.error(new Error("connection lost")); } }), { status: 200 }),
  );
  expect(await linqRequest({ apiKey: "test" }, "POST", "/v3/messages", {})).toMatchObject({ ok: false, retryable: true });
});
