// Deterministic fake of the payment & verification service contract (handoff section 5.4).
// Called in-process by paymentService only when TASKPASS_TRANSPORT=stub. It is not the real service:
// no verification engine, no PayPal, no outbound requests, never captures, never reaches `verified`.
import { Hono, type Context } from "hono";
import type { Env } from "../src/env";
import type { Approval, Charge, ConfirmResult, CreatedRun, Receipt, Run, Step, Workflow } from "../src/paymentService/types";
import { canonicalJson, hmacHex, safeEqual, sha256Hex } from "./crypto";
import * as store from "./store";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
const PAID_WORKFLOW = "cozytrip.aftersales.deliver";
const ZERO_PRICE_WORKFLOWS = new Set(["cozytrip.issue.assess", "cozytrip.split.calculate"]);

const WORKFLOWS: Record<string, Workflow> = {
  [PAID_WORKFLOW]: {
    schemaVersion: "20261104",
    mode: "sandbox",
    workflowId: PAID_WORKFLOW,
    productId: "cozytrip",
    version: "stub-1",
    title: "CozyTrip Team after-sales",
    price: { currency: "USD", amountMinor: 990, unit: "verified-result" },
    approvalGates: ["before-execute"],
    status: "active",
  },
  "cozytrip.issue.assess": {
    schemaVersion: "20261104",
    mode: "sandbox",
    workflowId: "cozytrip.issue.assess",
    productId: "cozytrip",
    version: "stub-1",
    title: "CozyTrip impact assessment",
    price: { currency: "USD", amountMinor: 0, unit: "verified-result" },
    approvalGates: [],
    status: "active",
  },
  "cozytrip.split.calculate": {
    schemaVersion: "20261104",
    mode: "sandbox",
    workflowId: "cozytrip.split.calculate",
    productId: "cozytrip",
    version: "stub-1",
    title: "CozyTrip split calculation",
    price: { currency: "USD", amountMinor: 0, unit: "verified-result" },
    approvalGates: [],
    status: "active",
  },
};

type StubContext = Context<{ Bindings: Env }>;

