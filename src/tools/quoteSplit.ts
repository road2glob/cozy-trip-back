import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { operation, localCode } from "../domain/operations";
import { createRun, submitOutput, getReceipt } from "../paymentService";
import { fail, ok, type ToolContext } from "./common";
export const SPLIT_NOTICE =
  "Sandbox demo: funds go to the CozyTrip Team sandbox merchant, not a real person-to-person transfer.";
export const name = "quote_split";
export const description =
  "Calculate the source USD 180 transfer as three USD 60 shares. Maya already prepaid in the sample and owes zero. Return a local confirmation code without creating payment orders.";
export const inputSchema = z.object({ trip_id: z.string().min(1) });
export const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const d = await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id);
  if (!d)
    return fail(
      "not_found",
      "Import the source sample before splitting expenses.",
    );
  if (
    d.participants.length !== 3 ||
    d.balances.length !== 2 ||
    d.balances.some((b) => b.amount_minor !== 6000)
  )
    return fail(
      "ledger_mismatch",
      "The source prepaid expense cannot be reconciled to three equal shares.",
    );
  const source = await ctx.env.DB.prepare(
    "SELECT e.amount_minor,e.paid_by_participant_id,sum(s.amount_minor) AS share_total,count(*) AS share_count,min(s.amount_minor) AS min_share,max(s.amount_minor) AS max_share FROM expenses e JOIN bookings b ON b.booking_id=e.booking_id JOIN expense_shares s ON s.expense_id=e.expense_id WHERE e.trip_id=?1 AND b.kind='transfer' GROUP BY e.expense_id",
  )
    .bind(args.trip_id)
    .first<{
      amount_minor: number;
      paid_by_participant_id: string;
      share_total: number;
      share_count: number;
      min_share: number;
      max_share: number;
    }>();
  if (
    !source ||
    source.amount_minor !== 18000 ||
    source.share_total !== 18000 ||
    source.share_count !== 3 ||
    source.min_share !== 6000 ||
    source.max_share !== 6000 ||
    !d.participants.some(
      (p) =>
        p.role === "organizer" &&
        p.participant_id === source.paid_by_participant_id,
    )
  )
    return fail(
      "ledger_mismatch",
      "The source prepaid total and three shares do not reconcile. No payment request is available.",
    );
  return operation(ctx, "split:" + args.trip_id, async () => {
    let q = await ctx.env.DB.prepare(
      "SELECT run_id FROM split_quotes WHERE trip_id=?1 AND user_id=?2",
    )
      .bind(args.trip_id, ctx.userId)
      .first<{ run_id: string }>();
    if (!q) {
      const created = await createRun(ctx.env, "split:" + args.trip_id, {
        workflowId: "cozytrip.split.calculate",
        subjectId: ctx.userId,
        input: {
          tripId: args.trip_id,
          totalMinor: 18000,
          participantIds: d.participants.map((p) => p.participant_id) as [
            string,
            string,
            string,
          ],
        },
      });
      await submitOutput(ctx.env, created.runId, {
        totalMinor: 18000,
        shares: d.participants.map((p) => ({
          participantId: p.participant_id,
          amountMinor: 6000,
        })),
      });
      const receipt = await getReceipt(ctx.env, created.runId);
      if (
        receipt.verificationState !== "passed" ||
        receipt.chargeOutcome !== "none"
      )
        return fail(
          "verification_failed",
          "The free split calculation did not produce a passed, no-charge receipt.",
        );
      await ctx.env.DB.prepare(
        "INSERT OR IGNORE INTO split_quotes(trip_id,user_id,run_id,created_at) VALUES(?1,?2,?3,?4)",
      )
        .bind(args.trip_id, ctx.userId, created.runId, new Date().toISOString())
        .run();
      q = { run_id: created.runId };
    }
    const receipt = await getReceipt(ctx.env, q.run_id);
    const shares = d.participants.map((p) => ({
      participant_id: p.participant_id,
      name: p.name,
      share_minor: 6000,
      due_minor: d.balances.some(
        (b) => b.from_participant_id === p.participant_id,
      )
        ? 6000
        : 0,
      source: "source",
      sample_prepayment: p.role === "organizer",
    }));
    return ok(
      "USD 180 = USD 60 × 3. Maya prepaid in the fictional sample and has no payment link. Leo and Ava each owe USD 60. " +
        SPLIT_NOTICE,
      {
        trip_id: args.trip_id,
        runId: q.run_id,
        total_minor: 18000,
        currency: "USD",
        shares,
        receipt,
        confirmation_code: await localCode(
          ctx,
          "split",
          args.trip_id,
          q.run_id,
        ),
        codeKind: "local",
        disclaimer: SPLIT_NOTICE,
      },
    );
  });
}
