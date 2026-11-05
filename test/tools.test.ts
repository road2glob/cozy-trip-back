import * as detectImpact from '../src/tools/detectImpact';
import { describe, expect, it } from "vitest";
import * as getStatus from "../src/tools/getStatus";
import * as importOrders from "../src/tools/importOrders";
import * as quoteService from "../src/tools/quoteService";
import * as createServicePayment from "../src/tools/createServicePayment";
import { STUB_NOTICE, REAL_SANDBOX_NOTICE } from "../src/tools/common";
import { testEnv, toolCtx } from "./helpers/env";

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");
const count = (raw: ReturnType<typeof testEnv>["raw"], sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);

describe("phase 1 tool flow (stub transport)", () => {
  it("a new token starts empty: no trips, no Seattle, no price, no PayPal, no split, zero runs", async () => {
    const { env } = testEnv();
    const r = await getStatus.run(toolCtx(env), {});
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ trips: [], runs: [], run_count: 0, split_payments: [], available_actions:["import_orders"] });
    expect(text(r)).not.toMatch(/seattle|paypal|usd|\$|9\.90|split/i);
  });

  it("quote_service before any import returns no confirmation_code and no link", async () => {
    const { env } = testEnv();
    const r = await quoteService.run(toolCtx(env), { trip_id: "trip_missing" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/confirmation_code"|approveUrl/);
  });

  it("imports the Seattle–San Francisco sample once; a second import returns the same trip_id; no runs", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const first = await importOrders.run(ctx, { mode: "sample" });
    const sc = first.structuredContent as any;
    expect(sc.demo_event).toBe("armed");
    expect(sc.reality).toBe("fictional_sample");
    expect(sc.provenance).toBe("source");
    expect(sc.participants.map((p: any) => p.name)).toEqual(["Maya", "Leo", "Ava"]);
    expect(sc.bookings.map((b: any) => b.amount_minor)).toEqual([64500, 54000, 18000, 12600]);
    expect(sc.total_minor).toBe(149100);
    expect(sc.balances.map((b: any) => [b.from, b.to, b.amount_minor])).toEqual([
      ["Leo", "Maya", 6000],
      ["Ava", "Maya", 6000],
    ]);
    expect(text(first)).toContain("Simulated travel data.");

    const second = await importOrders.run(ctx, { mode: "sample" });
    expect((second.structuredContent as any).trip_id).toBe(sc.trip_id);
    expect((second.structuredContent as any).replay).toBe(true);
    expect(count(raw, "SELECT count(*) AS n FROM trips")).toBe(1);
    expect(count(raw, "SELECT count(*) AS n FROM service_orders")).toBe(0);

    const status = await getStatus.run(ctx, {});
    expect((status.structuredContent as any).run_count).toBe(0);
    expect((status.structuredContent as any).trips[0].trip_id).toBe(sc.trip_id);
  });

  it("mode text is not enabled", async () => {
    const { env } = testEnv();
    const r = await importOrders.run(toolCtx(env), { mode: "text", text: "anything" });
    expect((r.structuredContent as any).error.code).toBe("model_not_enabled");
  });

  it("quote, then pay: approval token as confirmation_code, stub approveUrl, no capture, replay keeps one order", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const tripId = (((await importOrders.run(ctx, { mode: "sample" })).structuredContent) as any).trip_id;

    const preview=(await detectImpact.run(ctx,{trip_id:tripId})).structuredContent as any; await detectImpact.run(ctx,{trip_id:tripId,confirmation_code:preview.confirmation_code});
    const quote = await quoteService.run(ctx, { trip_id: tripId });
    const q = quote.structuredContent as any;
    expect(quote.isError).toBeUndefined();
    expect(q.price.amountMinor).toBe(990);
    expect(q.codeKind).toBe("approval");
    expect(q.output).toBeNull();
    expect(q).not.toHaveProperty("approveUrl");
    expect(text(quote)).toContain("USD 9.90");
    expect(text(quote)).not.toContain("http");
    const stubRun = raw.prepare("SELECT approval_token, approval_expires_at, subject_id FROM stub_runs WHERE run_id = ?").get(q.runId) as any;
    expect(q.confirmation_code).toBe(stubRun.approval_token);
    expect(q.expires_at).toBe(stubRun.approval_expires_at);
    expect(stubRun.subject_id).toBe(ctx.userId);
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(0);

    const requote = await quoteService.run(ctx, { trip_id: tripId });
    expect((requote.structuredContent as any).runId).toBe(q.runId);
    expect((requote.structuredContent as any).confirmation_code).toBe(q.confirmation_code);

    const noCode = await createServicePayment.run(ctx, { trip_id: tripId, run_id: q.runId });
    expect((noCode.structuredContent as any).error.code).toBe("confirmation_required");
    expect(JSON.stringify(noCode)).not.toContain("approveUrl");

    const wrong = await createServicePayment.run(ctx, { trip_id: tripId, run_id: q.runId, confirmation_code: "apt_wrong" });
    expect((wrong.structuredContent as any).error.code).toBe("invalid_confirmation_code");
    expect((wrong.structuredContent as any).error.http_status).toBe(403);
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(0);

    const paid = await createServicePayment.run(ctx, { trip_id: tripId, run_id: q.runId, confirmation_code: q.confirmation_code });
    const p = paid.structuredContent as any;
    expect(paid.isError).toBeUndefined();
    expect(p.state).toBe("awaiting-payment");
    expect(p.reality).toBe("local_stub");
    expect(new URL(p.approveUrl).hostname).toBe("localhost");
    expect(text(paid)).toContain(p.approveUrl);
    expect(text(paid)).toContain(STUB_NOTICE);
    expect(text(paid)).not.toContain(REAL_SANDBOX_NOTICE);
    const approved = raw.prepare("SELECT approval_state, actor_ref FROM stub_runs WHERE run_id = ?").get(q.runId) as any;
    expect(approved).toEqual({ approval_state: "approved", actor_ref: ctx.userId });

    const again = await createServicePayment.run(ctx, { trip_id: tripId, run_id: q.runId, confirmation_code: q.confirmation_code });
    expect((again.structuredContent as any).approveUrl).toBe(p.approveUrl);
    expect((again.structuredContent as any).chargeId).toBe(p.chargeId);
    expect((again.structuredContent as any).replay).toBe(true);
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(1);

    const status = await getStatus.run(ctx, { trip_id: tripId });
    const run = (status.structuredContent as any).runs[0];
    expect(run.state).toBe("awaiting-payment");
    expect(run.steps).toHaveLength(5);
    expect(run).not.toHaveProperty("chargeOutcome");
  });

  it("an expired confirmation code does not create an order", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const tripId = (((await importOrders.run(ctx, { mode: "sample" })).structuredContent) as any).trip_id;
    const preview=(await detectImpact.run(ctx,{trip_id:tripId})).structuredContent as any; await detectImpact.run(ctx,{trip_id:tripId,confirmation_code:preview.confirmation_code});
    const q = (await quoteService.run(ctx, { trip_id: tripId })).structuredContent as any;
    raw.prepare("UPDATE service_orders SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    raw.prepare("UPDATE stub_runs SET approval_expires_at = '2000-01-01T00:00:00.000Z'").run();
    const r = await createServicePayment.run(ctx, { trip_id: tripId, run_id: q.runId, confirmation_code: q.confirmation_code });
    expect((r.structuredContent as any).error.code).toBe("approval_expired");
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(0);
    const fresh = (await quoteService.run(ctx, { trip_id: tripId })).structuredContent as any;
    expect(fresh.runId).not.toBe(q.runId);
  });

  it("another user is another empty ledger and cannot see or pay this trip", async () => {
    const { env } = testEnv();
    const tripId = (((await importOrders.run(toolCtx(env, "usr_a"), { mode: "sample" })).structuredContent) as any).trip_id;
    const other = toolCtx(env, "usr_b");
    expect((await getStatus.run(other, {})).structuredContent).toMatchObject({ trips: [], runs: [], run_count: 0, split_payments: [], available_actions:["import_orders"] });
    expect(((await getStatus.run(other, { trip_id: tripId })).structuredContent as any).error.code).toBe("not_found");
    expect(((await quoteService.run(other, { trip_id: tripId })).structuredContent as any).error.code).toBe("not_found");
  });
});
