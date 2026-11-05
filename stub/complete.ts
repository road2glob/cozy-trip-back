// Deterministic offline contract fixtures. Never calls PayPal; successful paid states require explicit test seeding.
import type { Env } from "../src/env";
import type {
  Run,
  Receipt,
  SettlementOrder,
} from "../src/paymentService/types";
import { safeEqual, sha256Hex, canonicalJson, hmacHex } from "./crypto";
interface Entry {
  run: Run;
  receipt?: Receipt;
  submissions?: number;
}
export async function fixtureSchema(db: D1Database) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS stub_complete(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
  );
}
export async function fixtureRead<T>(
  db: D1Database,
  id: string,
): Promise<T | null> {
  await fixtureSchema(db);
  const r = await db
    .prepare("SELECT data FROM stub_complete WHERE id=?1")
    .bind(id)
    .first<{ data: string }>();
  return r ? JSON.parse(r.data) : null;
}
export async function fixtureWrite(db: D1Database, id: string, data: unknown) {
  await fixtureSchema(db);
  await db
    .prepare(
      "INSERT INTO stub_complete(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    )
    .bind(id, JSON.stringify(data))
    .run();
}
const error = (code: string, status = 409) =>
  Response.json({ error: { code, message: code } }, { status });
export async function completeFetch(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (
    !env.TASKPASS_PRODUCT_TOKEN ||
    !(await safeEqual(
      request.headers.get("Authorization") ?? "",
      "Bearer " + env.TASKPASS_PRODUCT_TOKEN,
    ))
  )
    return error("unauthorized", 401);
  const path = new URL(request.url).pathname;
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      body = (await request.clone().json()) as Record<string, unknown>;
    } catch {
      return error("invalid-json", 400);
    }
  }
  if (
    request.method === "POST" &&
    path === "/v1/runs" &&
    ["cozytrip.issue.assess", "cozytrip.split.calculate"].includes(
      String(body.workflowId),
    )
  ) {
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.length > 64) return error("idempotency-key-required", 400);
    const digest = await sha256Hex(canonicalJson(body));
    const old = await fixtureRead<{ digest: string; response: unknown }>(
      env.DB,
      "idem:" + key,
    );
    if (old)
      return old.digest === digest
        ? Response.json(old.response, { status: 201 })
        : error("idempotency-conflict");
    const input = body.input as Record<string, unknown>;
    if (
      !input ||
      typeof input.tripId !== "string" ||
      typeof body.subjectId !== "string"
    )
      return error("invalid-input", 400);
    const runId = "run_stub_" + (await sha256Hex(key)).slice(0, 20);
    const now = new Date().toISOString();
    const r: Run = {
      schemaVersion: "20261104",
      mode: "sandbox",
      runId,
      workflowId: String(body.workflowId),
      workflowVersion: "stub-complete-1",
      productId: "cozytrip",
      subjectId: body.subjectId,
      idempotencyKey: key,
      input,
      inputDigest: digest,
      state: "running",
      steps: [],
      output: null,
      outputDigest: null,
      approvalId: null,
      chargeId: null,
      verificationId: null,
      receiptId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const response = {
      schemaVersion: "20261104",
      mode: "sandbox",
      runId,
      state: "running",
      approval: null,
      chargeId: null,
      output: null,
    };
    await fixtureWrite(env.DB, runId, { run: r });
    await fixtureWrite(env.DB, "idem:" + key, { digest, response });
    return Response.json(response, { status: 201 });
  }
  const m = path.match(
    /^\/v1\/runs\/([^/]+)(?:\/(output|receipt|charge\/reconcile))?$/,
  );
  if (m) {
    const entry = await fixtureRead<Entry>(env.DB, m[1]);
    if (entry) {
      if (request.method === "GET" && !m[2])
        return Response.json({
          ...entry.run,
          output: entry.run.state === "verified" ? entry.run.output : null,
        });
      if (request.method === "GET" && m[2] === "receipt")
        return entry.receipt
          ? Response.json(entry.receipt)
          : error("receipt-not-ready");
      if (request.method === "POST" && m[2] === "charge/reconcile")
        return Response.json({
          runId: m[1],
          state: entry.run.state,
          charge: {
            state:
              entry.run.state === "running" ? "captured" : "awaiting-payment",
          },
        });
      if (request.method === "POST" && m[2] === "output") {
        if (entry.run.state !== "running")
          return entry.receipt
            ? Response.json({
                runId: m[1],
                state: entry.run.state,
                verification: { state: entry.receipt.verificationState },
              })
            : error("payment-required");
        const o = body.output as Record<string, unknown>;
        let passed = !!o;
        if (entry.run.workflowId === "cozytrip.issue.assess")
          passed =
            passed &&
            Array.isArray(o.affectedBookingIds) &&
            (o.affectedBookingIds as string[]).every((id) =>
              (entry.run.input.bookingIds as string[]).includes(id),
            );
        if (entry.run.workflowId === "cozytrip.split.calculate") {
          const shares = o.shares as {
            participantId: string;
            amountMinor: number;
          }[];
          passed =
            passed &&
            Array.isArray(shares) &&
            shares.length === 3 &&
            new Set(shares.map((s) => s.participantId)).size === 3 &&
            shares.every(
              (s) =>
                (entry.run.input.participantIds as string[]).includes(
                  s.participantId,
                ) && s.amountMinor === 6000,
            ) &&
            o.totalMinor === 18000 &&
            entry.run.input.totalMinor === 18000;
        }
        if (entry.run.workflowId === "cozytrip.aftersales.deliver")
          passed =
            passed &&
            o.trackingState === "prepared" &&
            Array.isArray(o.materials) &&
            o.materials.length > 0 &&
            !/(已退款|已向航司提交|already refunded)/i.test(JSON.stringify(o));
        entry.run.state = passed ? "verified" : "failed";
        entry.run.output = passed ? o : null;
        entry.submissions = (entry.submissions ?? 0) + 1;
        const paid = entry.run.workflowId === "cozytrip.aftersales.deliver";
        entry.receipt = {
          receiptId: "receipt_" + m[1],
          runId: m[1],
          state: "issued",
          verificationState: passed ? "passed" : "failed",
          chargeOutcome: paid
            ? passed
              ? "captured"
              : "refund-required"
            : "none",
          chargeId: entry.run.chargeId,
          amountMinor: paid ? 990 : 0,
          currency: "USD",
          inputDigest: entry.run.inputDigest,
          outputDigest: await sha256Hex(canonicalJson(o)),
          reason: paid ? null : "price-zero",
          issuedAt: new Date().toISOString(),
          mode: "sandbox",
        };
        await fixtureWrite(env.DB, m[1], entry);
        return Response.json({
          runId: m[1],
          state: entry.run.state,
          verification: { state: passed ? "passed" : "failed" },
        });
      }
    }
  }
  if (path === "/v1/settlement-orders" && request.method === "POST") {
    if (body.amountMinor !== 6000 || typeof body.paymentId !== "string")
      return error("invalid-settlement-input", 400);
    const existing = await fixtureRead<SettlementOrder>(
      env.DB,
      "settlement:" + body.paymentId,
    );
    if (existing) return Response.json(existing);
    const o: SettlementOrder = {
      paymentId: body.paymentId,
      amountMinor: 6000,
      currency: "USD",
      mode: "sandbox",
      state: "awaiting-payment",
      paypalOrderId: "STUB-" + body.paymentId,
      paypalCaptureId: null,
      paypalRequestId: body.paymentId,
      approveUrl:
        env.PUBLIC_RETURN_ORIGIN + "/__stub/settlement/" + body.paymentId,
      disclaimer:
        "Sandbox demo: funds go to a sandbox account, not a real person-to-person transfer.",
    };
    await fixtureWrite(env.DB, "settlement:" + body.paymentId, o);
    return Response.json(o, { status: 201 });
  }
  const s = path.match(/^\/v1\/settlement-orders\/([^/]+)(?:\/reconcile)?$/);
  if (s) {
    const o = await fixtureRead<SettlementOrder>(env.DB, "settlement:" + s[1]);
    return o ? Response.json(o) : error("not-found", 404);
  }
  if (
    (path === "/v1/paypal/confirm-return" ||
      path === "/v1/paypal/confirm-cancel") &&
    body.payment_id &&
    body.charge_id
  )
    return error("invalid-request", 400);
  if (
    ["/v1/paypal/confirm-return", "/v1/paypal/confirm-cancel"].includes(path) &&
    typeof body.payment_id === "string"
  ) {
    const o = await fixtureRead<SettlementOrder>(
      env.DB,
      "settlement:" + body.payment_id,
    );
    if (!o) return error("not-found", 404);
    const expected = (
      await hmacHex(
        env.TASKPASS_PRODUCT_TOKEN,
        "settlement-return:" + body.payment_id,
      )
    ).slice(0, 32);
    if (
      typeof body.return_token !== "string" ||
      !(await safeEqual(body.return_token, expected))
    )
      return error("forbidden", 403);
    if (path.endsWith("confirm-cancel") && o.state === "awaiting-payment") {
      o.state = "void";
      await fixtureWrite(env.DB, "settlement:" + body.payment_id, o);
    }
    return Response.json(o);
  }
  return null;
}
