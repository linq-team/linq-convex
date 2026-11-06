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

test("failed responses and network exceptions do not expose content", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: { code: 1003, message: "PRIVATE BODY test-key person@example.com" } }, { status: 400 }));
  expect(await linqRequest({ apiKey: "test-key" }, "POST", "/v3/messages", {})).toEqual({
    ok: false, retryable: false, status: 400, error: "HTTP 400 (code 1003)", retryAfterMs: undefined,
  });
  vi.stubGlobal("fetch", async () => { throw new Error("PRIVATE BODY test-key"); });
  const failure = await linqRequest({ apiKey: "test-key" }, "POST", "/v3/messages", {});
  expect(failure).toMatchObject({ ok: false, retryable: true });
  expect(JSON.stringify(failure)).not.toMatch(/PRIVATE|test-key/);
});

test.each([[2009, true], [2015, false]])("classifies HTTP 409 code %i", async (code, retryable) => {
  vi.stubGlobal("fetch", async () => Response.json({ error: { code } }, { status: 409 }));
  expect(await linqRequest({ apiKey: "test" }, "POST", "/v3/messages", {})).toMatchObject({ ok: false, retryable });
});
