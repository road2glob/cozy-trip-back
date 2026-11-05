import type { ToolContext } from "../tools/common";
import { getTripDetail } from "./trips";
import { getSettlement, reconcileSettlement } from "../paymentService";
export interface PaymentRow {
  payment_id: string;
  participant_id: string;
  state: string;
  approve_url: string | null;
  amount_minor: number;
  user_id: string;
}
export async function splitStatus(
  ctx: ToolContext,
  tripId?: string,
  reconcile = false,
) {
  const rows = await (
    tripId
      ? ctx.env.DB.prepare(
          "SELECT p.* FROM payments p JOIN participants m ON m.participant_id=p.participant_id WHERE p.user_id=?1 AND p.trip_id=?2 ORDER BY m.sort_order,p.payment_id",
        ).bind(ctx.userId, tripId)
      : ctx.env.DB.prepare(
          "SELECT p.* FROM payments p JOIN participants m ON m.participant_id=p.participant_id WHERE p.user_id=?1 ORDER BY p.trip_id,m.sort_order,p.payment_id",
        ).bind(ctx.userId)
  ).all<PaymentRow & { trip_id: string }>();
  const result = [];
  for (const p of rows.results) {
    let s = await getSettlement(ctx.env, p.payment_id);
    if (reconcile && s.state === "awaiting-payment")
      s = await reconcileSettlement(ctx.env, p.payment_id);
    await ctx.env.DB.prepare(
      "UPDATE payments SET state=?1,approve_url=?2,updated_at=?3 WHERE payment_id=?4 AND user_id=?5",
    )
      .bind(
        s.state,
        s.approveUrl,
        new Date().toISOString(),
        p.payment_id,
        ctx.userId,
      )
      .run();
    const d = await getTripDetail(ctx.env.DB, ctx.userId, p.trip_id);
    const participant = d?.participants.find(
      (v) => v.participant_id === p.participant_id,
    );
    result.push({
      trip_id: p.trip_id,
      payment_id: p.payment_id,
      participant_id: p.participant_id,
      name: participant?.name,
      amount_minor: p.amount_minor,
      currency: "USD",
      state: s.state,
      prompt: s.state === "awaiting-payment",
      ...(s.state === "awaiting-payment" && s.approveUrl
        ? { approveUrl: s.approveUrl }
        : {}),
      disclaimer:
        "Sandbox demo: funds go to the CozyTrip Team sandbox merchant, not a real person-to-person transfer.",
    });
  }
  return result;
}
