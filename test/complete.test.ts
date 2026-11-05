import * as splitCheck from "../src/tools/splitStatus";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as detect from "../src/tools/detectImpact";
import * as verify from "../src/tools/verifyPayment";
import * as split from "../src/tools/quoteSplit";
import * as createSplit from "../src/tools/createSplitPayments";
import * as updateCase from "../src/tools/updateCaseStatus";
import * as plan from "../src/tools/planOptions";
import * as reconcile from "../src/tools/reconcileTrip";
import * as imports from "../src/tools/importOrders";
import * as quote from "../src/tools/quoteService";
import * as pay from "../src/tools/createServicePayment";
import * as status from "../src/tools/getStatus";
import { draftMaterials } from "../src/domain/materials";
import { getTripDetail } from "../src/domain/trips";
import { getRun, getSettlement } from "../src/paymentService";
import { fixtureRead, fixtureWrite } from "../stub/complete";
import { testEnv, toolCtx } from "./helpers/env";
const sc = (r: any) => r.structuredContent as any;
async function trip(ctx: any) {
  return sc(await imports.run(ctx, { mode: "sample" })).trip_id as string;
}
async function impact(ctx: any, t: string) {
  const p = sc(await detect.run(ctx, { trip_id: t }));
  return detect.run(ctx, {
    trip_id: t,
    confirmation_code: p.confirmation_code,
  });
}
async function payable(ctx: any) {
  const t = await trip(ctx);
  await impact(ctx, t);
  const q = sc(await quote.run(ctx, { trip_id: t }));
  await pay.run(ctx, {
    trip_id: t,
    run_id: q.runId,
    confirmation_code: q.confirmation_code,
  });
  return { t, q };
}
async function paidFixture(ctx: any, runId: string) {
  const r = await getRun(ctx.env, runId);
  r.state = "running";
  await fixtureWrite(ctx.env.DB, runId, { run: r });
}
afterEach(() => vi.useRealTimers());
describe("complete flow safety and delivery", () => {
  it("new user has only import entry, no payment/case data", async () => {
    const { env } = testEnv();
    const r = await status.run(toolCtx(env), {});
    expect(sc(r).available_actions).toEqual(["import_orders"]);
    expect(JSON.stringify(r)).not.toMatch(
      /approveUrl|update_case_status|materials/,
    );
  });
  it("missing trips never create payment or state", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    for (const mod of [detect, split, plan, reconcile])
      expect((await mod.run(ctx, { trip_id: "missing" })).isError).toBe(true);
    expect(
      (await verify.run(ctx, { trip_id: "missing", run_id: "missing" }))
        .isError,
    ).toBe(true);
  });
  it("impact preview changes no event, booking, trip, or run", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const before = raw.prepare("SELECT state FROM trips").get();
    const p = sc(await detect.run(ctx, { trip_id: t }));
    expect(p.preview).toBe(true);
    expect(p.impacts.map((b: any) => b.status)).toEqual([
      "disrupted",
      "at_risk",
      "disrupted",
      "unaffected",
    ]);
    expect(raw.prepare("SELECT state FROM trips").get()).toEqual(before);
    expect(raw.prepare("SELECT state FROM demo_events").get()).toEqual({
      state: "armed",
    });
    expect(
      raw.prepare("SELECT count(*) n FROM impact_assessments").get(),
    ).toEqual({ n: 0 });
    expect(
      raw
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='stub_complete'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
  it("no confirmed anomaly means no paid purchase entry", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const r = await quote.run(ctx, { trip_id: t });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/approveUrl|confirmation_code/);
  });
  it("wrong/expired and cross-user confirmations do not trigger the event", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    expect(
      (await detect.run(ctx, { trip_id: t, confirmation_code: "bad" })).isError,
    ).toBe(true);
    const p = sc(await detect.run(ctx, { trip_id: t }));
    expect(
      (
        await detect.run(toolCtx(env, "usr_other"), {
          trip_id: t,
          confirmation_code: p.confirmation_code,
        })
      ).isError,
    ).toBe(true);
    expect((await getTripDetail(env.DB, ctx.userId, t))!.demoEvent!.state).toBe(
      "armed",
    );
  });
  it("confirmed impact is zero price, evidence-based and idempotent", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const a = sc(await impact(ctx, t)),
      b = sc(await detect.run(ctx, { trip_id: t }));
    expect(a.receipt).toMatchObject({
      verificationState: "passed",
      chargeOutcome: "none",
      amountMinor: 0,
    });
    expect(b.runId).toBe(a.runId);
    expect(
      a.impacts.every((b: any) => b.rule && b.evidence && b.provenance),
    ).toBe(true);
    expect((await getTripDetail(env.DB, ctx.userId, t))!.demoEvent!.state).toBe(
      "fired",
    );
  });
  it("reconciliation detects ledger mismatches without payment", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    expect(sc(await reconcile.run(ctx, { trip_id: t })).total_minor).toBe(
      149100,
    );
    raw.prepare("UPDATE expenses SET amount_minor=amount_minor+1").run();
    expect(sc(await reconcile.run(ctx, { trip_id: t })).error.code).toBe(
      "ledger_mismatch",
    );
  });
  it("recovery options use unknown market prices and never include buy links", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    expect((await plan.run(ctx, { trip_id: t })).isError).toBe(true);
    await impact(ctx, t);
    const r = await plan.run(ctx, { trip_id: t });
    expect(sc(r).options).toHaveLength(3);
    expect(sc(r).options[0].cost_minor).toBeNull();
    expect(sc(r).options[2].cost_minor).toBe(990);
    expect(JSON.stringify(r)).not.toContain("approveUrl");
  });
  it("without quote or confirmation no payment link is returned", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    expect(sc(await verify.run(ctx, { trip_id: t })).error.code).toBe(
      "quote_required",
    );
    await impact(ctx, t);
    const q = sc(await quote.run(ctx, { trip_id: t }));
    expect(
      sc(await pay.run(ctx, { trip_id: t, run_id: q.runId })).error.code,
    ).toBe("confirmation_required");
  });
  it("pending capture never generates or exposes materials", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env),
      { t, q } = await payable(ctx);
    const r = await verify.run(ctx, { trip_id: t, run_id: q.runId });
    expect(sc(r)).toMatchObject({ paid: false, output: null });
    expect(raw.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
      n: 0,
    });
    expect(JSON.stringify(await status.run(ctx, { trip_id: t }))).not.toContain(
      "update_case_status",
    );
  });
  it("paid delivery submits once, exposes only passed+captured, and replays safely", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      { t, q } = await payable(ctx);
    await paidFixture(ctx, q.runId);
    const a = sc(await verify.run(ctx, { trip_id: t, run_id: q.runId }));
    const b = sc(await verify.run(ctx, { trip_id: t, run_id: q.runId }));
    expect(a.receipt).toMatchObject({
      verificationState: "passed",
      chargeOutcome: "captured",
    });
    expect(a.output.materials).toHaveLength(3);
    expect(
      a.output.materials.every((m: any) => m.text.includes("Draft. Not sent.")),
    ).toBe(true);
    expect(b.output).toEqual(a.output);
    expect((await fixtureRead<any>(env.DB, q.runId)).submissions).toBe(1);
  });
  it("concurrent verify attempts cannot duplicate output submission", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      { t, q } = await payable(ctx);
    await paidFixture(ctx, q.runId);
    await Promise.all([
      verify.run(ctx, { trip_id: t, run_id: q.runId }),
      verify.run(ctx, { trip_id: t, run_id: q.runId }),
    ]);
    expect((await fixtureRead<any>(env.DB, q.runId)).submissions).toBe(1);
  });
  it("verification failure displays refund-required and hides output", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      { t, q } = await payable(ctx);
    await paidFixture(ctx, q.runId);
    await env.DB.prepare(
      "INSERT INTO deliveries(run_id,user_id,trip_id,output_json,drafting_method,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
    )
      .bind(
        q.runId,
        ctx.userId,
        t,
        JSON.stringify({
          serviceOrderId: "x",
          trackingState: "prepared",
          materials: [{ kind: "x", text: "已退款" }],
        }),
        "test",
        new Date().toISOString(),
      )
      .run();
    const r = await verify.run(ctx, { trip_id: t, run_id: q.runId });
    expect(r.isError).toBe(true);
    expect(sc(r).error).toMatchObject({
      output: null,
      code: "refund_required",
    });
    expect(sc(r).error.receipt.chargeOutcome).toBe("refund-required");
  });
  it("case tracking is unavailable before paid verified delivery", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      { t, q } = await payable(ctx);
    expect(
      sc(
        await updateCase.run(ctx, {
          trip_id: t,
          run_id: q.runId,
          status: "submitted_by_user",
        }),
      ).error.code,
    ).toBe("delivery_required");
  });
  it("case preview never marks submitted; exact confirmation advances user-reported stages", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      { t, q } = await payable(ctx);
    await paidFixture(ctx, q.runId);
    await verify.run(ctx, { trip_id: t, run_id: q.runId });
    const args = {
      trip_id: t,
      run_id: q.runId,
      status: "submitted_by_user" as const,
    };
    const p = sc(await updateCase.run(ctx, args));
    expect(p.preview).toBe(true);
    expect(
      sc(await status.run(ctx, { trip_id: t })).service_orders[0].trackingState,
    ).toBe("prepared");
    expect(
      (await updateCase.run(ctx, { ...args, confirmation_code: "bad" }))
        .isError,
    ).toBe(true);
    expect(
      sc(
        await updateCase.run(ctx, {
          ...args,
          confirmation_code: p.confirmation_code,
        }),
      ),
    ).toMatchObject({
      trackingState: "submitted_by_user",
      provenance: "user-reported",
    });
    expect(sc(await updateCase.run(ctx, args)).replay).toBe(true);
    expect(
      (
        await updateCase.run(ctx, {
          ...args,
          status: "merchant_responded",
          note: "Reply received",
        })
      ).isError,
    ).toBe(true);
  });
  it("Workers AI prose is used with deterministic facts and source amounts", async () => {
    const { env } = testEnv({
      AI: {
        run: vi.fn(async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  "Please explain available flight options and the conditions before I decide.",
                  "Please explain hotel date change options and applicable terms.",
                  "Please explain pickup rescheduling and cruise change terms if necessary.",
                ]),
              },
            },
          ],
        })),
      } as unknown as Ai,
    });
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const result = await draftMaterials(
      env,
      (await getTripDetail(env.DB, ctx.userId, t))!,
      "service",
    );
    expect(result.method).toBe("workers-ai");
    expect(result.output.materials[0].text).toContain("USD 645.00");
  });
  it("accepts the parsed response array returned by the live Workers AI binding", async () => {
    const prose = [
      "Please explain available flight options and the conditions before I decide.",
      "Please explain hotel date change options and applicable terms.",
      "Please explain pickup rescheduling and cruise change terms if necessary.",
    ];
    const { env } = testEnv({ AI: { run: vi.fn(async () => ({ response: prose, choices: [{message: {content: JSON.stringify(prose)}}] })) } as unknown as Ai });
    const ctx = toolCtx(env), t = await trip(ctx);
    const result = await draftMaterials(env, (await getTripDetail(env.DB, ctx.userId, t))!, "service");
    expect(result.method).toBe("workers-ai");
    expect(result.output.materials[0].text).toContain(prose[0]);
    expect(result.output.materials.every(m => m.text.endsWith("Draft. Not sent."))).toBe(true);
  });
  it("unsafe AI claims and invented numbers fall back to templates", async () => {
    const { env } = testEnv({
      AI: {
        run: vi.fn(async () => ({
          response: JSON.stringify([
            "Already refunded USD 999",
            "Approved",
            "Submitted",
          ]),
        })),
      } as unknown as Ai,
    });
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const result = await draftMaterials(
      env,
      (await getTripDetail(env.DB, ctx.userId, t))!,
      "service",
    );
    expect(result.method).toBe("template");
    expect(JSON.stringify(result)).not.toContain("999");
  });
  it("AI timeout falls back within its twelve-second budget", async () => {
    const { env } = testEnv({
      AI: { run: () => new Promise(() => {}) } as unknown as Ai,
    });
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const d = (await getTripDetail(env.DB, ctx.userId, t))!;
    vi.useFakeTimers();
    const pending = draftMaterials(env, d, "service");
    await vi.advanceTimersByTimeAsync(12000);
    expect((await pending).method).toBe("template");
  });
});
describe("AA split merchant settlements", () => {
  it("free quote has three equal shares, Maya due zero and no payment link", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const r = sc(await split.run(ctx, { trip_id: t }));
    expect(
      r.shares.map((s: any) => [s.name, s.share_minor, s.due_minor]),
    ).toEqual([
      ["Maya", 6000, 0],
      ["Leo", 6000, 6000],
      ["Ava", 6000, 6000],
    ]);
    expect(r.receipt).toMatchObject({ chargeOutcome: "none", amountMinor: 0 });
    expect(JSON.stringify(r)).not.toContain("approveUrl");
    expect(raw.prepare("SELECT count(*) n FROM payments").get()).toEqual({
      n: 0,
    });
  });
  it("requires split quote and valid local confirmation before orders", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    expect(sc(await createSplit.run(ctx, { trip_id: t })).error.code).toBe(
      "quote_required",
    );
    await split.run(ctx, { trip_id: t });
    expect(sc(await createSplit.run(ctx, { trip_id: t })).error.code).toBe(
      "confirmation_required",
    );
    expect(
      sc(await createSplit.run(ctx, { trip_id: t, confirmation_code: "bad" }))
        .error.code,
    ).toBe("invalid_confirmation_code");
  });
  it("creates exactly two orders and replays them without service Charge", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const q = sc(await split.run(ctx, { trip_id: t }));
    const a = sc(
        await createSplit.run(ctx, {
          trip_id: t,
          confirmation_code: q.confirmation_code,
        }),
      ),
      b = sc(
        await createSplit.run(ctx, {
          trip_id: t,
          confirmation_code: q.confirmation_code,
        }),
      );
    expect(a.payments.map((p: any) => p.name)).toEqual(["Leo", "Ava"]);
    expect(a.organizer).toEqual({ name: "Maya", due_minor: 0, prompt: false });
    expect(b.payments.map((p: any) => p.payment_id)).toEqual(
      a.payments.map((p: any) => p.payment_id),
    );
    expect(raw.prepare("SELECT count(*) n FROM payments").get()).toEqual({
      n: 2,
    });
    expect(
      raw
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='stub_charges'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
  it("paid members lose payment links and prompts, while repeated status stays paid", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const q = sc(await split.run(ctx, { trip_id: t }));
    const a = sc(
      await createSplit.run(ctx, {
        trip_id: t,
        confirmation_code: q.confirmation_code,
      }),
    );
    for (const p of a.payments) {
      const order = await getSettlement(env, p.payment_id);
      order.state = "captured";
      order.paypalCaptureId = "FAKE-" + p.payment_id;
      await fixtureWrite(env.DB, "settlement:" + p.payment_id, order);
    }
    for (let i = 0; i < 2; i++) {
      const result = sc(await status.run(ctx, { trip_id: t }));
      expect(
        result.split_payments.every(
          (p: any) => p.state === "captured" && !p.prompt && !p.approveUrl,
        ),
      ).toBe(true);
    }
  });
  it("another user cannot read, create or confirm this split", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env),
      t = await trip(ctx);
    const q = sc(await split.run(ctx, { trip_id: t }));
    expect(
      (
        await createSplit.run(toolCtx(env, "usr_other"), {
          trip_id: t,
          confirmation_code: q.confirmation_code,
        })
      ).isError,
    ).toBe(true);
  });
});

