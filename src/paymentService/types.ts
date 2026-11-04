// HTTP contract types of the payment & verification service, matching
// contract/openapi_cozytrip_20261105.yaml (info.version 20261104.2) field for field.
// Describes the contract only; nothing here is inferred from the service's source.

export type RunState =
  | "awaiting-approval"
  | "awaiting-payment"
  | "running"
  | "verifying"
  | "verified"
  | "failed"
  | "rejected"
  | "cancelled";

export type ChargeState = "awaiting-payment" | "captured" | "failed" | "void" | "refund-required" | "refunded";

export type WorkflowId = "cozytrip.issue.assess" | "cozytrip.aftersales.deliver" | "cozytrip.split.calculate";

export interface ErrorBody {
  error: { code: string; message: string };
}

export interface Workflow {
  schemaVersion: "20261104";
  mode: "sandbox";
  workflowId: string;
  productId: "cozytrip";
  version: string;
  title: string;
  price: { currency: "USD"; amountMinor: 0 | 990; unit: "verified-result" };
  approvalGates: Array<"before-execute" | "before-charge">;
  status: "active" | "retired";
}

export interface Approval {
  approvalId: string;
  runId?: string;
  gate: "before-execute" | "before-charge";
  state: "pending" | "approved" | "rejected" | "expired";
  approvalToken: string;
  expiresAt: string;
  actorType?: string;
  actorRef?: string;
  decidedAt?: string;
  comment?: string;
}

export interface Step {
  stepId: string;
  runId: string;
  seq: number;
  name: "approval" | "payment" | "execute" | "verify" | "receipt";
  state: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  detail: string;
}

export interface Charge {
  chargeId: string;
  runId?: string;
  productId?: string;
  state: ChargeState;
  amountMinor: 990;
  currency: "USD";
  approveUrl: string | null;
  paypalOrderId: string | null;
  paypalCaptureId?: string | null;
  paypalRequestId?: string;
  paypalEnvironment: "sandbox";
  createdAt?: string;
  capturedAt?: string | null;
}

export interface Verification {
  verificationId: string;
  runId: string;
  state: "passed" | "failed";
  method: "json-schema";
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  outputDigest: string;
  verifiedAt: string;
}

export interface Receipt {
  receiptId: string;
  runId: string;
  state: "issued";
  verificationState: "passed" | "failed" | "not-run";
  chargeOutcome: "none" | "captured" | "refund-required" | "refunded" | "void";
  chargeId: string | null;
  amountMinor: number;
  currency: "USD";
  inputDigest: string;
  outputDigest: string | null;
  reason: string | null;
  issuedAt: string;
  mode: "sandbox";
}

export interface Run {
  schemaVersion: "20261104";
  mode: "sandbox";
  runId: string;
  workflowId: string;
  workflowVersion: string;
  productId: string;
  subjectId: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  inputDigest: string;
  state: RunState;
  steps: Step[];
  output: Record<string, unknown> | null;
  outputDigest: string | null;
  approvalId: string | null;
  chargeId: string | null;
  verificationId: string | null;
  receiptId: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedRun {
  schemaVersion: "20261104";
  mode: "sandbox";
  runId: string;
  state: RunState;
  approval: Approval | null;
  output: null;
  chargeId: null;
}

export interface ConfirmResult {
  runId: string;
  state: RunState;
  charge: Charge;
}

export interface IssueInput {
  tripId: string;
  bookingIds: string[];
}
export interface AftersalesInput {
  tripId: string;
  bookingIds: string[];
  issueId: string;
}
export interface SplitInput {
  tripId: string;
  totalMinor: number;
  participantIds: [string, string, string];
}

export type CreateRunRequest =
  | { workflowId: "cozytrip.issue.assess"; subjectId: string; input: IssueInput; mode?: "sandbox" }
  | { workflowId: "cozytrip.aftersales.deliver"; subjectId: string; input: AftersalesInput; mode?: "sandbox" }
  | { workflowId: "cozytrip.split.calculate"; subjectId: string; input: SplitInput; mode?: "sandbox" };

export interface DecideApprovalRequest {
  approvalId: string;
  approvalToken: string;
  decision: "approved" | "rejected";
  actorType: "end-user" | "operator";
  actorRef: string;
  comment?: string;
}

export interface SubmitOutputResult {
  runId: string;
  state: RunState;
  verification: Verification;
}

/** confirm-return / confirm-cancel: exactly one of charge_id or payment_id, plus return_token */
export type ConfirmRequest = { charge_id: string; return_token: string } | { payment_id: string; return_token: string };

export interface SettlementOrder {
  paymentId: string;
  amountMinor: 6000;
  currency: "USD";
  mode: "sandbox";
  state: "awaiting-payment" | "captured" | "failed" | "void";
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paypalRequestId: string;
  approveUrl: string | null;
  createdAt?: string;
  capturedAt?: string | null;
  error?: { code: string; message: string };
  disclaimer: "Sandbox demo: funds go to a sandbox account, not a real person-to-person transfer.";
}
