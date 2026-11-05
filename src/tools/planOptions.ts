import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { getWorkflow } from "../paymentService";
import { fail, ok, type ToolContext } from "./common";
export const name = "plan_options";
export const description =
  "Suggest recovery requests from confirmed sample facts. Never buy, submit, refund, or claim live prices or availability.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  issue_id: z.string().optional(),
});
export const annotations = { readOnlyHint: true, destructiveHint: false };
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const d = await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id);
  if (!d) return fail("not_found", "Import the sample first.");
  if (d.demoEvent?.state !== "fired")
    return fail(
      "demo_not_fired",
      "Confirm an impact assessment before requesting recovery options.",
    );
  if (args.issue_id && args.issue_id !== d.demoEvent.event_id)
    return fail("not_found", "Issue is not part of this trip.");
  const w = await getWorkflow(ctx.env, "cozytrip.aftersales.deliver");
  const options = [
    {
      kind: "airline-rebooking",
      summary:
        "Ask the original airline for a replacement on the source travel date.",
      cost_minor: null,
      timing:
        "Availability and revised arrival time require airline confirmation.",
      limitations:
        "No live fare, seat or refund entitlement has been verified.",
      provenance: "inferred",
    },
    {
      kind: "coordinate-bookings",
      summary:
        "Ask the hotel and linked pickup provider about revised arrival; keep the later-day cruise unless facts change.",
      cost_minor: null,
      timing: "Contact before source booking start times.",
      limitations: "Merchant terms and change fees remain unknown.",
      provenance: "inferred",
    },
    {
      kind: "cozytrip-drafts",
      summary:
        "Purchase prepared coordination drafts, not bookings or merchant actions.",
      cost_minor: w.price.amountMinor,
      currency: "USD",
      timing: "After explicit approval and Sandbox capture.",
      limitations:
        "Drafts only. Not sent. Merchant outcomes are not guaranteed.",
      provenance: "source",
      price_source: "payment-service workflow registry",
    },
  ];
  return ok(
    "Three recovery options. No purchase, submission or merchant contact was made.",
    { trip_id: args.trip_id, issue_id: d.demoEvent.event_id, options },
  );
}
