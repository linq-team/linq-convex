import {
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
  httpActionGeneric,
} from "convex/server";
import { v } from "convex/values";
import type { LinqAPIV3 } from "@linqapp/sdk";
import { Webhook } from "standardwebhooks";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  DEFAULT_EVENTS,
  parseInboundMessage,
  WEBHOOK_PAYLOAD_VERSION,
  type InboundMessage,
  type LinqEventType,
  type LinqWebhookEvent,
} from "../shared/events.js";

export type { InboundMessage, LinqEventType, LinqWebhookEvent } from "../shared/events.js";
export { DEFAULT_EVENTS, WEBHOOK_PAYLOAD_VERSION } from "../shared/events.js";
export type { ComponentApi } from "../component/_generated/component.js";

/** Linq `MessageContent`: text, media and link parts, effects, replies. */
export type MessageContent = Omit<LinqAPIV3.MessageContent, "idempotency_key">;

/**
 * Validators for an `onMessage` handler's arguments:
 *
 * ```ts
 * export const reply = internalAction({ args: onMessageArgs, handler: ... });
 * ```
 */
export const onMessageArgs = {
  /** Linq's event id. A redelivery of the same event carries the same id. */
  eventId: v.string(),
  message: v.object({
    messageId: v.string(),
    chatId: v.string(),
    isGroup: v.optional(v.boolean()),
    line: v.optional(v.string()),
    from: v.string(),
    text: v.string(),
    service: v.optional(v.string()),
    sentAt: v.optional(v.string()),
    reconciledAt: v.optional(v.string()),
    zeroRetention: v.boolean(),
  }),
  /** The full Linq message event, for media, links and replies. */
  raw: v.any(),
};

/** Validators for an `onEvent` handler's arguments. */
export const onEventArgs = { eventId: v.string(), event: v.any() };

export interface LinqOptions {
  /**
   * Called with each inbound message, inside the webhook request. Must be an
   * action. Linq waits 10 seconds for the webhook response, so finish within
   * that, or Linq redelivers the event (see README: Handler time limit).
   */
  onMessage?: FunctionReference<"action", "internal" | "public">;
  /** Called with every other verified event (reactions, delivery status...). */
  onEvent?: FunctionReference<"action", "internal" | "public">;
  /**
   * Also call `onMessage` for messages Linq recovered late (reconciliation).
   * Off by default, so a bot doesn't answer stale history.
   * @default false
   */
  includeReconciled?: boolean;
  /** @default "/linq/webhook" */
  webhookPath?: string;
  /** Falls back to `process.env.LINQ_WEBHOOK_SECRET`. */
  webhookSecret?: string;
}

type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

/** Where a message goes: a known chat, or recipients with an optional fixed line. */
export type Destination =
  | { chatId: string; from?: never; to?: never }
  | {
      chatId?: never;
      /** Pin a Linq line, or omit to let Linq pick one and reuse the right chat. */
      from?: string;
      /** Recipient handles; more than one starts a group chat. */
      to: string[];
    };

export type SendMessageArgs = Destination & {
  /** Shorthand for a single text part. */
  text?: string;
  /** Full Linq message content; takes precedence over `text`. */
  message?: MessageContent;
  /**
   * Makes the send safe to repeat: Linq sends a key at most once. Derive it
   * from what you are replying to (e.g. `reply:${message.messageId}`), so a
   * redelivered webhook can't send the reply twice. Defaults to a random key,
   * which only covers this call's own retries.
   */
  idempotencyKey?: string;
};

const DEFAULT_WEBHOOK_PATH = "/linq/webhook";

/**
 * App-side client for the Linq component. Stateless: it stores nothing, in the
 * component or in your app. Messages exist only in the calls that handle them.
 */
