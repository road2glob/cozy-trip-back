import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { latestServiceOrder, reserveServiceOrder, updateServiceOrder, type ServiceOrderRow } from "../domain/serviceOrders";
import { assertCents, formatUsd } from "../domain/money";
import { createRun, getWorkflow, type CreatedRun, type Workflow } from "../paymentService";
import {
  SERVICE_WORKFLOW_ID,
  STUB_NOTICE,
  fail,
  failFromService,
  isStub,
  ok,
  paymentReality,
  type ToolContext,
  type ToolResult,
} from "./common";

export const name = "quote_service";
export const description =
  "Quote CozyTrip Team after-sales. The price is read from the payment-service workflow registry (USD 9.90). Returns confirmation_code, which is the server-issued approval token. Does not create a PayPal order. Show the summary and wait for the user before create_service_payment.";
// Phase 1: only trip_id is required. issue_id becomes required once detect_impact exists (2026-11-06).
export const inputSchema = z.object({
  trip_id: z.string().min(1).describe("trip_id returned by import_orders"),
  issue_id: z.string().min(1).optional().describe("Issue to cover; optional in this version"),
});
export const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const IN_PROGRESS = new Set(["awaiting-payment", "running", "verifying"]);

function quoteResult(
  ctx: ToolContext,
  workflow: Workflow,
  so: Pick<ServiceOrderRow, "trip_id" | "run_id" | "run_state" | "confirmation_code" | "expires_at">,
  issueId: string,
  replay: boolean,
): ToolResult {
  const amountMinor = assertCents(workflow.price.amountMinor);
  const price = formatUsd(amountMinor);
  const structured = {
    trip_id: so.trip_id,
    issue_id: issueId,
    runId: so.run_id,
    state: so.run_state,
    workflowId: workflow.workflowId,
    title: workflow.title,
    price: { amountMinor, currency: workflow.price.currency, unit: workflow.price.unit, source: "payment-service workflow registry" },
    confirmation_code: so.confirmation_code,
    codeKind: "approval",
    expires_at: so.expires_at,
    output: null,
    replay,
    reality: paymentReality(ctx.env),
  };
  const lines = [
    `Quote: ${workflow.title}, ${price}. The price comes from the payment-service workflow registry.`,
    `Run ${so.run_id} is ${so.run_state}.`,
    `confirmation_code: ${so.confirmation_code} (expires ${so.expires_at})`,
    "This step does not create a PayPal order. Show this summary to the user and wait for their go-ahead before calling create_service_payment.",
  ];
  if (isStub(ctx.env)) lines.push(STUB_NOTICE);
  return ok(lines.join("\n"), structured);
}

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>): Promise<ToolResult> {
  const { env, userId } = ctx;
  const d = await getTripDetail(env.DB, userId, args.trip_id);
  if (!d) return fail("not_found", "No trip with that trip_id for this user. Import the sample trip first.");
  const ev = d.demoEvent;
  if (!ev || ev.kind !== "flight_cancellation" || ev.state !== "fired") return fail("not_found", "No confirmed issue exists. Preview and confirm detect_impact before requesting a paid service.");
  if (args.issue_id && args.issue_id !== ev.event_id) return fail("not_found", "issue_id does not belong to this trip.");

  let workflow: Workflow;
  try {
    workflow = await getWorkflow(env, SERVICE_WORKFLOW_ID);
  } catch (e) {
    return failFromService(e, "Reading the service price");
  }
  if (workflow.status !== "active" || workflow.price.currency !== "USD") {
    return fail("service_unavailable", "The after-sales workflow is not active in the payment service.");
  }

  // Same trip, not expired: return the original run and token.
  let so = await latestServiceOrder(env.DB, userId, d.trip.trip_id, SERVICE_WORKFLOW_ID);
  if (so?.run_id) {
    const pending = so.run_state === "awaiting-approval" && !!so.expires_at && Date.parse(so.expires_at) > Date.now();
    if (pending || IN_PROGRESS.has(so.run_state)) return quoteResult(ctx, workflow, so, ev.event_id, true);
    if (so.run_state === "verified") return fail("already_paid", "This trip already has a completed after-sales run.", { runId: so.run_id });
  }
  // Reuse a reserved key whose POST /v1/runs never completed; otherwise reserve a new one.
  if (!so || so.run_id) so = await reserveServiceOrder(env.DB, userId, d.trip.trip_id, SERVICE_WORKFLOW_ID);

  let created: CreatedRun;
  try {
    created = await createRun(env, so.run_idempotency_key, {
      workflowId: SERVICE_WORKFLOW_ID,
      subjectId: userId,
      input: { tripId: d.trip.trip_id, bookingIds: d.bookings.map((b) => b.booking_id), issueId: ev.event_id },
      mode: "sandbox",
    });
  } catch (e) {
    return failFromService(e, "Opening the payment-service run");
  }
  if (!created.approval) {
    await updateServiceOrder(env.DB, so.service_order_id, { run_id: created.runId, run_state: created.state });
    return fail("service_unexpected", "The payment service returned no approval for a priced workflow.", { runId: created.runId });
  }
  const fields = {
    run_id: created.runId,
    run_state: created.state,
    approval_id: created.approval.approvalId,
    confirmation_code: created.approval.approvalToken,
    expires_at: created.approval.expiresAt,
  };
  await updateServiceOrder(env.DB, so.service_order_id, fields);
  return quoteResult(ctx, workflow, { ...so, ...fields }, ev.event_id, false);
}
