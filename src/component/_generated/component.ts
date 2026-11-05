/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    inbound: {
      getChat: FunctionReference<
        "query",
        "internal",
        { chatId: string },
        null | {
          chatId: string;
          isGroup?: boolean;
          lastInboundAt?: number;
          line?: string;
        },
        Name
      >;
      ingest: FunctionReference<
        "mutation",
        "internal",
        {
          debounceMs?: number;
          event: any;
          eventId: string;
          interrupt?: boolean;
          onEvent?: string;
          onMessage?: string;
        },
        { duplicate: boolean },
        Name
      >;
      listMessages: FunctionReference<
        "query",
        "internal",
        { chatId: string; limit?: number },
        Array<{
          from: string;
          messageId: string;
          receivedAt: number;
          sentAt?: string;
          service?: string;
          status: "queued" | "inTurn" | "handled";
          text: string;
        }>,
        Name
      >;
    };
    outbox: {
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          chatId?: string;
          from?: string;
          idempotencyKey?: string;
          kind: "message" | "typing" | "read";
          message?: any;
          to?: Array<string>;
          turnId?: string;
        },
        {
          id: string;
          status: "queued" | "sending" | "sent" | "failed" | "cancelled";
        },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { id: string },
        null | {
          attempts: number;
          chatId?: string;
          delivery?: "sent" | "delivered" | "read" | "failed";
          error?: string;
          id: string;
          kind: "message" | "typing" | "read";
          messageId?: string;
          queuedAt: number;
          sentAt?: number;
          status: "queued" | "sending" | "sent" | "failed" | "cancelled";
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { chatId: string; limit?: number },
        Array<{
          attempts: number;
          chatId?: string;
          delivery?: "sent" | "delivered" | "read" | "failed";
          error?: string;
          id: string;
          kind: "message" | "typing" | "read";
          messageId?: string;
          queuedAt: number;
          sentAt?: number;
          status: "queued" | "sending" | "sent" | "failed" | "cancelled";
        }>,
        Name
      >;
    };
    setup: {
      listLines: FunctionReference<"action", "internal", {}, any, Name>;
      registerWebhook: FunctionReference<
        "action",
        "internal",
        {
          events: Array<string>;
          phoneNumbers?: Array<string>;
          targetUrl: string;
        },
        { signingSecret: string; subscriptionId: string; targetUrl: string },
        Name
      >;
    };
    turns: {
      isInterrupted: FunctionReference<
        "query",
        "internal",
        { turnId: string },
        boolean,
        Name
      >;
    };
  };
