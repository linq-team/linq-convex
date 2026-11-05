/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import type { FunctionReturnType } from "convex/server";
import schema from "./schema.js";
import { api } from "./_generated/api.js";
const modules = import.meta.glob("./**/*.ts");

test("paginates inbound history beyond the snapshot limit without crossing chats", async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let i = 0; i < 505; i++) await ctx.db.insert("messages", {
      chatId: "chat-1", messageId: `message-${i}`, from: "+15555550100", text: String(i), raw: {}, status: "handled",
    });
    await ctx.db.insert("messages", { chatId: "other", messageId: "other", from: "+15555550101", text: "other", raw: {}, status: "handled" });
  });
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: FunctionReturnType<typeof api.inbound.paginateMessages> = await t.query(api.inbound.paginateMessages, { chatId: "chat-1", paginationOpts: { cursor, numItems: 200 } });
    ids.push(...result.page.map(row => row.messageId));
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(ids).toEqual(Array.from({ length: 505 }, (_, i) => `message-${504 - i}`));
  expect((await t.query(api.inbound.listMessages, { chatId: "chat-1", limit: 3 })).map(m => m.messageId))
    .toEqual(["message-502", "message-503", "message-504"]);
});

test("paginates outbound sends without changing the existing snapshot API", async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let i = 0; i < 505; i++) await ctx.db.insert("outbox", {
      kind: "message", lane: "chat:chat-1", chatId: "chat-1", status: "sent", attempts: 1, queuedAt: i, messageId: `sent-${i}`,
    });
    await ctx.db.insert("outbox", { kind: "message", lane: "other", chatId: "other", status: "sent", attempts: 1, queuedAt: 0 });
  });
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: FunctionReturnType<typeof api.outbox.paginate> = await t.query(api.outbox.paginate, { chatId: "chat-1", paginationOpts: { cursor, numItems: 200 } });
    ids.push(...result.page.map(row => row.messageId!));
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(ids).toEqual(Array.from({ length: 505 }, (_, i) => `sent-${504 - i}`));
  expect((await t.query(api.outbox.list, { chatId: "chat-1", limit: 3 })).map(m => m.messageId))
    .toEqual(["sent-502", "sent-503", "sent-504"]);
});