const err = (c: StubContext, status: 400 | 401 | 403 | 404 | 409 | 501, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

async function readJson(c: StubContext): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function idempotencyKey(c: StubContext): string | null {
  const key = c.req.header("Idempotency-Key");
  return key && key.length >= 1 && key.length <= 64 ? key : null;
}

// ---- deterministic identifiers ------------------------------------------------------------

const short = async (seed: string, n = 24) => (await sha256Hex(seed)).slice(0, n);
const ids = {
  run: async (key: string) => `run_${await short(`run:${key}`)}`,
  approval: async (runId: string) => `apr_${await short(`approval:${runId}`)}`,
  approvalToken: async (env: Env, runId: string) => `apt_${(await hmacHex(env.TASKPASS_PRODUCT_TOKEN, `approval-token:${runId}`)).slice(0, 32)}`,
  charge: async (runId: string) => `chg_${await short(`charge:${runId}`)}`,
  paypalRequest: async (chargeId: string) => `stub-${await short(`paypal-request:${chargeId}`)}`,
  receipt: async (runId: string) => `rcp_${await short(`receipt:${runId}`)}`,
};

/** return_token for the stub checkout links; checked by confirm-return / confirm-cancel */
export async function stubReturnToken(env: Env, chargeId: string): Promise<string> {
  return (await hmacHex(env.TASKPASS_PRODUCT_TOKEN, `return:${chargeId}`)).slice(0, 32);
}

// ---- view builders -----------------------------------------------------------------------

/** Pending approvals expire lazily at 30 minutes: the run becomes cancelled */
async function refreshExpiry(db: D1Database, run: store.StubRunRow): Promise<store.StubRunRow> {
  if (run.state === "awaiting-approval" && run.approval_state === "pending" && Date.parse(run.approval_expires_at) <= Date.now()) {
    const updated = { ...run, state: "cancelled", approval_state: "expired", updated_at: new Date().toISOString() };
    await store.updateRun(db, run.run_id, updated);
    return updated;
  }
  return run;
}

function buildSteps(run: store.StubRunRow, charge: store.StubChargeRow | null): Step[] {
  const ended = run.state === "cancelled" || run.state === "rejected";
  const approvalState: Step["state"] =
    run.approval_state === "approved" ? "succeeded" : run.approval_state === "pending" ? "pending" : "failed";
  const approvalDetail =
    run.approval_state === "approved"
      ? "Approved by end-user"
      : run.approval_state === "rejected"
        ? "Rejected by end-user"
        : run.approval_state === "expired"
          ? "Approval expired after 30 minutes"
          : "Waiting for end-user approval (before-execute)";
  const mk = (seq: number, name: Step["name"], state: Step["state"], detail: string, startedAt: string | null, finishedAt: string | null): Step => ({
    stepId: `${run.run_id}-s${seq}`,
    runId: run.run_id,
    seq,
    name,
    state,
    startedAt,
    finishedAt,
    detail,
  });
  return [
    mk(1, "approval", approvalState, approvalDetail, run.created_at, run.approval_decided_at ?? (run.approval_state === "expired" ? run.approval_expires_at : null)),
    ended
      ? mk(2, "payment", "skipped", "Not started", null, null)
      : charge
        ? mk(2, "payment", "running", "Stub order created; the stub never captures", charge.created_at, null)
        : mk(2, "payment", "pending", "No order yet", null, null),
    mk(3, "execute", ended ? "skipped" : "pending", ended ? "Not started" : "Not started in the stub", null, null),
    mk(4, "verify", ended ? "skipped" : "pending", ended ? "Not started" : "Not started in the stub", null, null),
    mk(5, "receipt", ended ? "succeeded" : "pending", ended ? "Receipt issued" : "Not issued", null, ended ? run.updated_at : null),
  ];
}

function buildRun(run: store.StubRunRow, charge: store.StubChargeRow | null): Run {
  const ended = run.state === "cancelled" || run.state === "rejected";
  return {
    schemaVersion: "20261104",
    mode: "sandbox",
    runId: run.run_id,
    workflowId: run.workflow_id,
    workflowVersion: WORKFLOWS[run.workflow_id]?.version ?? "stub-1",
    productId: "cozytrip",
    subjectId: run.subject_id,
    idempotencyKey: run.idempotency_key,
    input: JSON.parse(run.input_json),
    inputDigest: run.input_digest,
    state: run.state as Run["state"],
    steps: buildSteps(run, charge),
    output: null,
    outputDigest: null,
    approvalId: run.approval_id,
    chargeId: run.charge_id,
    verificationId: null,
    receiptId: ended ? `rcp_pending` : null,
    error: null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function buildCharge(charge: store.StubChargeRow): Charge {
  return {
    chargeId: charge.charge_id,
    runId: charge.run_id,
    productId: "cozytrip",
    state: "awaiting-payment",
    amountMinor: 990,
    currency: "USD",
    approveUrl: charge.approve_url,
    paypalOrderId: null,
    paypalCaptureId: null,
    paypalRequestId: charge.paypal_request_id,
    paypalEnvironment: "sandbox",
    createdAt: charge.created_at,
    capturedAt: null,
  };
}

async function runView(db: D1Database, run: store.StubRunRow): Promise<Run> {
  const charge = run.charge_id ? await store.chargeByRun(db, run.run_id) : null;
  const view = buildRun(run, charge);
  if (view.receiptId) view.receiptId = await ids.receipt(run.run_id);
  return view;
}

function validateAftersalesInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["tripId", "bookingIds", "issueId"].includes(k));
  if (extra.length) return `input has unexpected fields: ${extra.join(", ")}`;
  if (!isNonEmptyString(o.tripId)) return "input.tripId is required";
  if (!Array.isArray(o.bookingIds) || o.bookingIds.length < 1 || !o.bookingIds.every(isNonEmptyString))
    return "input.bookingIds must contain at least one id";
  if (new Set(o.bookingIds).size !== o.bookingIds.length) return "input.bookingIds must be unique";
  if (!isNonEmptyString(o.issueId)) return "input.issueId is required";
  return null;
}

// ---- routes ------------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const expected = c.env.TASKPASS_PRODUCT_TOKEN;
  const got = c.req.header("Authorization") ?? "";
  if (!expected || !(await safeEqual(got, `Bearer ${expected}`))) {
    return err(c, 401, "unauthorized", "Missing or invalid product credential");
  }
  await store.ensureSchema(c.env.DB);
  await next();
});

app.get("/v1/workflows/:workflowId", (c) => {
  const wf = WORKFLOWS[c.req.param("workflowId")];
  return wf ? c.json(wf) : err(c, 404, "not-found", "Unknown workflow");
});

