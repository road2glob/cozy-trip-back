import { describe, expect, it } from "vitest";
import { stubFetch, stubReturnToken } from "../stub";
import { PRODUCT_TOKEN, testEnv } from "./helpers/env";

const ORIGIN = "https://taskpass.internal";
const aftersalesBody = (over: Record<string, unknown> = {}) => ({
  workflowId: "cozytrip.aftersales.deliver",
  subjectId: "usr_a",
  input: { tripId: "trip_1", bookingIds: ["bkg_1", "bkg_2"], issueId: "evt_1" },
  mode: "sandbox",
  ...over,
});

function call(env: ReturnType<typeof testEnv>["env"], method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return stubFetch(
    new Request(ORIGIN + path, {
      method,
      headers: { Authorization: `Bearer ${PRODUCT_TOKEN}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

async function createApprovedRun(env: ReturnType<typeof testEnv>["env"], key = "k-1") {
  const created = (await (await call(env, "POST", "/v1/runs", aftersalesBody(), { "Idempotency-Key": key })).json()) as any;
  const approval = await call(env, "POST", `/v1/runs/${created.runId}/approval`, {
    approvalId: created.approval.approvalId,
    approvalToken: created.approval.approvalToken,
    decision: "approved",
    actorType: "end-user",
    actorRef: "usr_a",
  });
  expect(approval.status).toBe(200);
  return created;
}

describe("stub contract", () => {
  it("returns 401 without the product credential or with a wrong one", async () => {
    const { env } = testEnv();
    const none = await stubFetch(new Request(`${ORIGIN}/v1/workflows/cozytrip.aftersales.deliver`), env);
    expect(none.status).toBe(401);
    const wrong = await call(env, "GET", "/v1/workflows/cozytrip.aftersales.deliver", undefined, { Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
  });

  it("prices the after-sales workflow at 990 USD with a before-execute gate", async () => {
    const { env } = testEnv();
    const wf = (await (await call(env, "GET", "/v1/workflows/cozytrip.aftersales.deliver")).json()) as any;
    expect(wf.price).toEqual({ currency: "USD", amountMinor: 990, unit: "verified-result" });
    expect(wf.approvalGates).toContain("before-execute");
  });

  it("rejects AftersalesInput missing tripId, bookingIds or issueId with 400", async () => {
    const { env } = testEnv();
    for (const missing of ["tripId", "bookingIds", "issueId"]) {
      const input: Record<string, unknown> = { tripId: "trip_1", bookingIds: ["bkg_1"], issueId: "evt_1" };
      delete input[missing];
      const res = await call(env, "POST", "/v1/runs", aftersalesBody({ input }), { "Idempotency-Key": `k-${missing}` });
      expect(res.status, missing).toBe(400);
    }
  });

  it("same Idempotency-Key and body: same runId and approvalToken; different body: 409 idempotency-conflict", async () => {
    const { env } = testEnv();
    const a = await call(env, "POST", "/v1/runs", aftersalesBody(), { "Idempotency-Key": "k-same" });
    const b = await call(env, "POST", "/v1/runs", aftersalesBody(), { "Idempotency-Key": "k-same" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ja = (await a.json()) as any;
    const jb = (await b.json()) as any;
    expect(jb.runId).toBe(ja.runId);
    expect(jb.approval.approvalToken).toBe(ja.approval.approvalToken);
    expect(ja.state).toBe("awaiting-approval");
    expect(ja.approval.gate).toBe("before-execute");
    expect(ja.output).toBeNull();
    expect(ja.chargeId).toBeNull();

    const c = await call(env, "POST", "/v1/runs", aftersalesBody({ subjectId: "usr_other" }), { "Idempotency-Key": "k-same" });
    expect(c.status).toBe(409);
    expect(((await c.json()) as any).error.code).toBe("idempotency-conflict");
  });

  it("refuses to charge an unapproved run with 409 and no approveUrl", async () => {
    const { env } = testEnv();
    const created = (await (await call(env, "POST", "/v1/runs", aftersalesBody(), { "Idempotency-Key": "k-2" })).json()) as any;
    const res = await call(env, "POST", `/v1/runs/${created.runId}/charge`, {}, { "Idempotency-Key": "c-1" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("approveUrl");
  });

  it("requires actorType end-user and the right approval token", async () => {
    const { env } = testEnv();
    const created = (await (await call(env, "POST", "/v1/runs", aftersalesBody(), { "Idempotency-Key": "k-3" })).json()) as any;
    const base = { approvalId: created.approval.approvalId, approvalToken: created.approval.approvalToken, decision: "approved", actorRef: "usr_a" };
    expect((await call(env, "POST", `/v1/runs/${created.runId}/approval`, { ...base, actorType: "user" })).status).toBe(400);
    expect((await call(env, "POST", `/v1/runs/${created.runId}/approval`, { ...base, actorType: "end-user", approvalToken: "apt_wrong" })).status).toBe(403);
  });

  it("after approval, charges once with a stable local approveUrl; replays return the same order", async () => {
    const { env } = testEnv();
    const created = await createApprovedRun(env);
    const first = await call(env, "POST", `/v1/runs/${created.runId}/charge`, {}, { "Idempotency-Key": "c-1" });
    expect(first.status).toBe(201);
    const charge = (await first.json()) as any;
    expect(charge.state).toBe("awaiting-payment");
    expect(charge.amountMinor).toBe(990);
    expect(new URL(charge.approveUrl).hostname).toBe("localhost");
    expect(charge.approveUrl).not.toContain("paypal");
    expect(charge.paypalOrderId).toBeNull();

    const replay = await call(env, "POST", `/v1/runs/${created.runId}/charge`, {}, { "Idempotency-Key": "c-1" });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as any).approveUrl).toBe(charge.approveUrl);

    const otherKey = await call(env, "POST", `/v1/runs/${created.runId}/charge`, {}, { "Idempotency-Key": "c-2" });
    expect(otherKey.status).toBe(200);
    const again = (await otherKey.json()) as any;
    expect(again.chargeId).toBe(charge.chargeId);
    expect(again.approveUrl).toBe(charge.approveUrl);
  });

  it("GET run keeps output null and lists all five steps", async () => {
    const { env } = testEnv();
    const created = await createApprovedRun(env);
    const run = (await (await call(env, "GET", `/v1/runs/${created.runId}`)).json()) as any;
    expect(run.state).toBe("awaiting-payment");
    expect(run.output).toBeNull();
    expect(run.steps.map((s: any) => s.name)).toEqual(["approval", "payment", "execute", "verify", "receipt"]);
  });

  it("confirm-return checks return_token and answers with ConfirmResult, no pageState, no capture", async () => {
    const { env } = testEnv();
    const created = await createApprovedRun(env);
    const charge = (await (await call(env, "POST", `/v1/runs/${created.runId}/charge`, {}, { "Idempotency-Key": "c-1" })).json()) as any;
    const bad = await call(env, "POST", "/v1/paypal/confirm-return", { charge_id: charge.chargeId, return_token: "nope" });
    expect(bad.status).toBe(403);
    const both = await call(env, "POST", "/v1/paypal/confirm-return", { charge_id: charge.chargeId, payment_id: "p1", return_token: "x" });
    expect(both.status).toBe(400);
    const good = await call(env, "POST", "/v1/paypal/confirm-return", {
      charge_id: charge.chargeId,
      return_token: await stubReturnToken(env, charge.chargeId),
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as any;
    expect(body).not.toHaveProperty("pageState");
    expect(body.runId).toBe(created.runId);
    expect(body.charge.state).toBe("awaiting-payment");
  });

  it("expires a pending approval lazily: the run becomes cancelled", async () => {
    const { env, raw } = testEnv();
    const created = (await (await call(env, "POST", "/v1/runs", aftersalesBody(), { "Idempotency-Key": "k-exp" })).json()) as any;
    raw.prepare("UPDATE stub_runs SET approval_expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(created.runId);
    const run = (await (await call(env, "GET", `/v1/runs/${created.runId}`)).json()) as any;
    expect(run.state).toBe("cancelled");
    const receipt = (await (await call(env, "GET", `/v1/runs/${created.runId}/receipt`)).json()) as any;
    expect(receipt.chargeOutcome).toBe("none");
  });

  it("answers receipt-not-ready before a terminal state", async () => {
    const { env } = testEnv();
    const created = await createApprovedRun(env);
    const res = await call(env, "GET", `/v1/runs/${created.runId}/receipt`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("receipt-not-ready");
  });
});