export class Linq {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: LinqOptions = {},
  ) {}

  get webhookPath(): string {
    return this.options.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  }

  /** Mount the webhook endpoint in `convex/http.ts`. */
  registerRoutes(http: HttpRouter): void {
    http.route({
      path: this.webhookPath,
      method: "POST",
      handler: httpActionGeneric((ctx, request) => this.handleWebhook(ctx, request)),
    });
  }

  /**
   * Verify a webhook delivery and run your handler on it, in this request.
   *
   * - Bad or missing signature: 401, nothing runs.
   * - Handler succeeds: 200.
   * - Handler throws: 500, so Linq redelivers the event (for up to 30 min).
   *
   * For apps that route the webhook themselves; `registerRoutes` uses it.
   */
  async handleWebhook(ctx: ActionCtx, request: Request): Promise<Response> {
    const secret = this.options.webhookSecret ?? process.env.LINQ_WEBHOOK_SECRET;
    if (!secret) return new Response("LINQ_WEBHOOK_SECRET is not set", { status: 500 });

    const body = await request.text();
    const headers = Object.fromEntries(request.headers);
    let event: LinqWebhookEvent;
    try {
      event = new Webhook(secret).verify(body, headers) as LinqWebhookEvent;
    } catch {
      return new Response("invalid signature", { status: 401 });
    }
    const eventId = headers["webhook-id"] ?? event.event_id;
    if (!eventId) return new Response("missing event id", { status: 400 });

    try {
      const message = event.event_type === "message.received" ? parseInboundMessage(event.data) : null;
      if (message) {
        const wanted = this.options.includeReconciled || message.reconciledAt === undefined;
        if (this.options.onMessage && wanted) {
          await ctx.runAction(this.options.onMessage, { eventId, message, raw: event.data });
        }
      } else if (this.options.onEvent) {
        await ctx.runAction(this.options.onEvent, { eventId, event });
      }
    } catch (e) {
      // Never echo the error: it may contain message content.
      console.error(`linq: handler failed for event ${eventId}; Linq will redeliver`);
      return new Response("handler failed", { status: 500 });
    }
    return new Response(null, { status: 200 });
  }

  /**
   * Send a message and return Linq's ids. Retries transient failures in place
   * with one idempotency key; throws if the send fails.
   */
  async sendMessage(ctx: ActionCtx, args: SendMessageArgs) {
    const message: MessageContent | undefined =
      args.message ?? (args.text !== undefined ? { parts: [{ type: "text", value: args.text }] } : undefined);
    if (!message) throw new Error("linq: sendMessage needs text or a message");
    return await ctx.runAction(this.component.api.sendMessage, {
      chatId: args.chatId,
      from: args.from,
      to: args.to,
      message,
      idempotencyKey: args.idempotencyKey ?? crypto.randomUUID(),
    });
  }

  /** Show a typing indicator until the next message (DMs only). */
  async startTyping(ctx: ActionCtx, args: { chatId: string }): Promise<void> {
    await ctx.runAction(this.component.api.chatAction, { ...args, kind: "typing" });
  }

  async stopTyping(ctx: ActionCtx, args: { chatId: string }): Promise<void> {
    await ctx.runAction(this.component.api.chatAction, { ...args, kind: "stopTyping" });
  }

  /** Mark a chat's messages read. */
  async markRead(ctx: ActionCtx, args: { chatId: string }): Promise<void> {
    await ctx.runAction(this.component.api.chatAction, { ...args, kind: "read" });
  }

  /**
   * Create a Linq webhook subscription pointing at this deployment's webhook
   * route. Returns the signing secret once: set it as LINQ_WEBHOOK_SECRET.
   */
  async registerWebhook(
    ctx: ActionCtx,
    args: { events?: LinqEventType[]; phoneNumbers?: string[]; siteUrl?: string } = {},
  ) {
    const siteUrl = args.siteUrl ?? process.env.CONVEX_SITE_URL;
    if (!siteUrl) throw new Error("linq: CONVEX_SITE_URL is unknown; pass siteUrl");
    const url = new URL(this.webhookPath, siteUrl);
    url.searchParams.set("version", WEBHOOK_PAYLOAD_VERSION);
    return await ctx.runAction(this.component.setup.registerWebhook, {
      targetUrl: url.toString(),
      events: args.events ?? DEFAULT_EVENTS,
      phoneNumbers: args.phoneNumbers,
    });
  }

  /** The lines this API key can send from. */
  async listLines(ctx: ActionCtx): Promise<unknown> {
    return await ctx.runAction(this.component.setup.listLines, {});
  }
}

export type { InboundMessage as LinqMessage };
