// One function per endpoint. Paths, methods and headers follow the contract exactly.
// CozyTrip never sends a charge amount: the price comes only from the service's registry.
import type { Env } from "../env";
import { call } from "./transport";
import type {
  ConfirmRequest,
  ConfirmResult,
  CreateRunRequest,
  CreatedRun,
  Charge,
  DecideApprovalRequest,
  Receipt,
  Run,
  SettlementOrder,
  SubmitOutputResult,
  Workflow,
} from "./types";

export { PaymentServiceError } from "./transport";
export type * from "./types";

const seg = (v: string) => encodeURIComponent(v);

export async function getWorkflow(env: Env, workflowId: string): Promise<Workflow> {
  return (await call<Workflow>(env, { method: "GET", path: `/v1/workflows/${seg(workflowId)}` })).data;
}

export async function createRun(env: Env, idempotencyKey: string, body: CreateRunRequest): Promise<CreatedRun> {
  return (await call<CreatedRun>(env, { method: "POST", path: "/v1/runs", body, idempotencyKey })).data;
}

export async function getRun(env: Env, runId: string): Promise<Run> {
  return (await call<Run>(env, { method: "GET", path: `/v1/runs/${seg(runId)}` })).data;
}

export async function decideApproval(env: Env, runId: string, body: DecideApprovalRequest): Promise<Run> {
  return (await call<Run>(env, { method: "POST", path: `/v1/runs/${seg(runId)}/approval`, body })).data;
}

/** Body is always {}. The service prices from its registry (USD 990) and ignores any submitted amount, so none is sent. */
export async function createCharge(env: Env, runId: string, idempotencyKey: string): Promise<{ status: number; charge: Charge }> {
  const { status, data } = await call<Charge>(env, {
    method: "POST",
    path: `/v1/runs/${seg(runId)}/charge`,
    body: {},
    idempotencyKey,
  });
  return { status, charge: data };
}

export async function reconcileCharge(env: Env, runId: string): Promise<ConfirmResult> {
  return (await call<ConfirmResult>(env, { method: "POST", path: `/v1/runs/${seg(runId)}/charge/reconcile`, body: {} })).data;
}

/** A 200 can still carry state=failed: callers must inspect the fields */
export async function submitOutput(env: Env, runId: string, output: Record<string, unknown>): Promise<SubmitOutputResult> {
  return (await call<SubmitOutputResult>(env, { method: "POST", path: `/v1/runs/${seg(runId)}/output`, body: { output } })).data;
}

export async function getReceipt(env: Env, runId: string): Promise<Receipt> {
  return (await call<Receipt>(env, { method: "GET", path: `/v1/runs/${seg(runId)}/receipt` })).data;
}

/** charge_id → ConfirmResult; payment_id → SettlementOrder */
export async function confirmReturn(env: Env, body: ConfirmRequest): Promise<ConfirmResult | SettlementOrder> {
  return (await call<ConfirmResult | SettlementOrder>(env, { method: "POST", path: "/v1/paypal/confirm-return", body })).data;
}

/** Cancel never captures an uncaptured order and never marks it refunded */
export async function confirmCancel(env: Env, body: ConfirmRequest): Promise<ConfirmResult | SettlementOrder> {
  return (await call<ConfirmResult | SettlementOrder>(env, { method: "POST", path: "/v1/paypal/confirm-cancel", body })).data;
}

/** Fixed at 6000 cents USD; the contract accepts no other amount */
export async function createSettlement(env: Env, paymentId: string): Promise<SettlementOrder> {
  return (
    await call<SettlementOrder>(env, {
      method: "POST",
      path: "/v1/settlement-orders",
      body: { paymentId, amountMinor: 6000, currency: "USD", mode: "sandbox" },
    })
  ).data;
}

export async function getSettlement(env: Env, paymentId: string): Promise<SettlementOrder> {
  return (await call<SettlementOrder>(env, { method: "GET", path: `/v1/settlement-orders/${seg(paymentId)}` })).data;
}

export async function reconcileSettlement(env: Env, paymentId: string): Promise<SettlementOrder> {
  return (await call<SettlementOrder>(env, { method: "POST", path: `/v1/settlement-orders/${seg(paymentId)}/reconcile`, body: {} })).data;
}
