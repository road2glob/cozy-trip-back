// @vitest-environment happy-dom
// The 24 task scenarios from section 8 of PRODUCT_LOGIC_HANDOFF_20261105.md, each through the real tool
// wrapper over an in-memory MCP client and checked twice: in the text a host without cards gets, and in
// the card a person sees. Run one with: npx vitest run -t "S13". Scenarios that also depend on a real
// model, host, calendar or PayPal say so in docs/ACCEPTANCE_RESULT_20261105.md; this file only proves the
// parts CozyTrip itself controls. Successful payments here are explicit fake fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createServerFactory } from "../src/mcp/server";
import { AGENT_INSTRUCTIONS } from "../src/mcp/instructions";
import { payRoutes } from "../src/routes/pay";
import { getRun, getSettlement } from "../src/paymentService";
import { fixtureRead, fixtureWrite } from "../stub/complete";
import { cardFor, type CardAction } from "../ui/views";
import { render, type UiState } from "../ui/render";
import { testEnv, toolCtx } from "./helpers/env";
import type { Env } from "../src/env";

vi.mock("agents/mcp/server", () => ({ getMcpAuthContext: () => ({ props: { userId: "usr_test", tokenId: "tok_test", requestId: "req_test" } }) }));

const LABEL = "CozyTrip Demo / 样本行程";
const FIRST_IMPORT = Date.parse("2026-11-01T21:00:00Z");
const count = (raw: any, sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);

type Result = { content: Array<{ text: string }>; structuredContent: any; isError?: boolean };
const textOf = (r: Result) => r.content.map((c) => c.text).join("\n");
const sc = (r: Result) => r.structuredContent;
const steps = (r: Result) => sc(r).guidance.next_steps as Array<{ tool: string; args: any; when: string; needs_confirmation: boolean; card_action?: string }>;
const tools = (r: Result) => steps(r).map((s) => s.tool);

let root: HTMLElement;
const pressed: CardAction[] = [];
const ui = (checkouts: UiState["checkouts"] = {}): UiState => ({ busy: false, notice: null, now: Date.now(), checkouts });

/** What a person sees and can press. Details stay out of "visible" because they start shut. */
function card(result: Result, state: UiState = ui()) {
  render(root, cardFor(result.structuredContent), { run: (a) => pressed.push(a), openCheckout: () => {} }, state);
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details:not([open])").forEach((d) => d.remove());
  return {
    all: root.textContent ?? "",
    visible: clone.textContent ?? "",
    buttons: [...root.querySelectorAll("button")].map((b) => b.textContent ?? ""),
  };
}

const INTERNAL = /\brun_[A-Za-z0-9]|\bchg_|\bapt_|\btrip_[A-Za-z0-9]|\bpay_[A-Za-z0-9]|\bppl_|\bbkg_|confirmation_code|R-[A-Z]+-[A-Z]|create_service_payment|verify_payment|split_status|plan_reminders/;

async function connect(env: Env, caseAvailable = false) {
  const server = createServerFactory(env, caseAvailable, true)();
  const client = new Client({ name: "acceptance", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  sessions.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<Result>,
  };
}
const sessions: Array<() => Promise<void>> = [];

async function imported(call: (n: string, a?: Record<string, unknown>) => Promise<Result>) {
  return sc(await call("import_orders", { mode: "sample" })).trip_id as string;
}
async function confirmImpact(call: (n: string, a?: Record<string, unknown>) => Promise<Result>, trip_id: string) {
  const preview = await call("detect_impact", { trip_id });
  return call("detect_impact", steps(preview)[0].args);
}
async function toOrder(call: (n: string, a?: Record<string, unknown>) => Promise<Result>) {
  const trip_id = await imported(call);
  await confirmImpact(call, trip_id);
  const q = sc(await call("quote_service", { trip_id }));
  const order = await call("create_service_payment", { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code });
  return { trip_id, run_id: q.runId as string, code: q.confirmation_code as string, order };
}
async function markCaptured(env: Env, runId: string) {
  const r = await getRun(env, runId);
  r.state = "running";
  await fixtureWrite(env.DB, runId, { run: r });
}
async function captureShare(env: Env, paymentId: string) {
  const o = await getSettlement(env, paymentId);
  o.state = "captured";
  o.paypalCaptureId = "FAKE-" + paymentId;
  await fixtureWrite(env.DB, "settlement:" + paymentId, o);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FIRST_IMPORT });
  document.body.innerHTML = '<main id="root"></main>';
  root = document.getElementById("root") as HTMLElement;
  pressed.length = 0;
});
afterEach(async () => {
  for (const close of sessions.splice(0)) await close();
  vi.useRealTimers();
});

