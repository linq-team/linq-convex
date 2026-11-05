/**
 * Pure helpers for Linq webhook payloads.
 *
 * The component subscribes with the `2026-02-03` payload version, whose
 * message events carry `direction`, `sender_handle` and a nested `chat`.
 */

import type { LinqAPIV3 } from "@linqapp/sdk";

export type LinqWebhookEvent = LinqAPIV3.UnwrapWebhookEvent;
export type LinqMessageEvent = LinqAPIV3.MessageEventV2;
export type LinqEventType = LinqAPIV3.WebhookEventType;

/** Payload version the component's message parsing expects. */
export const WEBHOOK_PAYLOAD_VERSION = "2026-02-03";

/** Events `registerWebhook` subscribes to by default. */
export const DEFAULT_EVENTS: LinqEventType[] = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "reaction.added",
  "reaction.removed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Joined text of a message's text parts. Media and links are not text. */
export function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { type: "text"; value: string } =>
        isRecord(p) && p.type === "text" && typeof p.value === "string",
    )
    .map((p) => p.value)
    .join("\n");
}

/** An inbound message, as `onMessage` receives it. */
export interface InboundMessage {
  messageId: string;
  chatId: string;
  isGroup?: boolean;
  line?: string;
  from: string;
  text: string;
  service?: string;
  sentAt?: string;
  reconciledAt?: string;
  /**
   * True on a zero-day-retention line. Linq keeps no copy of this message,
   * and neither does this package; this call is the only time you see it.
   */
  zeroRetention: boolean;
}

/**
 * Normalize a `message.received` payload. Returns `null` for anything that is
 * not a message someone else sent to this line, including payloads in the
 * older format, which carry no `direction`.
 */
export function parseInboundMessage(data: unknown): InboundMessage | null {
  if (!isRecord(data) || data.direction !== "inbound") return null;
  const chat = data.chat;
  const sender = data.sender_handle;
  if (typeof data.id !== "string" || !isRecord(chat) || typeof chat.id !== "string") {
    return null;
  }
  if (!isRecord(sender) || sender.is_me === true || typeof sender.handle !== "string") {
    return null;
  }
  const owner = isRecord(chat.owner_handle) ? chat.owner_handle : undefined;
  return {
    messageId: data.id,
    chatId: chat.id,
    isGroup: typeof chat.is_group === "boolean" ? chat.is_group : undefined,
    line: typeof owner?.handle === "string" ? owner.handle : undefined,
    from: sender.handle,
    text: textOf(data.parts),
    service: typeof data.service === "string" ? data.service : undefined,
    sentAt: typeof data.sent_at === "string" ? data.sent_at : undefined,
    reconciledAt: typeof data.reconciled_at === "string" ? data.reconciled_at : undefined,
    zeroRetention: data.zero_retention === true,
  };
}
