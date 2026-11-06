/**
 * Calls to the Linq Partner API. Nothing is stored: each call is one request,
 * retried in place on transient failures with the same idempotency key.
 */

import { v } from "convex/values";
import { action, env } from "./_generated/server.js";
import {
  linqRequest,
  MAX_RETRY_AFTER_MS,
  RETRY_DELAYS_MS,
  type CallResult,
} from "./transport.js";

function credentials() {
  const apiKey = env.LINQ_API_KEY;
  if (!apiKey) {
    throw new Error("LINQ_API_KEY is not set for the linq component (see README: Configure)");
  }
  return { apiKey, baseUrl: env.LINQ_BASE_URL };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request with in-place retries. Throws the last error if it never succeeds. */
async function withRetries(attempt: () => Promise<CallResult>): Promise<unknown> {
  for (let i = 0; ; i++) {
    const result = await attempt();
    if (result.ok) return result.body;
    if (!result.retryable) throw new Error(`linq: ${result.error}`);
    if ((result.retryAfterMs ?? 0) > MAX_RETRY_AFTER_MS) {
      throw new Error(`linq: ${result.error}; retry after ${Math.ceil(result.retryAfterMs! / 1000)} seconds with the same idempotency key`);
    }
    const delay = RETRY_DELAYS_MS[i];
    if (delay === undefined) {
      throw new Error(`linq: ${result.error}`);
    }
    await sleep(Math.max(delay, result.retryAfterMs ?? 0));
  }
}

/** Keep ids in one URL segment, including against URL dot-segment normalization. */
function chatPathId(chatId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
    throw new Error("linq: chatId is not a valid Linq identifier");
  }
  return encodeURIComponent(chatId);
}

/** Linq's ids from a send response (any of the three send endpoints). */
function sentIds(body: unknown, existingChatId?: string) {
  const b = body as {
    chat_id?: string;
    from?: string;
    message?: { id?: string };
    chat?: { id?: string; message?: { id?: string } };
  } | null;
  return {
    chatId: b?.chat_id ?? b?.chat?.id ?? existingChatId,
    messageId: b?.message?.id ?? b?.chat?.message?.id,
    from: b?.from,
  };
}

export const sendMessage = action({
  args: {
    chatId: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.array(v.string())),
    message: v.any(),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    chatId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    from: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const chatId = args.chatId === undefined ? undefined : chatPathId(args.chatId);
    if (!args.chatId && !args.to?.length) {
      throw new Error("linq: sendMessage needs a chatId or at least one recipient in to");
    }
    const creds = credentials();
    const message = { ...(args.message as Record<string, unknown>), idempotency_key: args.idempotencyKey };
    const body = await withRetries(async () => {
      const result = await (args.chatId
        ? linqRequest(creds, "POST", `/v3/chats/${chatId}/messages`, { message })
        : args.from
          ? linqRequest(creds, "POST", "/v3/chats", { from: args.from, to: args.to, message })
          : linqRequest(creds, "POST", "/v3/messages", { to: args.to, message }));
      if (result.ok) {
        const ids = sentIds(result.body, args.chatId);
        if (typeof ids.chatId !== "string" || !ids.chatId || typeof ids.messageId !== "string" || !ids.messageId) {
          return { ok: false, retryable: true, error: "send response was invalid; retry with the same idempotency key" };
        }
      }
      return result;
    });
    return sentIds(body, args.chatId);
  },
});

export const chatAction = action({
  args: {
    chatId: v.string(),
    kind: v.union(v.literal("typing"), v.literal("stopTyping"), v.literal("read")),
  },
  returns: v.null(),
  handler: async (_ctx, { chatId, kind }) => {
    const id = chatPathId(chatId);
    const creds = credentials();
    const path = `/v3/chats/${id}/${kind === "read" ? "read" : "typing"}`;
    await withRetries(() => linqRequest(creds, kind === "stopTyping" ? "DELETE" : "POST", path));
    return null;
  },
});
