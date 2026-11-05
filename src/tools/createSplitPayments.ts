import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { newId } from "../domain/ids";
import { operation, validCode } from "../domain/operations";
import { splitStatus } from "../domain/settlements";
import { formatUsd } from "../domain/money";
import { createSettlement } from "../paymentService";
import { PAYEE_NOTICE, SPLIT_NOTICE } from "./quoteSplit";
import { fail, type ToolContext } from "./common";
import { guided, sharesGuidance } from "./guidance";
export const name = "create_split_payments";
export const description =
  "After local split confirmation, create or reuse two USD 60 Sandbox merchant settlement orders for Leo and Ava. Maya has no order. Funds do not transfer to the person who prepaid.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  confirmation_code: z.string().optional(),
});
export const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const d = await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id);
  if (!d) return fail("not_found", "Import the sample trip first.");
  const quote = await ctx.env.DB.prepare(
    "SELECT run_id FROM split_quotes WHERE trip_id=?1 AND user_id=?2",
  )
    .bind(args.trip_id, ctx.userId)
    .first<{ run_id: string }>();
  if (!quote)
    return fail(
      "quote_required",
      "Call quote_split before creating settlement requests.",
    );
  if (!args.confirmation_code)
    return fail(
      "confirmation_required",
      "Confirm the local split quote before creating payment orders.",
    );
  if (
    !(await validCode(
      ctx,
      args.confirmation_code,
      "split",
      args.trip_id,
      quote.run_id,
    ))
  )
    return fail(
      "invalid_confirmation_code",
      "Invalid or expired local split confirmation. No order was created.",
    );
  return operation(ctx, "split:" + args.trip_id, async () => {
    for (const b of d.balances) {
      if (b.amount_minor !== 6000)
        return fail(
          "ledger_mismatch",
          "Only the source USD 60 debtor shares can be requested.",
        );
      let p = await ctx.env.DB.prepare(
        "SELECT payment_id FROM payments WHERE trip_id=?1 AND participant_id=?2 AND user_id=?3",
      )
        .bind(args.trip_id, b.from_participant_id, ctx.userId)
        .first<{ payment_id: string }>();
      if (!p) {
        const paymentId = newId("pay");
        await ctx.env.DB.prepare(
          "INSERT OR IGNORE INTO payments(payment_id,reference_id,trip_id,participant_id,amount_minor,currency,state,created_at,updated_at,user_id) VALUES(?1,?2,?3,?4,6000,?5,?6,?7,?7,?8)",
        )
          .bind(
            paymentId,
            "settlement:" + paymentId,
            args.trip_id,
            b.from_participant_id,
            "USD",
            "creating",
            new Date().toISOString(),
            ctx.userId,
          )
          .run();
        p = await ctx.env.DB.prepare(
          "SELECT payment_id FROM payments WHERE trip_id=?1 AND participant_id=?2 AND user_id=?3",
        )
          .bind(args.trip_id, b.from_participant_id, ctx.userId)
          .first<{ payment_id: string }>();
      }
      const settlement = await createSettlement(ctx.env, p!.payment_id);
      await ctx.env.DB.prepare(
        "UPDATE payments SET state=?1,approve_url=?2,updated_at=?3 WHERE payment_id=?4 AND user_id=?5",
      )
        .bind(
          settlement.state,
          settlement.approveUrl,
          new Date().toISOString(),
          p!.payment_id,
          ctx.userId,
        )
        .run();
    }
    const payments = await splitStatus(ctx, args.trip_id);
    return guided(
      payments
        .map(
          (p) =>
            `${p.name}: ${p.display_amount}, ${p.state}${"approveUrl" in p ? " " + p.approveUrl : ""}`,
        )
        .join("\n") +
        `\nMaya: ${formatUsd(0)} due; no payment order. ` +
        SPLIT_NOTICE,
      {
        trip_id: args.trip_id,
        payments,
        organizer: { name: "Maya", due_minor: 0, display_due: formatUsd(0), prompt: false },
        disclaimer: SPLIT_NOTICE,
        payee_notice: PAYEE_NOTICE,
      },
      sharesGuidance(args.trip_id, payments),
    );
  });
}