app.post("/v1/runs", async (c) => {
  const key = idempotencyKey(c);
  if (!key) return err(c, 400, "invalid-request", "Idempotency-Key header (1-64 characters) is required");
  const body = await readJson(c);
  if (!body) return err(c, 400, "invalid-request", "Body must be a JSON object");
  const { workflowId, subjectId, input, mode } = body;
  if (!isNonEmptyString(workflowId) || !(workflowId in WORKFLOWS)) return err(c, 400, "invalid-request", "Unknown workflowId");
  if (!isNonEmptyString(subjectId)) return err(c, 400, "invalid-request", "subjectId is required");
  if (mode !== undefined && mode !== "sandbox") return err(c, 400, "invalid-request", "mode must be sandbox");
  if (ZERO_PRICE_WORKFLOWS.has(workflowId)) return err(c, 501, "stub-not-implemented", "Zero-price workflows are not in the phase 1 stub");
  const invalid = validateAftersalesInput(input);
  if (invalid) return err(c, 400, "invalid-request", invalid);

  const db = c.env.DB;
  const bodyDigest = await sha256Hex(canonicalJson(body));
  const existing = await store.runByKey(db, key);
  if (existing) {
    if (existing.body_digest !== bodyDigest) return err(c, 409, "idempotency-conflict", "Idempotency-Key was used with a different body");
    return c.json(JSON.parse(existing.created_response) as CreatedRun, 201);
  }

  const now = new Date();
  const runId = await ids.run(key);
  const approval: Approval = {
    approvalId: await ids.approval(runId),
    runId,
    gate: "before-execute",
    state: "pending",
    approvalToken: await ids.approvalToken(c.env, runId),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
  const created: CreatedRun = {
    schemaVersion: "20261104",
    mode: "sandbox",
    runId,
    state: "awaiting-approval",
    approval,
    output: null,
    chargeId: null,
  };
  await store.insertRun(db, {
    run_id: runId,
    idempotency_key: key,
    body_digest: bodyDigest,
    workflow_id: workflowId,
    subject_id: subjectId,
    input_json: JSON.stringify(input),
    input_digest: await sha256Hex(canonicalJson(input)),
    state: "awaiting-approval",
    approval_id: approval.approvalId,
    approval_token: approval.approvalToken,
    approval_state: "pending",
    approval_expires_at: approval.expiresAt,
    approval_decided_at: null,
    actor_ref: null,
    charge_id: null,
    created_response: JSON.stringify(created),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return c.json(created, 201);
});

app.get("/v1/runs/:runId", async (c) => {
  const run = await store.runById(c.env.DB, c.req.param("runId"));
  if (!run) return err(c, 404, "not-found", "Unknown run");
  return c.json(await runView(c.env.DB, await refreshExpiry(c.env.DB, run)));
});

app.post("/v1/runs/:runId/approval", async (c) => {
  const body = await readJson(c);
  if (!body) return err(c, 400, "invalid-request", "Body must be a JSON object");
  const { approvalId, approvalToken, decision, actorType, actorRef, comment } = body;
  if (!isNonEmptyString(approvalId) || !isNonEmptyString(approvalToken)) return err(c, 400, "invalid-request", "approvalId and approvalToken are required");
  if (decision !== "approved" && decision !== "rejected") return err(c, 400, "invalid-request", "decision must be approved or rejected");
  if (actorType !== "end-user") return err(c, 400, "invalid-request", "actorType must be end-user");
  if (!isNonEmptyString(actorRef)) return err(c, 400, "invalid-request", "actorRef is required");
  if (comment !== undefined && (typeof comment !== "string" || comment.length > 280)) return err(c, 400, "invalid-request", "comment must be at most 280 characters");

  const db = c.env.DB;
  const found = await store.runById(db, c.req.param("runId"));
  if (!found) return err(c, 404, "not-found", "Unknown run");
  if (!(await safeEqual(approvalId, found.approval_id)) || !(await safeEqual(approvalToken, found.approval_token))) {
    return err(c, 403, "forbidden", "Invalid approval token");
  }
  const run = await refreshExpiry(db, found);
  if (run.approval_state === "expired") return err(c, 409, "conflict", "Approval expired; the run is cancelled. Open a new run.");
  if (run.approval_state !== "pending") {
    if (run.approval_state === decision) return c.json(await runView(db, run));
    return err(c, 409, "conflict", `Approval already ${run.approval_state}`);
  }
  const now = new Date().toISOString();
  const updated = {
    ...run,
    state: decision === "approved" ? "awaiting-payment" : "rejected",
    approval_state: decision,
    approval_decided_at: now,
    actor_ref: actorRef,
    updated_at: now,
  };
  await store.updateRun(db, run.run_id, updated);
  return c.json(await runView(db, updated));
});

app.post("/v1/runs/:runId/charge", async (c) => {
  const key = idempotencyKey(c);
  if (!key) return err(c, 400, "invalid-request", "Idempotency-Key header (1-64 characters) is required");
  const db = c.env.DB;
  const found = await store.runById(db, c.req.param("runId"));
  if (!found) return err(c, 404, "not-found", "Unknown run");
  const run = await refreshExpiry(db, found);

  const existing = await store.chargeByRun(db, run.run_id);
  if (existing) {
    if (existing.idempotency_key === key) return c.json(JSON.parse(existing.created_response) as Charge, existing.created_status as 200 | 201);
    return c.json(buildCharge(existing), 200);
  }
  if (run.state !== "awaiting-payment") return err(c, 409, "conflict", "Run is not approved; no order was created");

  const chargeId = await ids.charge(run.run_id);
  const now = new Date().toISOString();
  const row: store.StubChargeRow = {
    charge_id: chargeId,
    run_id: run.run_id,
    idempotency_key: key,
    created_status: 201,
    created_response: "",
    approve_url: `${c.env.PUBLIC_RETURN_ORIGIN.replace(/\/+$/, "")}/__stub/checkout/${chargeId}`,
    paypal_request_id: await ids.paypalRequest(chargeId),
    created_at: now,
  };
  const charge = buildCharge(row);
  row.created_response = JSON.stringify(charge);
  await store.insertCharge(db, row);
  await store.updateRun(db, run.run_id, { ...run, charge_id: chargeId, updated_at: now });
  return c.json(charge, 201);
});

app.get("/v1/runs/:runId/receipt", async (c) => {
  const db = c.env.DB;
  const found = await store.runById(db, c.req.param("runId"));
  if (!found) return err(c, 404, "not-found", "Unknown run");
  const run = await refreshExpiry(db, found);
  if (run.state !== "cancelled" && run.state !== "rejected") return err(c, 409, "receipt-not-ready", "Run is not in a terminal state");
  const receipt: Receipt = {
    receiptId: await ids.receipt(run.run_id),
    runId: run.run_id,
    state: "issued",
    verificationState: "not-run",
    chargeOutcome: "none",
    chargeId: null,
    amountMinor: 0,
    currency: "USD",
    inputDigest: run.input_digest,
    outputDigest: null,
    reason: run.state === "rejected" ? "approval-rejected" : "approval-expired",
    issuedAt: run.updated_at,
    mode: "sandbox",
  };
  return c.json(receipt);
});

async function confirm(c: StubContext): Promise<Response> {
  const body = await readJson(c);
  if (!body) return err(c, 400, "invalid-request", "Body must be a JSON object");
  const hasCharge = isNonEmptyString(body.charge_id);
  const hasPayment = isNonEmptyString(body.payment_id);
  if (hasCharge === hasPayment || !isNonEmptyString(body.return_token)) {
    return err(c, 400, "invalid-request", "Send exactly one of charge_id or payment_id, plus return_token");
  }
  if (hasPayment) return err(c, 404, "not-found", "Unknown settlement order");
  const db = c.env.DB;
  const charge = await store.chargeById(db, body.charge_id as string);
  if (!charge) return err(c, 404, "not-found", "Unknown charge");
  if (!(await safeEqual(body.return_token as string, await stubReturnToken(c.env, charge.charge_id)))) {
    return err(c, 403, "forbidden", "Invalid return token");
  }
  const run = await store.runById(db, charge.run_id);
  const result: ConfirmResult = { runId: charge.run_id, state: (run?.state ?? "awaiting-payment") as ConfirmResult["state"], charge: buildCharge(charge) };
  return c.json(result);
}

// Return reconciles and cancel never captures. The stub never captures either way.
app.post("/v1/paypal/confirm-return", confirm);
app.post("/v1/paypal/confirm-cancel", confirm);

const notInStub = (c: StubContext) => err(c, 501, "stub-not-implemented", "Not part of the phase 1 stub");
app.post("/v1/runs/:runId/output", notInStub);
app.post("/v1/runs/:runId/charge/reconcile", notInStub);
app.post("/v1/settlement-orders", notInStub);
app.get("/v1/settlement-orders/:id", notInStub);
app.post("/v1/settlement-orders/:id/reconcile", notInStub);

app.notFound((c) => err(c, 404, "not-found", "Unknown resource"));

export async function stubFetch(request: Request, env: Env): Promise<Response> {
  return app.fetch(request, env);
}
