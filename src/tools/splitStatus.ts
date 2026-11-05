import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { splitStatus } from "../domain/settlements";
import { formatUsd } from "../domain/money";
import { operation } from "../domain/operations";
import { fail, type ToolContext } from "./common";
import { guided, sharesGuidance } from "./guidance";
import { PAYEE_NOTICE, SPLIT_NOTICE } from "./quoteSplit";
export const name = "split_status";
export const description =
  "Reconcile existing Sandbox settlement orders and show who has paid. Does not create orders; already-paid members and Maya have no payment prompt.";
export const inputSchema = z.object({ trip_id: z.string().min(1) });
export const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  if (!(await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id)))
    return fail("not_found", "Import the trip first.");
  return operation(ctx, "split:" + args.trip_id, async () => {
    const payments = await splitStatus(ctx, args.trip_id, true);
    return guided(
      payments
        .map(
          (p) =>
            `${p.name}: ${p.display_amount}, ${p.state}${p.prompt ? " — payment pending" : " — no payment prompt"}${"approveUrl" in p ? " " + p.approveUrl : ""}`,
        )
        .join("\n") +
        (payments.length ? "\n" : "") +
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
