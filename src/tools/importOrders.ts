import { z } from "zod";
import { getTripDetail, importSampleTrip } from "../domain/trips";
import { reminderTablesExist } from "../domain/reminders";
import { formatUsd } from "../domain/money";
import { SIMULATED_NOTICE, fail, type ToolContext, type ToolResult } from "./common";
import { guided, nextStep, withGuidance } from "./guidance";

export const name = "import_orders";
export const description =
  "Import only when the user asks. mode sample loads a fictional sample trip and starts nothing else. This version supports only that sample: mode text explains that real orders cannot be read, and imports nothing. A second sample import returns the same trip_id.";
export const inputSchema = z.object({
  mode: z.enum(["sample", "text"]).describe("sample loads the fictional sample trip"),
  text: z.string().optional().describe("Not read in this version"),
  confirmation_code: z.string().optional().describe("Not used in this version"),
});
export const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>): Promise<ToolResult> {
  if (args.mode === "text") {
    return withGuidance(fail("model_not_enabled", "This competition version supports the fictional sample only. It cannot read real orders or an inbox. Nothing was imported."), {
      fact: "CozyTrip cannot read real orders or an inbox in this version, and nothing was imported.",
      next_steps: [nextStep.importSample()],
      end: null,
    });
  }

  const { tripId, created } = await importSampleTrip(ctx.env.DB, ctx.userId);
  const d = await getTripDetail(ctx.env.DB, ctx.userId, tripId);
  if (!d) throw new Error("Imported trip not found");

  const structured = {
    trip_id: tripId,
    replay: !created,
    title: d.trip.title,
    start_date: d.trip.start_date,
    end_date: d.trip.end_date,
    state: d.trip.state,
    provenance: d.trip.provenance,
    reality: d.trip.reality,
    participants: d.participants.map((p) => ({ participant_id: p.participant_id, name: p.name, role: p.role })),
    bookings: d.bookings.map((b) => ({
      booking_id: b.booking_id,
      kind: b.kind,
      vendor: b.vendor,
      title: b.title,
      local_start: b.local_start,
      amount_minor: b.amount_minor,
      display_amount: formatUsd(b.amount_minor),
      currency: b.currency,
      status: b.status,
      linked_booking_id: b.linked_booking_id,
      merchant_refund_status: b.merchant_refund_status,
    })),
    balances: d.balances,
    total_minor: d.totalMinor,
    display_total: formatUsd(d.totalMinor),
    currency: "USD",
    demo_event: d.demoEvent?.state ?? null,
    demo_event_id: d.demoEvent?.event_id ?? null,
    run_count: 0,
  };

  // Shares are paid to the Team sandbox merchant, so this never says anyone owes Maya.
  const shares = d.balances.map((b) => `${b.from}'s share ${formatUsd(b.amount_minor)}`).join(", ");
  const text = [
    created ? `Imported the sample trip ${tripId}.` : `The sample trip was already imported: ${tripId}.`,
    `${d.trip.origin_city} (${d.trip.origin_code}) to ${d.trip.destination_city} (${d.trip.destination_code}), ${d.trip.start_date} to ${d.trip.end_date}.`,
    `Travelers: ${d.participants.map((p) => (p.role === "organizer" ? `${p.name} (organizer)` : p.name)).join(", ")}.`,
    ...d.bookings.map((b) => `- ${b.title}: ${formatUsd(b.amount_minor)}`),
    `Total ${formatUsd(d.totalMinor)}. Airport pickup prepaid by Maya: ${shares}.`,
    "No issue has been simulated and no payment has started.",
    SIMULATED_NOTICE,
  ].join("\n");
  // A repeat import is someone coming back: the trip may have moved on, so read it instead of restarting.
  const guidance = created
    ? {
        fact: `The sample trip is organized: ${d.bookings.length} bookings, ${d.participants.length} travelers, ${formatUsd(d.totalMinor)}. Simulated travel data.`,
        next_steps: (await reminderTablesExist(ctx.env.DB))
          ? [nextStep.seeReminders(tripId, "See reminder plan"), nextStep.previewIssue(tripId), nextStep.quoteSplit(tripId), nextStep.checkOrders(tripId)]
          : [nextStep.previewIssue(tripId, "Preview a simulated issue"), nextStep.quoteSplit(tripId), nextStep.checkOrders(tripId)],
        end: null,
      }
    : { fact: "This sample trip was already imported. Nothing was changed.", next_steps: [nextStep.resume(tripId)], end: null };
  return guided(text, structured, guidance);
}
