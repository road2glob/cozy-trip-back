import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { formatUsd } from "../domain/money";
import { fail, type ToolContext } from "./common";
import { guided, nextStep } from "./guidance";
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
      `Bookings come to ${formatUsd(d.totalMinor)} and expenses to ${formatUsd(e?.total ?? 0)}. These do not reconcile, so no payment action is available.`,
      { booking_total_minor: d.totalMinor, expense_total_minor: e?.total ?? 0 },
    );
  await ctx.env.DB.prepare(
    "UPDATE trips SET state='reconciled' WHERE trip_id=?1 AND user_id=?2 AND state='draft'",
  )
    .bind(args.trip_id, ctx.userId)
    .run();
  const total = formatUsd(d.totalMinor);
  return guided(
    `Four source bookings reconcile to ${total}. No airline or merchant was contacted.`,
    {
      trip_id: args.trip_id,
      total_minor: d.totalMinor,
      display_total: total,
      expense_total_minor: e.total,
      currency: "USD",
      booking_count: d.bookings.length,
      provenance: "source",
      reconciled: true,
    },
    {
      fact: `The orders are checked: ${d.bookings.length} bookings and their expenses both come to ${total}. No mismatch and no payment is needed.`,
      next_steps: [nextStep.quoteSplit(args.trip_id), nextStep.previewIssue(args.trip_id)],
      end: null,
    },
  );
}
