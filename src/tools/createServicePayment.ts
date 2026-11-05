import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { serviceOrderByRun, updateServiceOrder, type ServiceOrderRow } from "../domain/serviceOrders";
import { isTerminal } from "../domain/runStates";
import { newId } from "../domain/ids";
import { createCharge, decideApproval, getReceipt, getRun, PaymentServiceError, type Charge } from "../paymentService";
import {
  NOT_PAID_UNTIL_RECEIPT,
  REAL_SANDBOX_NOTICE,
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

export const name = "create_service_payment";
export const description =
  "After the user confirms, submit the payment-service approval and create the Sandbox service-fee order. Requires confirmation_code from quote_service. Returns the PayPal approve URL. Does not capture. Payment is not successful until a receipt shows chargeOutcome captured and verificationState passed.";
// confirmation_code is optional in the schema so a missing code returns confirmation_required, not a schema error.
export const inputSchema = z.object({
  trip_id: z.string().min(1).describe("trip_id returned by import_orders"),
  run_id: z.string().min(1).describe("runId returned by quote_service"),
  confirmation_code: z.string().min(1).optional().describe("confirmation_code from quote_service, after the user agrees"),
});
export const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

function paymentResult(ctx: ToolContext, so: ServiceOrderRow, charge: Charge, replay: boolean): ToolResult {
  const structured = {
    trip_id: so.trip_id,
    runId: so.run_id,
    chargeId: charge.chargeId,
    approveUrl: charge.approveUrl,
    paypalOrderId: charge.paypalOrderId,
    state: charge.state,
    replay,
    reality: paymentReality(ctx.env),
  };
  const lines = [
    replay ? `The service-fee order for run ${so.run_id} already exists. Same link:` : `Service-fee order created for run ${so.run_id}. Approve it here:`,
    charge.approveUrl ?? "(the service returned no link)",
    `State: ${charge.state}.`,
    isStub(ctx.env) ? STUB_NOTICE : REAL_SANDBOX_NOTICE,
    NOT_PAID_UNTIL_RECEIPT,
  ];
  return ok(lines.join("\n"), structured);
}

const invalidCode = (extra: Record<string, unknown> = {}) =>
  fail("invalid_confirmation_code", "confirmation_code does not match this run. No order was created.", extra);

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>): Promise<ToolResult> {
  const { env, userId } = ctx;
  if (!args.confirmation_code) {
    return fail("confirmation_required", "Call quote_service, show the summary to the user, and pass its confirmation_code once they agree.");
  }
  if (!(await getTripDetail(env.DB, userId, args.trip_id))) return fail("not_found", "No trip with that trip_id for this user.");
  let so = await serviceOrderByRun(env.DB, userId, args.trip_id, args.run_id);
  if (!so || so.workflow_id !== SERVICE_WORKFLOW_ID) return fail("not_found", "No quoted run with that run_id for this trip.");
  const runId = so.run_id!;

  // An order already exists: never a second one. Paid and verified means no new link at all.
  if (so.charge_id && so.charge_idempotency_key) {
    try {
      const r = await getRun(env, runId);
      if (r.state === "verified") {
        const receipt = await getReceipt(env, runId);
        if (receipt.verificationState === "passed" && receipt.chargeOutcome === "captured") {
          return fail("already_paid", "This run is already paid and verified. No new link.", { runId });
        }
      }
    } catch (e) {
      if (!(e instanceof PaymentServiceError && e.status === 409)) return failFromService(e, "Reading the run");
    }
    if (args.confirmation_code !== so.confirmation_code) return invalidCode();
    try {
      const { charge } = await createCharge(env, runId, so.charge_idempotency_key);
      return paymentResult(ctx, so, charge, true);
    } catch (e) {
      return failFromService(e, "Reading the service-fee order");
    }
  }

  // Expired approval: do not call charge. The service cancels the run; a new quote opens a new run.
  if (so.run_state === "awaiting-approval" && so.expires_at && Date.parse(so.expires_at) <= Date.now()) {
    try {
      const r = await getRun(env, runId);
      await updateServiceOrder(env.DB, so.service_order_id, { run_state: r.state });
    } catch {
      // the local expiry is enough to refuse
    }
    return fail("approval_expired", "The confirmation code expired and the run was cancelled. No order was created. Call quote_service for a new run.", {
      runId,
    });
  }
  if (isTerminal(so.run_state)) return fail("run_closed", `Run ${runId} is ${so.run_state}. Call quote_service for a new run.`, { runId });

  if (so.run_state === "awaiting-approval") {
    try {
      const r = await decideApproval(env, runId, {
        approvalId: so.approval_id!,
        approvalToken: args.confirmation_code,
        decision: "approved",
        actorType: "end-user",
        actorRef: userId,
      });
      await updateServiceOrder(env.DB, so.service_order_id, { run_state: r.state });
      so = { ...so, run_state: r.state };
      if (r.state !== "awaiting-payment") return fail("run_closed", `Run ${runId} is ${r.state} after approval. No order was created.`, { runId });
    } catch (e) {
      if (e instanceof PaymentServiceError && e.status === 403) return invalidCode({ http_status: 403, service_code: e.code });
      return failFromService(e, "Submitting the approval");
    }
  } else if (args.confirmation_code !== so.confirmation_code) {
    // Approved earlier but the order was never created (for example after a timeout): the code must still match.
    return invalidCode();
  }

  // Reserve the charge Idempotency-Key before calling, so a retry after a timeout reuses it.
  let key = so.charge_idempotency_key;
  if (!key) {
    key = newId("charge-key", 18);
    await updateServiceOrder(env.DB, so.service_order_id, { charge_idempotency_key: key });
    so = { ...so, charge_idempotency_key: key };
  }
  try {
    const { status, charge } = await createCharge(env, runId, key);
    const fields = {
      charge_id: charge.chargeId,
      charge_state: charge.state,
      approve_url: charge.approveUrl,
      paypal_order_id: charge.paypalOrderId,
    };
    await updateServiceOrder(env.DB, so.service_order_id, fields);
    return paymentResult(ctx, { ...so, ...fields }, charge, status === 200);
  } catch (e) {
    return failFromService(e, "Creating the service-fee order");
  }
}
