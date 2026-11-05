/**
 * Pure helpers for Linq webhook payloads, shared by the app-side client (which
 * verifies deliveries) and the component (which stores them).
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

/** Events the component acts on; `registerWebhook` subscribes to these by default. */
export const DEFAULT_EVENTS: LinqEventType[] = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "reaction.added",
  "reaction.removed",
];

export const DELIVERY_EVENTS = {
  "message.sent": "sent",
  "message.delivered": "delivered",
  "message.read": "read",
  "message.failed": "failed",
} as const;

export type DeliveryStatus = (typeof DELIVERY_EVENTS)[keyof typeof DELIVERY_EVENTS];

/** Delivery/read evidence supersedes failure; Linq can deliver after failing. */
const DELIVERY_RANK: Record<DeliveryStatus, number> = {
  sent: 0,
  failed: 1,
  delivered: 2,
  read: 3,
};

export function deliveryAdvances(
  current: DeliveryStatus | undefined,
  next: DeliveryStatus,
): boolean {
  return current === undefined || DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

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

/** The fields of an inbound message event the component indexes. */
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
  };
}

/** The Linq message id a delivery-status event refers to. */
export function deliveryMessageId(eventType: string, data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const id = eventType === "message.failed" ? data.message_id : data.id;
  return typeof id === "string" ? id : undefined;
}

export function deliveryError(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const code = typeof data.code === "number" ? data.code : undefined;
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (code === undefined && reason === undefined) return undefined;
  return [code, reason].filter((x) => x !== undefined).join(" ");
}
