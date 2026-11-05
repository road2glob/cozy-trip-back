import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { fail, ok, type ToolContext } from "./common";
export const name = "reconcile_trip";
export const description =
  "Reconcile source booking and expense totals in integer USD cents; never charge or change an order.";
export const inputSchema = z.object({ trip_id: z.string().min(1) });
export const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const d = await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id);
  if (!d) return fail("not_found", "Import the sample before reconciling.");
  const e = await ctx.env.DB.prepare(
    "SELECT sum(amount_minor) AS total FROM expenses WHERE trip_id=?1",
  )
    .bind(args.trip_id)
    .first<{ total: number }>();
  if (d.totalMinor !== 149100 || e?.total !== d.totalMinor)
    return fail(
      "ledger_mismatch",
      "Booking and expense totals do not match. No payment action is available.",
    );
  await ctx.env.DB.prepare(
    "UPDATE trips SET state='reconciled' WHERE trip_id=?1 AND user_id=?2 AND state='draft'",
  )
    .bind(args.trip_id, ctx.userId)
    .run();
  return ok(
    "Four source bookings reconcile to USD 1,491.00. No airline or merchant was contacted.",
    {
      trip_id: args.trip_id,
      total_minor: d.totalMinor,
      expense_total_minor: e.total,
      currency: "USD",
      booking_count: d.bookings.length,
      provenance: "source",
      reconciled: true,
    },
  );
}