it("split_status refreshes only existing orders and never creates new ones", async () => {
  const { env, raw } = testEnv();
  const ctx = toolCtx(env),
    t = await trip(ctx);
  expect(sc(await splitCheck.run(ctx, { trip_id: t })).payments).toEqual([]);
  const q = sc(await split.run(ctx, { trip_id: t }));
  const a = sc(
    await createSplit.run(ctx, {
      trip_id: t,
      confirmation_code: q.confirmation_code,
    }),
  );
  const result = sc(await splitCheck.run(ctx, { trip_id: t }));
  expect(result.payments.map((p: any) => p.payment_id)).toEqual(
    a.payments.map((p: any) => p.payment_id),
  );
  expect(raw.prepare("SELECT count(*) n FROM payments").get()).toEqual({
    n: 2,
  });
});
it("local confirmation expires without firing the event", async () => {
  const { env } = testEnv();
  const ctx = toolCtx(env),
    t = await trip(ctx);
  const p = sc(await detect.run(ctx, { trip_id: t }));
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31 * 60000);
  expect(
    sc(
      await detect.run(ctx, {
        trip_id: t,
        confirmation_code: p.confirmation_code,
      }),
    ).error.code,
  ).toBe("invalid_confirmation_code");
  expect((await getTripDetail(env.DB, ctx.userId, t))!.demoEvent!.state).toBe(
    "armed",
  );
});
it("merchant stages stay user-reported and require evidence for a refund-arrival claim", async () => {
  const { env } = testEnv();
  const ctx = toolCtx(env),
    { t, q } = await payable(ctx);
  await paidFixture(ctx, q.runId);
  await verify.run(ctx, { trip_id: t, run_id: q.runId });
  for (const state of ["submitted_by_user", "awaiting_merchant"] as const) {
    const args = { trip_id: t, run_id: q.runId, status: state };
    const p = sc(await updateCase.run(ctx, args));
    expect(
      sc(
        await updateCase.run(ctx, {
          ...args,
          confirmation_code: p.confirmation_code,
        }),
      ).trackingState,
    ).toBe(state);
  }
  const args = {
    trip_id: t,
    run_id: q.runId,
    status: "merchant_responded" as const,
    note: "Refund received in my account",
  };
  expect(sc(await updateCase.run(ctx, args)).error.code).toBe(
    "evidence_required",
  );
  const p = sc(
    await updateCase.run(ctx, {
      ...args,
      evidence: "User supplied bank statement reference",
    }),
  );
  const result = sc(
    await updateCase.run(ctx, {
      ...args,
      evidence: "User supplied bank statement reference",
      confirmation_code: p.confirmation_code,
    }),
  );
  expect(result).toMatchObject({
    trackingState: "merchant_responded",
    provenance: "user-reported",
  });
  expect(
    sc(await status.run(ctx, { trip_id: t })).service_orders[0].report
      .provenance,
  ).toBe("user-reported");
});

it("AA checks source expense total rather than assuming a hard-coded amount", async () => {
  const { env, raw } = testEnv();
  const ctx = toolCtx(env),
    t = await trip(ctx);
  raw
    .prepare(
      "UPDATE expenses SET amount_minor=19000 WHERE booking_id IN (SELECT booking_id FROM bookings WHERE kind='transfer')",
    )
    .run();
  expect(sc(await split.run(ctx, { trip_id: t })).error.code).toBe(
    "ledger_mismatch",
  );
});