describe("section 8: task scenarios", () => {
  it("[S1] an empty ledger shows only import", async () => {
    const { env } = testEnv();
    const { client, call } = await connect(env);
    const r = await call("get_status");
    expect(tools(r)).toEqual(["import_orders"]);
    expect(textOf(r)).not.toMatch(/seattle|cancel|9\.90|paypal|usd|split|\$/i);
    const c = card(r);
    expect(c.buttons).toEqual(["Import sample trip"]);
    expect(c.all).not.toMatch(/seattle|cancel|9\.90|paypal|payment|usd/i);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("delete");
  });

  it("[S2] an existing ledger resumes, with no re-import and no new order", async () => {
    const { env, raw } = testEnv();
    const first = await connect(env);
    const { trip_id, run_id, code, order } = await toOrder(first.call);
    const chargeId = sc(order).chargeId;

    const later = await connect(env);
    const status = await later.call("get_status");
    expect(tools(status)).not.toContain("import_orders");
    expect(steps(status)[0]).toMatchObject({ tool: "verify_payment", args: { trip_id, run_id } });
    expect(textOf(status)).toContain("No verified capture yet.");
    expect(card(status).buttons[0]).toBe("Check again");

    const again = await later.call("import_orders", { mode: "sample" });
    expect(sc(again)).toMatchObject({ trip_id, replay: true });
    expect(steps(again)[0].tool).toBe("get_status");
    expect(sc(await later.call("create_service_payment", { trip_id, run_id, confirmation_code: code })).chargeId).toBe(chargeId);
    expect(count(raw, "SELECT count(*) AS n FROM trips")).toBe(1);
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(1);
  });

  it("[S3] an order check only reports no problem and needs no payment", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const r = await call("reconcile_trip", { trip_id });
    expect(sc(r).reconciled).toBe(true);
    expect(textOf(r)).toContain("No mismatch and no payment is needed.");
    expect(tools(r)).not.toContain("quote_service");
    const c = card(r);
    expect(c.all).toContain("No mismatch. No payment is needed");
    expect(c.buttons).toEqual([]);
    // Coming back later: the bookings are readable without importing again.
    const back = await call("get_status", { trip_id });
    expect(sc(back).trips[0].bookings.map((b: any) => b.local_start)).toEqual(["2026-11-08T08:00", "2026-11-08", "2026-11-08", "2026-11-10T14:00"]);
    expect(textOf(back)).toContain("- Sample Bay Cruise: 2026-11-10T14:00, confirmed, USD 126.00.");
    expect(count(raw, "SELECT count(*) AS n FROM service_orders")).toBe(0);
    expect(count(raw, "SELECT count(*) AS n FROM payments")).toBe(0);
  });

  it("[S4] splitting works alone, with nothing bought and no issue simulated", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const q = await call("quote_split", { trip_id });
    expect(q.isError).toBeUndefined();
    const created = await call("create_split_payments", steps(q)[0].args);
    expect(sc(created).payments).toHaveLength(2);
    expect(JSON.stringify(sc(created).guidance)).not.toContain("quote_service");
    expect(count(raw, "SELECT count(*) AS n FROM service_orders")).toBe(0);
    expect(raw.prepare("SELECT state FROM demo_events").get()).toEqual({ state: "armed" });
  });

  it("[S5] an impact preview changes nothing; confirming records it with complete evidence labels", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const preview = await call("detect_impact", { trip_id });
    expect(raw.prepare("SELECT state FROM demo_events").get()).toEqual({ state: "armed" });
    expect(count(raw, "SELECT count(*) AS n FROM impact_assessments")).toBe(0);
    expect(textOf(preview)).toContain("Nothing has changed.");
    expect(textOf(preview)).toContain("no real flight is cancelled");
    expect(card(preview).all).toContain("Nothing has changed.");
    expect(card(preview).all).toContain("no real flight is cancelled");

    const done = await call("detect_impact", steps(preview)[0].args);
    expect(raw.prepare("SELECT state FROM demo_events").get()).toEqual({ state: "fired" });
    expect(sc(done).receipt).toMatchObject({ chargeOutcome: "none", amountMinor: 0 });
    for (const i of sc(done).impacts) {
      expect(i.evidence && i.provenance && i.rule && i.title).toBeTruthy();
      expect(textOf(done)).toContain(i.title);
      expect(textOf(done)).toContain(i.provenance);
    }
    const c = card(done);
    expect(c.all).toContain("Inferred.");
    expect(c.all).toContain("Simulated.");
    expect(c.all).toContain("From the booking.");
    expect(c.all).toContain("No airline was contacted.");
  });

  it("[S6] options can be the end: nothing pushes toward paying", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    await confirmImpact(call, trip_id);
    const r = await call("plan_options", { trip_id });
    expect(sc(r).guidance.fact).toContain("The person can stop here");
    expect(JSON.stringify(sc(r))).not.toMatch(/approveUrl|paypalOrderId|confirmation_code/);
    const c = card(r);
    expect(c.visible).toContain("You can stop here.");
    expect(c.visible.match(/Cost unknown/g)).toHaveLength(2);
    expect(textOf(r).match(/Cost unknown\./g)).toHaveLength(2);
    expect(root.querySelector("button")?.className).toContain("btn-secondary");
    expect(root.querySelector(".btn-primary")).toBeNull();
    expect(count(raw, "SELECT count(*) AS n FROM service_orders")).toBe(0);
  });

  it("[S7] an unconfirmed quote has no order; confirming twice reuses the same one", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    await confirmImpact(call, trip_id);
    const q = await call("quote_service", { trip_id });
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(0);
    expect(sc(q)).not.toHaveProperty("approveUrl");
    expect(steps(q)[0]).toMatchObject({ tool: "create_service_payment", needs_confirmation: true });
    expect(card(q).visible).toContain("Not paid. No PayPal order exists until you confirm.");
    expect(card(q).visible).toContain("Not a rebooking or hotel fee, and no refund is guaranteed.");
    expect(textOf(q)).toContain("not a rebooking or hotel fee, and it does not guarantee a refund");
    const a = await call("create_service_payment", steps(q)[0].args);
    const b = await call("create_service_payment", steps(q)[0].args);
    expect(sc(b).chargeId).toBe(sc(a).chargeId);
    expect(sc(b).replay).toBe(true);
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(1);
  });

  it("[S9] the return and cancel pages never guess: only the service's answer can say nothing was charged", async () => {
    const { env } = testEnv();
    const live = { ...env, TASKPASS_TRANSPORT: "binding", TASKPASS: { fetch: async () => { throw new Error("unreachable"); } } } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>().route("/pay", payRoutes);
    const page = async (path: string) => (await app.fetch(new Request(`http://localhost:8788${path}`), live)).text();
    for (const path of ["/pay/return", "/pay/cancel", "/pay/cancel?charge_id=chg_x&return_token=t", "/pay/return?charge_id=chg_x&return_token=t"]) {
      const html = await page(path);
      expect(html).toContain("has not confirmed a capture");
      expect(html).not.toMatch(/nothing was charged|verified|refunded/i);
    }
  });

  it("[S9] a timeout or crash is never reported as no charge", async () => {
    const { env } = testEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = await connect({ ...env, DB: { prepare: () => { throw new Error("timeout"); } } } as unknown as Env);
    const r = await call("verify_payment", { trip_id: "trip_x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("No verified result yet.");
    expect(textOf(r)).not.toMatch(/nothing was charged/i);
    expect(tools(r)).toEqual(["get_status"]);
    const c = card(r);
    expect(c.visible).toContain("no verified result yet");
    expect(c.visible).not.toMatch(/nothing was charged/i);
    vi.restoreAllMocks();
  });

  it("[S10] a captured order with no output finishes delivery, and repeats do not charge or deliver twice", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const { trip_id, run_id } = await toOrder(call);
    await markCaptured(env, run_id);
    const a = await call("verify_payment", { trip_id, run_id });
    const b = await call("verify_payment", { trip_id, run_id });
    expect(sc(a).paid).toBe(true);
    expect(sc(b).output).toEqual(sc(a).output);
    expect((await fixtureRead<any>(env.DB, run_id)).submissions).toBe(1);
    expect(count(raw, "SELECT count(*) AS n FROM stub_charges")).toBe(1);
    expect(count(raw, "SELECT count(*) AS n FROM deliveries")).toBe(1);
  });

  it("[S11] drafts appear only on passed + captured; an AI failure falls back without claiming AI or sending", async () => {
    const { env } = testEnv({ AI: { run: async () => { throw new Error("model down"); } } as unknown as Ai });
    const { call } = await connect(env);
    const { trip_id, run_id } = await toOrder(call);
    const pending = await call("verify_payment", { trip_id, run_id });
    expect(sc(pending).output).toBeNull();
    expect(JSON.stringify(sc(pending))).not.toContain("materials");
    expect(card(pending).all).not.toContain("Your three drafts");

    await markCaptured(env, run_id);
    const done = await call("verify_payment", { trip_id, run_id });
    expect(sc(done).draftingMethod).toBe("template");
    expect(sc(done).receipt).toMatchObject({ verificationState: "passed", chargeOutcome: "captured" });
    expect(textOf(done).match(/Draft\. Not sent\./g)!.length).toBeGreaterThanOrEqual(3);
    // The part a person reads. The next-step lines below it legitimately name the submitted_by_user status.
    const said = textOf(done).split("\nNow: ")[0];
    expect(said).toContain("Airline contact points");
    expect(said).not.toMatch(/\bAI\b|was sent|has been sent|submitted/i);
    const c = card(done);
    expect(c.all.match(/Draft\. Not sent\./g)).toHaveLength(3);
    expect(c.all).toContain("Payment verified.");
    expect(c.all).not.toMatch(/\bAI\b/);
    // The merchants are fictional, so nothing nudges the person to contact them.
    expect(c.all).toContain("nothing needs sending");
    expect(said).toContain("nothing needs sending");
    expect(c.all + said).not.toMatch(/only you can send/i);
  });

  it("[S12] splitting makes exactly two USD 60 orders, none for Maya, reuses them, and never a service charge", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const q = await call("quote_split", { trip_id });
    const a = await call("create_split_payments", steps(q)[0].args);
    const b = await call("create_split_payments", steps(q)[0].args);
    expect(sc(a).payments.map((p: any) => [p.name, p.display_amount])).toEqual([["Leo", "USD 60.00"], ["Ava", "USD 60.00"]]);
    expect(sc(b).payments.map((p: any) => p.payment_id)).toEqual(sc(a).payments.map((p: any) => p.payment_id));
    expect(count(raw, "SELECT count(*) AS n FROM payments")).toBe(2);
    expect(count(raw, "SELECT count(*) AS n FROM sqlite_master WHERE name='stub_charges'")).toBe(0);
    expect(sc(a).organizer).toMatchObject({ name: "Maya", due_minor: 0, prompt: false });
    expect(textOf(a)).toContain("Maya: USD 0.00 due; no payment order.");
    const c = card(a, ui({ [`share:${sc(a).payments[0].payment_id}`]: { phase: "fallback" }, [`share:${sc(a).payments[1].payment_id}`]: { phase: "fallback" } }));
    expect(c.buttons).toHaveLength(2);
    expect(c.all).not.toContain("Maya's share");
    expect(c.all).toContain("Pays the CozyTrip Team sandbox merchant, not Maya");
    expect(c.all).toContain("Sandbox demo, not a real person-to-person transfer.");
    expect(c.all).toContain("CozyTrip sends nothing to anyone.");
    expect(sc(a).guidance.fact).toContain("CozyTrip sends nothing to anyone");
  });

  it("[S13] one paid share loses its entry and the other keeps it; when all are paid there are none", async () => {
    const { env } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const q = await call("quote_split", { trip_id });
    const [leo, ava] = sc(await call("create_split_payments", steps(q)[0].args)).payments;
    const checkouts = { [`share:${leo.payment_id}`]: { phase: "fallback" as const }, [`share:${ava.payment_id}`]: { phase: "fallback" as const } };

    await captureShare(env, leo.payment_id);
    const one = await call("split_status", { trip_id });
    expect(textOf(one)).toContain("Leo: USD 60.00, captured — no payment prompt");
    expect(textOf(one)).toContain("Ava: USD 60.00, awaiting-payment — payment pending");
    expect(sc(one).payments[0]).not.toHaveProperty("approveUrl");
    expect(sc(one).payments[0]).not.toHaveProperty("paypalOrderId");
    expect(card(one, ui(checkouts)).buttons).toHaveLength(1);

    await captureShare(env, ava.payment_id);
    const all = await call("split_status", { trip_id });
    expect(sc(all).guidance.next_steps).toEqual([]);
    expect(textOf(all)).toContain("no payment entry remains");
    const c = card(all);
    expect(c.buttons).toEqual([]);
    expect(c.all).toContain("All shares paid");
  });

  it("[S14] nothing is submitted, approved or refunded without the person's report, and stages cannot be skipped", async () => {
    const { env } = testEnv();
    const first = await connect(env);
    const { trip_id, run_id } = await toOrder(first.call);
    await markCaptured(env, run_id);
    const delivered = await first.call("verify_payment", { trip_id, run_id });
    expect(sc(delivered).trackingState).toBe("prepared");
    expect(steps(delivered)[0].card_action).toBeUndefined();
    const dc = card(delivered);
    expect(dc.buttons).toEqual([]);
    expect(dc.all).not.toMatch(/submitted|approved|refunded/i);

    const { call } = await connect(env, true);
    const skipped = await call("update_case_status", { trip_id, run_id, status: "merchant_responded", note: "Reply" });
    expect(sc(skipped).error.code).toBe("invalid_transition");
    const preview = await call("update_case_status", { trip_id, run_id, status: "submitted_by_user" });
    expect(sc(await call("get_status", { trip_id })).service_orders[0].trackingState).toBe("prepared");
    const recorded = await call("update_case_status", steps(preview)[0].args);
    expect(sc(recorded)).toMatchObject({ trackingState: "submitted_by_user", provenance: "user-reported" });
    expect(textOf(recorded)).toContain("No merchant action was performed by CozyTrip.");
    expect(card(recorded).all).toContain("From your own report");
  });

  it("[S15] the words a person uses map to tools, and they never need a tool name or a code", async () => {
    const { env } = testEnv();
    const { call } = await connect(env);
    const { trip_id, run_id, order } = await toOrder(call);
    // "Paid" and "I'm back" after a service order
    const fee = steps(order)[0];
    expect(fee).toMatchObject({ tool: "verify_payment", args: { trip_id, run_id } });
    expect(fee.when).toMatch(/paid, came back/);
    expect(AGENT_INSTRUCTIONS).toContain("verify_payment for a service fee, split_status for member shares");
    expect(AGENT_INSTRUCTIONS).toContain("never ask the user to remember tool names, internal IDs or confirmation codes");
    // "Paid" and "who has not paid" after a split
    const q = await call("quote_split", { trip_id });
    const created = await call("create_split_payments", steps(q)[0].args);
    expect(steps(created)[0]).toMatchObject({ tool: "split_status", args: { trip_id } });
    expect(steps(created)[0].when).toMatch(/who has not paid/);
    // Reused arguments are complete, so the agent never has to ask the person for anything.
    expect(steps(q)[0].args.confirmation_code).toBe(sc(q).confirmation_code);
    // Cards never show a code, and pressing a button sends the exact call.
    const c = card(q);
    expect(c.all).not.toContain(sc(q).confirmation_code);
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(pressed[0]).toMatchObject({ tool: "create_split_payments", args: steps(q)[0].args });
  });

  it("[S16] without a token nothing is read, and the rules say so to the agent", async () => {
    const { env } = testEnv();
    const { authenticate } = await import("../src/mcp/auth");
    expect(await authenticate(new Request("http://localhost:8788/mcp", { method: "POST" }), env)).toBeNull();
    expect(AGENT_INSTRUCTIONS).toContain("Do not claim real-order parsing, inbox access, live airline monitoring or real merchant actions.");
  });

  it("[S17] a real order gets an accurate statement of scope, and nothing is imported", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const r = await call("import_orders", { mode: "text", text: "My real booking confirmation" });
    expect(sc(r).error.code).toBe("model_not_enabled");
    expect(textOf(r)).toContain("cannot read real orders or an inbox");
    expect(tools(r)).toEqual(["import_orders"]);
    expect(count(raw, "SELECT count(*) AS n FROM trips")).toBe(0);
    const c = card(r);
    expect(c.visible).toContain("It cannot read real orders or an inbox.");
    expect(c.buttons).toEqual(["Import sample trip"]);
  });

  it("[S18] a stated intent can go straight through: no welcome and no required order of steps", async () => {
    const { env } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    expect(AGENT_INSTRUCTIONS).toContain("Continue the user's stated intent after connection. Do not restart onboarding for an existing trip.");
    expect((await call("quote_split", { trip_id })).isError).toBeUndefined();
    expect((await call("reconcile_trip", { trip_id })).isError).toBeUndefined();
    expect((await call("detect_impact", { trip_id })).isError).toBeUndefined();
    expect((await call("plan_reminders", { trip_id })).isError).toBeUndefined();
    const status = await call("get_status", { trip_id });
    expect(tools(status)).not.toContain("import_orders");
    expect(textOf(status)).not.toMatch(/welcome|get started/i);
  });

  it("[S19] nothing is written before agreement; no tool, or a failed write, is reported as not set", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const preview = await call("plan_reminders", { trip_id });
    expect(sc(preview)).not.toHaveProperty("writes");
    expect(steps(preview)[0].when).toContain("If it has none, keep the plan and say the reminders are not set");
    expect(card(preview).visible).toContain("A plan only. Nothing is in your calendar yet.");
    expect(sc(await call("record_reminder_results", { trip_id, results: [{ key: "x", outcome: "created", external_event_id: "e" }] })).error.code).toBe("confirmation_required");
    expect(count(raw, "SELECT count(*) AS n FROM reminder_events")).toBe(0);

    const agreed = await call("plan_reminders", steps(preview)[0].args);
    expect(textOf(agreed)).toContain("If this host has no calendar tool, make no report and tell the person the reminders are not set");
    expect(sc(await call("get_status", { trip_id })).reminders).toEqual({ written: 0, failed: 0 });

    const keys = sc(agreed).writes.map((w: any) => w.key);
    const partial = await call("record_reminder_results", {
      plan_id: sc(agreed).plan_id,
      trip_id,
      results: [
        { key: keys[0], outcome: "created", external_event_id: "evt_1" },
        { key: keys[1], outcome: "failed", detail: "Read-only calendar" },
      ],
    });
    expect(textOf(partial)).toContain("1 set, 1 failed and not set");
    const c = card(partial);
    expect(c.all).toContain("Set");
    expect(c.all).toContain("Not set");
    expect(c.all).toContain("Read-only calendar");
    expect(sc(await call("get_status", { trip_id })).reminders).toEqual({ written: 1, failed: 1 });
  });

  it("[S20] lead times, time zone, date precision and past reminders are handled, and retries do not duplicate", async () => {
    const { env, raw } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const plan = await call("plan_reminders", { trip_id });
    const items = sc(plan).reminders;
    expect(items.map((i: any) => i.lead)).toEqual(["3 days before departure", "The day before", "The day before", "2 hours before"]);
    expect(items.filter((i: any) => i.lead === "2 hours before").map((i: any) => i.what)).toEqual(["Sample Bay Cruise in 2 hours"]);
    expect(items[0]).toMatchObject({ timezone: "America/Los_Angeles", display_when: "Nov 5, 09:00", display_beijing: "Nov 6, 01:00" });
    expect(textOf(plan)).toContain("Beijing Nov 6, 01:00");
    expect(card(plan).visible).toContain("Nov 5, 09:00 · Beijing Nov 6, 01:00");

    const agreed = await call("plan_reminders", steps(plan)[0].args);
    const results = sc(agreed).writes.map((w: any) => ({ key: w.key, outcome: "created", external_event_id: `evt_${w.key}` }));
    await call("record_reminder_results", { plan_id: sc(agreed).plan_id, trip_id, results });
    await call("record_reminder_results", { plan_id: sc(agreed).plan_id, trip_id, results });
    expect(count(raw, "SELECT count(*) AS n FROM reminder_events")).toBe(4);
    expect(sc(await call("plan_reminders", { trip_id })).writes).toEqual([]);

    vi.setSystemTime(Date.parse("2026-11-06T12:00:00Z"));
    const later = sc(await call("plan_reminders", { trip_id }));
    expect(later.reminders.every((i: any) => Date.parse(i.start_utc) > Date.now())).toBe(true);
    expect(later.notes.join(" ")).toContain("already in the past and skipped");
    expect(later.removals).toEqual([]);
  });

  it("[S21] when shares are paid the reminder stops, and only CozyTrip's own entry is touched", async () => {
    const { env } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const q = await call("quote_split", { trip_id });
    const [leo, ava] = sc(await call("create_split_payments", steps(q)[0].args)).payments;
    const plan = await call("plan_reminders", { trip_id });
    const agreed = await call("plan_reminders", steps(plan)[0].args);
    await call("record_reminder_results", { plan_id: sc(agreed).plan_id, trip_id, results: sc(agreed).writes.map((w: any) => ({ key: w.key, outcome: "created", external_event_id: `evt_${w.key}` })) });
    await captureShare(env, leo.payment_id);
    await captureShare(env, ava.payment_id);
    const paid = await call("split_status", { trip_id });
    expect(tools(paid)).toEqual(["plan_reminders"]);
    const stop = await call("plan_reminders", { trip_id });
    expect(card(stop).visible).toContain("To remove from your calendar:");
    const second = await call("plan_reminders", steps(stop)[0].args);
    expect(sc(second).writes).toEqual([expect.objectContaining({ op: "remove", key: "unpaid-shares", external_event_id: "evt_unpaid-shares" })]);
    // A key CozyTrip did not plan is refused, so nothing else in a calendar can be claimed.
    const foreign = await call("record_reminder_results", { plan_id: sc(second).plan_id, trip_id, results: [{ key: "someone-elses-event", outcome: "removed" }] });
    expect(sc(foreign).rejected).toEqual([{ key: "someone-elses-event", reason: "not_in_agreed_plan" }]);
  });

  it("[S22] every entry has the sample label and a way back in words, with no promise of watching", async () => {
    const { env } = testEnv();
    const { call } = await connect(env);
    const trip_id = await imported(call);
    const plan = await call("plan_reminders", { trip_id });
    const agreed = await call("plan_reminders", steps(plan)[0].args);
    for (const w of sc(agreed).writes) {
      expect(w.title.startsWith(`${LABEL}: `)).toBe(true);
      expect(w.description).toContain("Fictional CozyTrip sample, not a real booking.");
      expect(w.description).toContain("go back to your AI chat and say: check my CozyTrip sample trip");
    }
    const done = await call("record_reminder_results", { plan_id: sc(agreed).plan_id, trip_id, results: [{ key: sc(agreed).writes[0].key, outcome: "created", external_event_id: "e" }] });
    const everything = [textOf(plan), textOf(agreed), textOf(done), card(plan).all, card(done).all].join("\n");
    expect(everything).not.toMatch(/one[- ]click|tap to return|we will monitor|automatically (notify|remind|check)|in the background/i);
    expect(card(done).all).toContain("CozyTrip does not watch your calendar.");
  });

  it("[S23] a new sample during judging has future dates; an old trip and its paid records do not move", async () => {
    const { env, raw } = testEnv();
    const judge = await connect(env);
    const old = await toOrder(judge.call);
    await markCaptured(env, old.run_id);
    await judge.call("verify_payment", { trip_id: old.trip_id, run_id: old.run_id });
    const before = raw.prepare("SELECT start_date,end_date FROM trips WHERE trip_id=?").get(old.trip_id);
    const bookingsBefore = raw.prepare("SELECT local_start FROM bookings WHERE trip_id=? ORDER BY sort_order").all(old.trip_id);

    vi.setSystemTime(Date.parse("2026-12-14T03:00:00Z"));
    expect(raw.prepare("SELECT start_date,end_date FROM trips WHERE trip_id=?").get(old.trip_id)).toEqual(before);
    expect(sc(await judge.call("import_orders", { mode: "sample" })).start_date).toBe((before as any).start_date);
    expect(raw.prepare("SELECT local_start FROM bookings WHERE trip_id=? ORDER BY sort_order").all(old.trip_id)).toEqual(bookingsBefore);
    expect(sc(await judge.call("verify_payment", { trip_id: old.trip_id, run_id: old.run_id })).paid).toBe(true);

    const fresh = await import("../src/tools/importOrders");
    const late = (await fresh.run(toolCtx(env, "usr_late_judge"), { mode: "sample" })) as Result;
    expect(sc(late).start_date).toBe("2026-12-20");
    const planTool = await import("../src/tools/planReminders");
    const plan = (await planTool.run(toolCtx(env, "usr_late_judge"), { trip_id: sc(late).trip_id })) as Result;
    expect(sc(plan).reminders).toHaveLength(4);
    expect(sc(plan).reminders.every((i: any) => Date.parse(i.start_utc) > Date.now())).toBe(true);
  });

  it("[S24] every card keeps to its one job: original palette, at most two actions, no IDs or tool names showing", async () => {
    const { env } = testEnv();
    const first = await connect(env);
    const results: Result[] = [await first.call("get_status")];
    const { trip_id, run_id } = await (async () => {
      const t = await first.call("import_orders", { mode: "sample" });
      results.push(t, await first.call("reconcile_trip", { trip_id: sc(t).trip_id }), await first.call("plan_reminders", { trip_id: sc(t).trip_id }));
      const preview = await first.call("detect_impact", { trip_id: sc(t).trip_id });
      results.push(preview, await first.call("detect_impact", steps(preview)[0].args), await first.call("plan_options", { trip_id: sc(t).trip_id }));
      const q = await first.call("quote_service", { trip_id: sc(t).trip_id });
      results.push(q);
      results.push(await first.call("create_service_payment", steps(q)[0].args));
      return { trip_id: sc(t).trip_id, run_id: sc(q).runId };
    })();
    results.push(await first.call("verify_payment", { trip_id, run_id }), await first.call("get_status", { trip_id }));
    await markCaptured(env, run_id);
    const delivered = await first.call("verify_payment", { trip_id, run_id });
    results.push(delivered, await first.call("get_status", { trip_id }));
    const sq = await first.call("quote_split", { trip_id });
    results.push(sq, await first.call("create_split_payments", steps(sq)[0].args));
    const withCase = await connect(env, true);
    const cp = await withCase.call("update_case_status", { trip_id, run_id, status: "submitted_by_user" });
    results.push(cp, await withCase.call("update_case_status", steps(cp)[0].args));

    for (const r of results) {
      const c = card(r);
      expect(cardFor(r.structuredContent).kind).not.toBe("unknown");
      expect(c.visible, c.visible).not.toMatch(INTERNAL);
      expect(c.visible, c.visible).not.toMatch(/\bApproved\b|\barmed\b/);
      // Each share's own control is a separate action; everything else stays at one main and one quiet.
      if (cardFor(r.structuredContent).kind !== "split") expect(c.buttons.length).toBeLessThanOrEqual(2);
      expect(root.querySelectorAll(".btn-primary").length).toBeLessThanOrEqual(1);
      expect([...root.querySelectorAll(".steps")].every((s) => s.closest("details:not([open])"))).toBe(true);
    }

    const css = readFileSync(join(process.cwd(), "ui/cards.css"), "utf8");
    for (const color of ["#6b55e8", "#17151f", "#686577", "#f5efe0"]) expect(css).toContain(color);
    expect(css).not.toContain("0e6e66");
  });
});

describe("how the scenarios in other test files map", () => {
  it("[S8] and more of [S9] run against the real card code with a fake host and SDK in test/paypal-card.test.ts", () => {
    const source = readFileSync(join(process.cwd(), "test/paypal-card.test.ts"), "utf8");
    expect(source).toContain("[S8]");
    expect(source).toContain("[S9]");
  });
});
