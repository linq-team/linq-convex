import type { MutationCtx } from "./_generated/server.js";
import { deliveryAdvances, type DeliveryStatus } from "../shared/events.js";

/** Keep unmatched receipts so a later send response can consume their state. */
export async function recordDelivery(
  ctx: MutationCtx,
  messageId: string,
  delivery: DeliveryStatus,
  error?: string,
) {
  const receipt = await ctx.db.query("receipts")
    .withIndex("by_messageId", q => q.eq("messageId", messageId)).unique();
  if (!receipt || deliveryAdvances(receipt.delivery, delivery)) {
    const fields = { messageId, delivery, error: delivery === "failed" ? error : undefined };
    if (receipt) await ctx.db.patch("receipts", receipt._id, fields);
    else await ctx.db.insert("receipts", fields);
  }

  const send = await ctx.db.query("outbox")
    .withIndex("by_messageId", q => q.eq("messageId", messageId)).first();
  if (send && deliveryAdvances(send.delivery, delivery)) {
    await ctx.db.patch("outbox", send._id, {
      delivery, deliveryError: delivery === "failed" ? error : undefined,
    });
  }
}

export async function receiptForMessage(ctx: MutationCtx, messageId: string) {
  const receipt = await ctx.db.query("receipts")
    .withIndex("by_messageId", q => q.eq("messageId", messageId)).unique();
  return {
    delivery: receipt?.delivery ?? ("sent" as const),
    deliveryError: receipt?.delivery === "failed" ? receipt.error : undefined,
  };
}
