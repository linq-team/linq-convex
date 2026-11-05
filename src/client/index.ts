import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReturnType,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type HttpRouter,
  type PaginationOptions,
  httpActionGeneric,
} from "convex/server";
import type { LinqAPIV3 } from "@linqapp/sdk";
import { Webhook } from "standardwebhooks";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  DEFAULT_EVENTS,
  WEBHOOK_PAYLOAD_VERSION,
  type LinqEventType,
  type LinqWebhookEvent,
} from "../shared/events.js";

export type { LinqWebhookEvent, LinqEventType } from "../shared/events.js";
export { DEFAULT_EVENTS, WEBHOOK_PAYLOAD_VERSION } from "../shared/events.js";
export type { ComponentApi } from "../component/_generated/component.js";

/** Linq `MessageContent`: text, media and link parts, effects, replies. */
export type MessageContent = Omit<LinqAPIV3.MessageContent, "idempotency_key">;

/** An inbound message as a turn hands it to the app. */
export interface TurnMessage {
  messageId: string;
  /** Sender handle: E.164 number or email. */
  from: string;
  /** Text parts joined by newlines; empty for media-only messages. */
  text: string;
  /** `iMessage`, `RCS` or `SMS`. */
  service?: string;
  sentAt?: string;
  /** The full Linq message event, for media, links and replies. */
  raw: LinqAPIV3.MessageEventV2;
}

/**
 * What `onMessage` is called with: every message the chat queued since its
 * last turn, oldest first.
 */
export interface Turn {
  turnId: string;
  chatId: string;
  /** The Linq line (E.164) the chat runs on. */
  line?: string;
  isGroup?: boolean;
  messages: TurnMessage[];
}

export interface LinqOptions {
  /**
   * Called once per turn, with the chat's new messages. Must be an action
   * (usually an `internalAction`, so it can call an LLM). A chat runs one turn
   * at a time: messages that arrive meanwhile wait for the next turn.
   */
  onMessage?: FunctionReference<"action", "internal" | "public">;
  /**
   * Called with every verified webhook event, including the ones the
   * component also handles (reactions, delivery status, line health...).
   */
  onEvent?: FunctionReference<"action" | "mutation", "internal" | "public">;
  /**
   * Wait this long after a message before starting a turn, so a burst of
   * texts becomes one turn. Delays every reply.
   * @default 0
   */
  debounceMs?: number;
  /**
   * Let a newer message interrupt a running turn: its queued replies are
   * dropped and, unless it already replied, its messages join the next turn.
   * Pair with `isInterrupted` in slow handlers.
   * @default false
   */
  interrupt?: boolean;
  /** @default "/linq/webhook" */
  webhookPath?: string;
  /** Falls back to `process.env.LINQ_WEBHOOK_SECRET`. */
  webhookSecret?: string;
}

// The minimum each helper needs, so any ctx that has it can be passed.
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
type RunQueryCtx = QueryCtx | MutationCtx | ActionCtx;
type RunMutationCtx = MutationCtx | ActionCtx;
type RunActionCtx = ActionCtx;

type Queued = FunctionReturnType<ComponentApi["outbox"]["enqueue"]>;

/** Where a message goes: a known chat, or a line and recipients. */
export type Destination =
  | { chatId: string; from?: never; to?: never }
  | {
      chatId?: never;
      /** Your Linq line, E.164. */
      from: string;
      /** Recipient handles; more than one starts a group chat. */
      to: string[];
    };

export type SendMessageArgs = Destination & {
  /** Shorthand for a single text part. */
  text?: string;
  /** Full Linq message content; takes precedence over `text`. */
  message?: MessageContent;
  /** The turn this replies in. Dropped if a newer message interrupted it. */
  turnId?: string;
  /**
   * Dedupes the app's own retries of one logical send. Stable across retries
   * or it dedupes nothing. Defaults to a key derived from the outbox row.
   */
  idempotencyKey?: string;
};

const DEFAULT_WEBHOOK_PATH = "/linq/webhook";

/**
 * App-side client for the Linq component. It runs in the app, so it can read
 * the app's environment and turn its function references into handles.
 */
