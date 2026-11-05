import {splitStatus} from '../domain/settlements';
import { z } from "zod";
import { getTripDetail, listTripIds, type TripDetail } from "../domain/trips";
import { formatUsd } from "../domain/money";
import { listServiceOrders, updateServiceOrder } from "../domain/serviceOrders";
import { isTerminal } from "../domain/runStates";
import { readEvents, reminderTablesExist, summarize } from "../domain/reminders";
import { getReceipt, getRun, PaymentServiceError } from "../paymentService";
import { SIMULATED_NOTICE, STUB_NOTICE, fail, failFromService, isStub, type ToolContext, type ToolResult } from "./common";
import { guided, nextStep, tripGuidance } from "./guidance";

export const name = "get_status";
export const description =
  "Read the signed-in user's trips and any payment-service runs. Empty before import. Reports run state and, only when a receipt exists, chargeOutcome. Does not create a PayPal order. Does not treat the browser return page as payment success.";
export const inputSchema = z.object({
  trip_id: z.string().min(1).optional().describe("Limit the status to one trip"),
});
export const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function tripSummary(d: TripDetail) {
  return {
    trip_id: d.trip.trip_id,
    title: d.trip.title,
    route: `${d.trip.origin_city} (${d.trip.origin_code}) to ${d.trip.destination_city} (${d.trip.destination_code})`,
    start_date: d.trip.start_date,
    end_date: d.trip.end_date,
    state: d.trip.state,
    provenance: d.trip.provenance,
    reality: d.trip.reality,
    participants: d.participants.map((p) => ({ participant_id: p.participant_id, name: p.name, role: p.role })),
    booking_count: d.bookings.length,
    // Enough to answer "what should I check?" from what is known, without importing again.
    bookings: d.bookings.map((b) => ({ title: b.title, kind: b.kind, local_start: b.local_start, status: b.status, display_amount: formatUsd(b.amount_minor) })),
    demo_event: d.demoEvent ? { event_id: d.demoEvent.event_id, kind: d.demoEvent.kind, state: d.demoEvent.state } : null,
  };
}

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>): Promise<ToolResult> {
  const { env, userId } = ctx;
  const tripIds = args.trip_id ? [args.trip_id] : await listTripIds(env.DB, userId);
  const details: TripDetail[] = [];
  for (const id of tripIds) {
    const d = await getTripDetail(env.DB, userId, id);
    if (!d) return fail("not_found", "No trip with that trip_id for this user.");
    details.push(d);
  }

  // A run is read from the service only when CozyTrip already holds its runId.
  const runs: Array<Record<string, unknown>> = [];
  for (const so of await listServiceOrders(env.DB, userId, args.trip_id)) {
    try {
      const r = await getRun(env, so.run_id!);
      const entry: Record<string, unknown> = { trip_id: so.trip_id, runId: r.runId, workflowId: r.workflowId, state: r.state, steps: r.steps };
      if (isTerminal(r.state)) {
        try {
          entry.chargeOutcome = (await getReceipt(env, r.runId)).chargeOutcome;
        } catch (e) {
          // 409 receipt-not-ready: leave receipt fields out
          if (!(e instanceof PaymentServiceError && e.status === 409)) throw e;
        }
      }
      if (r.state !== so.run_state) await updateServiceOrder(env.DB, so.service_order_id, { run_state: r.state });
      runs.push(entry);
    } catch (e) {
      return failFromService(e, `Reading run ${so.run_id}`);
    }
  }

  const trips = details.map(tripSummary);
  const payments=(await splitStatus(ctx,args.trip_id)).map((p)=>({...p,name:p.name??"Member"}));
  const cases=await (args.trip_id?env.DB.prepare('SELECT run_id,state,drafting_method,report_json FROM case_progress WHERE user_id=?1 AND trip_id=?2').bind(userId,args.trip_id):env.DB.prepare('SELECT run_id,state,drafting_method,report_json FROM case_progress WHERE user_id=?1').bind(userId)).all<{run_id:string;state:string;drafting_method:string;report_json:string|null}>();
  const caseViews=cases.results.map(c=>({runId:c.run_id,trackingState:c.state,draftingMethod:c.drafting_method,report:c.report_json?JSON.parse(c.report_json):null,available_actions:['update_case_status']}));
  const structured = { trips, runs, run_count: runs.length, split_payments: payments,...(caseViews.length?{service_orders:caseViews}:{}) };

  if (trips.length === 0) {
    return guided("", { ...structured, available_actions: ["import_orders"] }, { fact: "CozyTrip is connected. There are no trips yet.", next_steps: [nextStep.importSample()], end: null });
  }

  const lines = trips.flatMap((t) => [
    `${t.title} (${t.trip_id}): ${t.start_date} to ${t.end_date}, ${t.booking_count} bookings, state ${t.state}.`,
    ...t.bookings.map((b) => `- ${b.title}: ${b.local_start}, ${b.status}, ${b.display_amount}.`),
  ]);
  lines.push(SIMULATED_NOTICE);
  if (runs.length === 0) {
    lines.push("No payment-service runs.");
  } else {
    for (const r of runs) {
      const outcome = "chargeOutcome" in r ? `, chargeOutcome ${String(r.chargeOutcome)}` : "";
      lines.push(`Run ${String(r.runId)}: state ${String(r.state)}${outcome}.`);
    }
    if (isStub(env)) lines.push(STUB_NOTICE);
  }
  for(const p of payments)lines.push(`${p.name}: ${p.display_amount} ${p.state}${p.prompt?' — payment requested':' — no payment prompt'}`);
  for(const c of caseViews)lines.push(`Service case ${c.runId}: ${c.trackingState}; user-reported follow-up only.`);

  // One sample trip per user today; several trips would each need their own guidance.
  const first = details[0];
  const tripId = first.trip.trip_id;
  const reminders = (await reminderTablesExist(env.DB)) ? summarize(await readEvents(env.DB, userId, tripId)) : null;
  const latest = runs.filter((r) => r.trip_id === tripId).at(-1);
  const guidance = tripGuidance({
    detail: first,
    run: latest ? { runId: String(latest.runId), state: String(latest.state), ...(typeof latest.chargeOutcome === "string" ? { chargeOutcome: latest.chargeOutcome } : {}) } : null,
    trackingState: caseViews.find((c) => c.runId === latest?.runId)?.trackingState ?? null,
    shares: payments.filter((p) => p.trip_id === tripId),
    reminders,
  });
  return guided(lines.join("\n"), { ...structured, ...(reminders ? { reminders } : {}) }, guidance);
}
