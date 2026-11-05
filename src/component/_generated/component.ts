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
    api: {
      chatAction: FunctionReference<
        "action",
        "internal",
        { chatId: string; kind: "typing" | "stopTyping" | "read" },
        null,
        Name
      >;
      sendMessage: FunctionReference<
        "action",
        "internal",
        {
          chatId?: string;
          from?: string;
          idempotencyKey: string;
          message: any;
          to?: Array<string>;
        },
        { chatId?: string; from?: string; messageId?: string },
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
  };