export class Linq {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: LinqOptions = {},
  ) {}

  get webhookPath(): string {
    return this.options.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  }

  /**
   * Mount the webhook endpoint. It verifies the Standard Webhooks signature
   * and stores the event before answering 200, so an acknowledged delivery is
   * durable. Unsigned or tampered deliveries get 401; a missing secret gets
   * 500, which Linq retries for 30 minutes while you set it.
   */
  registerRoutes(http: HttpRouter): void {
    http.route({
      path: this.webhookPath,
      method: "POST",
      handler: httpActionGeneric((ctx, request) => this.handleWebhook(ctx, request)),
    });
  }

  /**
   * The webhook handler `registerRoutes` mounts, for apps that route it
   * themselves. Call it from an `httpAction`.
   */
  async handleWebhook(ctx: Pick<RunMutationCtx, "runMutation">, request: Request): Promise<Response> {
    const secret = this.options.webhookSecret ?? process.env.LINQ_WEBHOOK_SECRET;
    if (!secret) {
      return new Response("LINQ_WEBHOOK_SECRET is not set", { status: 500 });
    }
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

    await ctx.runMutation(this.component.inbound.ingest, {
      eventId,
      event,
      onMessage: this.options.onMessage ? await createFunctionHandle(this.options.onMessage) : undefined,
      onEvent: this.options.onEvent ? await createFunctionHandle(this.options.onEvent) : undefined,
      debounceMs: this.options.debounceMs,
      interrupt: this.options.interrupt,
    });
    return new Response(null, { status: 200 });
  }

  /**
   * Queue a message. Commits with the calling mutation; the component sends
   * it, in order per chat, retrying transient failures with one idempotency key.
   */
  async sendMessage(ctx: RunMutationCtx, args: SendMessageArgs): Promise<Queued> {
    const message: MessageContent | undefined =
      args.message ?? (args.text !== undefined ? { parts: [{ type: "text", value: args.text }] } : undefined);
    return await ctx.runMutation(this.component.outbox.enqueue, {
      kind: "message",
      chatId: args.chatId,
      from: args.from,
      to: args.to,
      message,
      turnId: args.turnId,
      idempotencyKey: args.idempotencyKey,
    });
  }

  /** Show a typing indicator in a chat until the next message (DMs only). */
  async startTyping(ctx: RunMutationCtx, args: { chatId: string; turnId?: string }): Promise<Queued> {
    return await ctx.runMutation(this.component.outbox.enqueue, { kind: "typing", ...args });
  }

  /** Mark a chat's messages read. */
  async markRead(ctx: RunMutationCtx, args: { chatId: string; turnId?: string }): Promise<Queued> {
    return await ctx.runMutation(this.component.outbox.enqueue, { kind: "read", ...args });
  }

  /** Has a newer message interrupted this turn? Only with `interrupt: true`. */
  async isInterrupted(ctx: RunQueryCtx, args: { turnId: string }): Promise<boolean> {
    return await ctx.runQuery(this.component.turns.isInterrupted, args);
  }

  /** A send's status and Linq's delivery report (`sent`, `delivered`, `read`, `failed`). */
  async getSend(ctx: RunQueryCtx, args: { id: string }) {
    return await ctx.runQuery(this.component.outbox.get, args);
  }

  /** Recent sends into a chat, oldest first. */
  async listSends(ctx: RunQueryCtx, args: { chatId: string; limit?: number }) {
    return await ctx.runQuery(this.component.outbox.list, args);
  }

  /** Stored inbound messages for a chat, oldest first. */
  async listMessages(ctx: RunQueryCtx, args: { chatId: string; limit?: number }) {
    return await ctx.runQuery(this.component.inbound.listMessages, args);
  }

  /** Cursor-paginated inbound history, newest receipt first. */
  async paginateMessages(ctx: RunQueryCtx, args: { chatId: string; paginationOpts: PaginationOptions }) {
    return await ctx.runQuery(this.component.inbound.paginateMessages, args);
  }

  /** Cursor-paginated outbound history, newest queued send first. */
  async paginateSends(ctx: RunQueryCtx, args: { chatId: string; paginationOpts: PaginationOptions }) {
    return await ctx.runQuery(this.component.outbox.paginate, args);
  }

  async getChat(ctx: RunQueryCtx, args: { chatId: string }) {
    return await ctx.runQuery(this.component.inbound.getChat, args);
  }

  /**
   * Create a Linq webhook subscription pointing at this deployment's webhook
   * route. Returns the signing secret once: set it as LINQ_WEBHOOK_SECRET.
   */
  async registerWebhook(
    ctx: RunActionCtx,
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
  async listLines(ctx: RunActionCtx): Promise<unknown> {
    return await ctx.runAction(this.component.setup.listLines, {});
  }
}
