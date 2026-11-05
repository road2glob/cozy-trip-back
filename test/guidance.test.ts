import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServerFactory } from "../src/mcp/server";
import { AGENT_CONTRACT } from "../src/mcp/instructions";
import * as status from "../src/tools/getStatus";
import * as imports from "../src/tools/importOrders";
import * as reconcile from "../src/tools/reconcileTrip";
import * as detect from "../src/tools/detectImpact";
import * as options from "../src/tools/planOptions";
import * as quote from "../src/tools/quoteService";
import * as pay from "../src/tools/createServicePayment";
import * as verify from "../src/tools/verifyPayment";
import * as split from "../src/tools/quoteSplit";
import * as createSplit from "../src/tools/createSplitPayments";
import * as splitCheck from "../src/tools/splitStatus";
import * as updateCase from "../src/tools/updateCaseStatus";
import { getRun, getSettlement } from "../src/paymentService";
import { fixtureRead, fixtureWrite } from "../stub/complete";
import { testEnv, toolCtx } from "./helpers/env";
import type { Env } from "../src/env";

vi.mock("agents/mcp/server", () => ({ getMcpAuthContext: () => ({ props: { userId: "usr_test", tokenId: "tok_test", requestId: "req_test" } }) }));

const sc = (r: any) => r.structuredContent as any;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const tools = (r: any) => sc(r).guidance.next_steps.map((s: any) => s.tool);
const buttons = (r: any) => sc(r).guidance.next_steps.filter((s: any) => s.card_action).map((s: any) => s.card_action);

async function connected(env: Env) {
  const server = createServerFactory(env)();
  const client = new Client({ name: "guidance-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function imported(ctx: any) {
  return sc(await imports.run(ctx, { mode: "sample" })).trip_id as string;
}
async function confirmedImpact(ctx: any, trip_id: string) {
  const p = sc(await detect.run(ctx, { trip_id }));
  return detect.run(ctx, { trip_id, confirmation_code: p.confirmation_code });
}
async function ordered(ctx: any) {
  const trip_id = await imported(ctx);
  await confirmedImpact(ctx, trip_id);
  const q = sc(await quote.run(ctx, { trip_id }));
  await pay.run(ctx, { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code });
  return { trip_id, run_id: q.runId as string, code: q.confirmation_code as string };
}
async function setRun(ctx: any, runId: string, state: string) {
  const r = await getRun(ctx.env, runId);
  r.state = state as never;
  await fixtureWrite(ctx.env.DB, runId, { run: r });
}
async function delivered(ctx: any) {
  const o = await ordered(ctx);
  await setRun(ctx, o.run_id, "running");
  return { ...o, result: await verify.run(ctx, { trip_id: o.trip_id, run_id: o.run_id }) };
}
async function capture(ctx: any, paymentId: string) {
  const order = await getSettlement(ctx.env, paymentId);
  order.state = "captured";
  order.paypalCaptureId = "FAKE-" + paymentId;
  await fixtureWrite(ctx.env.DB, "settlement:" + paymentId, order);
}

afterEach(() => vi.restoreAllMocks());

describe("what the host is told when it connects", () => {
  it("initialize carries the agent contract word for word, within the 2 KB some hosts keep", async () => {
    const { env } = testEnv();
    const { client, close } = await connected(env);
    try {
      const instructions = client.getInstructions() ?? "";
      // A separate copy of section 3 of the product handoff, so losing a rule from the source fails here.
      const handoff = [
        "CozyTrip's default entry is organizing a trip and proposing important-node reminders.",
        "Issue assistance and expense splitting are independent tasks. Never require buying assistance before splitting.",
        "This competition version supports fictional sample data only. Do not claim real-order parsing, inbox access, live airline monitoring or real merchant actions.",
        "Read get_status before describing or resuming a trip. If empty, offer sample import and wait for the user to choose it.",
        "Continue the user's stated intent after connection. Do not restart onboarding for an existing trip.",
        "Use the user's language. Explain the current fact and one relevant next step; never ask the user to remember tool names, internal IDs or confirmation codes.",
        "Preview a simulated issue before confirmation. Quote paid assistance only when relevant and requested; create its order only after clear confirmation.",
        "Treat “paid”, “I'm back” and equivalent phrases as a request to check the existing order: verify_payment for a service fee, split_status for member shares.",
        "Never infer payment or delivery from a browser return. Deliver only on a passed + captured receipt. Reuse existing orders on retries.",
        "Maya owes zero in the sample. Paid shares have no payment prompt. Sandbox split funds go to the Team merchant, not Maya.",
        "All materials are drafts, not sent. Do not urge users to contact fictional merchants. Record follow-up only from an explicit user report and the required confirmation.",
        "Propose a clearly labeled Demo reminder plan. Use a calendar tool actually available to the host only after user consent; report the actual write result, or explain that reminders are not set.",
        "Never claim a calendar plan is scheduled, a merchant was contacted, a refund arrived, or all host capabilities work without evidence.",
      ];
      expect(AGENT_CONTRACT).toBe(handoff.join("\n"));
      expect(instructions.startsWith(AGENT_CONTRACT)).toBe(true);
      expect(instructions.length).toBeLessThanOrEqual(2048);
    } finally {
      await close();
    }
  });
});

describe("what the agent can read before any trip exists", () => {
  it("no tool description names the sample's city or the service price, so an empty ledger cannot lead with them", async () => {
    const { env } = testEnv();
    const { client, close } = await connected(env);
    try {
      const { tools: listed } = await client.listTools();
      expect(listed.length).toBeGreaterThan(0);
      for (const t of listed) expect(t.description, t.name).not.toMatch(/seattle|san francisco|9\.90/i);
      expect(listed.find((t) => t.name === "import_orders")?.description).not.toMatch(/cancel|inferred preview/i);
    } finally {
      await close();
    }
  });

  it("the import text never says anyone owes Maya, because shares go to the sandbox merchant", async () => {
    const { env } = testEnv();
    const r = await imports.run(toolCtx(env), { mode: "sample" });
    expect(text(r)).toContain("Airport pickup prepaid by Maya: Leo's share USD 60.00, Ava's share USD 60.00.");
    expect(text(r)).not.toMatch(/owes/i);
  });
});

describe("empty ledger and first import", () => {
  it("offers only the sample import and mentions nothing beyond it", async () => {
    const { env } = testEnv();
    const r = await status.run(toolCtx(env), {});
    expect(sc(r).guidance.fact).toBe("CozyTrip is connected. There are no trips yet.");
    expect(tools(r)).toEqual(["import_orders"]);
    expect(sc(r).guidance.next_steps[0]).toMatchObject({ args: { mode: "sample" }, needs_confirmation: true, card_action: "Import sample trip" });
    expect(text(r)).not.toMatch(/seattle|cancel|9\.90|paypal|usd|\$|split|paid/i);
  });

  it("after import states the organized trip and offers no paid step", async () => {
    const { env } = testEnv();
    const r = await imports.run(toolCtx(env), { mode: "sample" });
    expect(sc(r).guidance.fact).toContain("4 bookings, 3 travelers, USD 1,491.00. Simulated travel data.");
    expect(tools(r)).not.toContain("quote_service");
    expect(tools(r)).not.toContain("create_service_payment");
    expect(tools(r)).not.toContain("import_orders");
    expect(text(r)).not.toMatch(/armed/i);
    expect(tools(r)[0]).toBe("plan_reminders");
    expect(buttons(r)).toEqual(["See reminder plan"]);
  });

  it("a repeat import never says nothing has happened on a trip that has moved on", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id } = await ordered(ctx);
    const again = await imports.run(ctx, { mode: "sample" });
    expect(sc(again).trip_id).toBe(trip_id);
    expect(text(again)).not.toContain("no payment has started");
    expect(sc(again).run_count).toBe(1);
    expect(sc(again).demo_event).toBe("fired");
  });

  it("a repeat import resumes the existing trip instead of restarting", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const again = await imports.run(ctx, { mode: "sample" });
    expect(sc(again).replay).toBe(true);
    expect(sc(again).guidance.next_steps[0]).toMatchObject({ tool: "get_status", args: { trip_id } });
  });
});

describe("resuming from get_status", () => {
  it("an existing ledger never offers import, and does not push payment when nothing is in progress", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    await imported(ctx);
    const r = await status.run(ctx, {});
    expect(tools(r)).not.toContain("import_orders");
    expect(tools(r)).not.toContain("quote_service");
    expect(tools(r)).not.toContain("create_service_payment");
    expect(tools(r)).toContain("quote_split");
    expect(tools(r)[0]).toBe("plan_reminders");
    expect(buttons(r)).toEqual(["See reminder plan"]);
  });

  it("an unpaid order resumes at the same order, with a check as the main action", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    const r = await status.run(ctx, { trip_id });
    expect(sc(r).guidance.fact).toContain("No verified capture yet.");
    expect(sc(r).guidance.next_steps[0]).toMatchObject({ tool: "verify_payment", args: { trip_id, run_id }, card_action: "Check again" });
    expect(tools(r)).not.toContain("update_case_status");
    expect(JSON.stringify(r)).not.toContain("update_case_status");
  });

  it("a verified run with no receipt yet is still being checked, and is never offered a new quote", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    await setRun(ctx, run_id, "verified");
    const r = await status.run(ctx, { trip_id });
    expect(sc(r).guidance.fact).toContain("still checking the original after-sales order");
    expect(tools(r)).toContain("verify_payment");
    expect(tools(r)).not.toContain("quote_service");
  });

  it("a delivered order offers the drafts and only a chat-side report step", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await delivered(ctx);
    const r = await status.run(ctx, { trip_id });
    expect(sc(r).guidance.fact).toContain("Payment verified. Three drafts are ready. Draft. Not sent.");
    expect(buttons(r)).toContain("View drafts");
    const report = sc(r).guidance.next_steps.find((s: any) => s.tool === "update_case_status");
    expect(report).toMatchObject({ args: { trip_id, run_id, status: "submitted_by_user" }, needs_confirmation: true });
    expect(report.card_action).toBeUndefined();
    expect(tools(r)).not.toContain("create_service_payment");
  });
});

describe("issue flow", () => {
  it("the preview is complete in text and needs the person's agreement to confirm", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await detect.run(ctx, { trip_id });
    const step = sc(r).guidance.next_steps[0];
    expect(step).toMatchObject({ tool: "detect_impact", needs_confirmation: true, args: { trip_id, confirmation_code: sc(r).confirmation_code } });
    expect(text(r)).toContain(sc(r).confirmation_code);
    expect(text(r)).toContain("Sample Air 210 SEA to SFO: disrupted");
    expect(text(r)).toContain("Sample Bay Hotel, 3 nights: at risk");
    expect(text(r)).toContain("Sample Bay Cruise: unaffected");
    expect(text(r)).not.toMatch(/Explicitly confirmed/);
    expect(sc(r).impacts.map((i: any) => i.title)).toContain("Sample Bay Cruise");
    expect(tools(r)).toEqual(["detect_impact"]);
  });

  it("a confirmed issue leads to options, and only a chat request leads to a quote", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await confirmedImpact(ctx, trip_id);
    expect(buttons(r)).toEqual(["See recovery options"]);
    expect(tools(r)).toEqual(["plan_options", "quote_service"]);
    expect(tools(r)).not.toContain("create_service_payment");
    const replay = await detect.run(ctx, { trip_id });
    expect(sc(replay).replay).toBe(true);
    expect(buttons(replay)).toEqual(["See recovery options"]);
  });

  it("options can end there: the fact says so and the amount comes from the server", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    await confirmedImpact(ctx, trip_id);
    const r = await options.run(ctx, { trip_id });
    expect(sc(r).guidance.fact).toContain("The person can stop here");
    expect(sc(r).options.map((o: any) => o.display_cost)).toEqual([null, null, "USD 9.90"]);
    expect(text(r)).toContain("Rebook with the airline");
    expect(text(r)).toContain("USD 9.90");
    expect(tools(r)).toEqual(["quote_service"]);
  });
});

describe("service fee", () => {
  it("the quote needs agreement, carries the code, states scope and creates no order", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    await confirmedImpact(ctx, trip_id);
    const r = await quote.run(ctx, { trip_id });
    const q = sc(r);
    expect(q.guidance.next_steps[0]).toEqual(expect.objectContaining({
      tool: "create_service_payment",
      needs_confirmation: true,
      card_action: "Confirm USD 9.90",
      args: { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code },
    }));
    expect(q.display_amount).toBe("USD 9.90");
    expect(text(r)).toContain("Hotel change request");
    expect(q.guidance.fact).toContain("no PayPal order exists");
    expect((raw.prepare("SELECT count(*) AS n FROM stub_charges").get() as any).n).toBe(0);
  });

  it("quoting again after the order exists leads back to the same order without asking again", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id, code } = await ordered(ctx);
    const r = await quote.run(ctx, { trip_id });
    expect(sc(r).guidance.next_steps[0]).toMatchObject({
      tool: "create_service_payment",
      needs_confirmation: false,
      card_action: "Continue to PayPal",
      args: { trip_id, run_id, confirmation_code: code },
    });
    await pay.run(ctx, sc(r).guidance.next_steps[0].args);
    expect((raw.prepare("SELECT count(*) AS n FROM stub_charges").get() as any).n).toBe(1);
  });

  it("the order result says unpaid and points at the check on the same order", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    await confirmedImpact(ctx, trip_id);
    const q = sc(await quote.run(ctx, { trip_id }));
    const r = await pay.run(ctx, { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code });
    expect(sc(r).guidance.fact).toContain("unpaid");
    expect(sc(r).guidance.next_steps).toEqual([expect.objectContaining({ tool: "verify_payment", args: { trip_id, run_id: q.runId } })]);
    expect(buttons(r)).toEqual([]);
  });

  it("an uncaptured check says the prescribed sentence and offers the same order again", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id, code } = await ordered(ctx);
    const r = await verify.run(ctx, { trip_id, run_id });
    expect(sc(r).paid).toBe(false);
    expect(sc(r).guidance.fact).toContain("No verified capture yet.");
    expect(buttons(r)).toEqual(["Check again", "Back to PayPal"]);
    expect(sc(r).guidance.next_steps[1].args).toEqual({ trip_id, run_id, confirmation_code: code });
  });

  it("while captured payment is being delivered there is no way back to PayPal", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    await setRun(ctx, run_id, "verifying");
    const r = await verify.run(ctx, { trip_id, run_id });
    expect(sc(r).paid).toBe(false);
    expect(sc(r).guidance.fact).toContain("No new payment is needed");
    expect(buttons(r)).toEqual(["Check again"]);
    expect(tools(r)).not.toContain("create_service_payment");
    const s = await status.run(ctx, { trip_id });
    expect(tools(s)).not.toContain("quote_service");
  });

  it("a repeat quote during delivery leads to the check, never back to PayPal", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    raw.prepare("UPDATE service_orders SET run_state='running'").run();
    const r = await quote.run(ctx, { trip_id });
    expect(sc(r).guidance.next_steps).toEqual([expect.objectContaining({ tool: "verify_payment", args: { trip_id, run_id }, card_action: "Check again" })]);
    expect(sc(r).guidance.fact).toContain("No new payment is needed");
  });

  it("repeating the order call after capture returns no payment link or order to pay", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id, code } = await ordered(ctx);
    raw.prepare("UPDATE stub_charges SET created_response=json_set(created_response,'$.state','captured')").run();
    const r = await pay.run(ctx, { trip_id, run_id, confirmation_code: code });
    expect(sc(r)).toMatchObject({ state: "captured", approveUrl: null, paypalOrderId: null, replay: true });
    expect(text(r)).not.toContain("http");
    expect(sc(r).guidance.fact).toContain("no longer waiting for payment");
    expect(buttons(r)).toEqual(["Check again"]);
  });

  it.each([
    ["awaiting-approval", "not confirmed", "quote_service"],
    ["cancelled", "closed", "quote_service"],
  ])("a check on a %s run does not pretend to be waiting on payment", async (state, phrase, tool) => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    await setRun(ctx, run_id, state);
    const r = await verify.run(ctx, { trip_id, run_id });
    expect(sc(r).guidance.fact).toContain(phrase);
    expect(tools(r)).toEqual([tool]);
    expect(buttons(r)).not.toContain("Back to PayPal");
  });

  it("delivery is complete in text: three titled drafts, each not sent, with no payment step", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { result } = await delivered(ctx);
    for (const title of ["Airline contact points", "Hotel change request", "Transfer and cruise change request"]) expect(text(result)).toContain(title);
    expect(text(result).match(/Draft\. Not sent\./g)!.length).toBeGreaterThanOrEqual(3);
    expect(sc(result).output.materials.map((m: any) => m.title)).toHaveLength(3);
    expect(tools(result)).toEqual(["update_case_status"]);
    expect(buttons(result)).toEqual([]);
    expect(JSON.stringify(sc(result).guidance)).not.toMatch(/create_service_payment|quote_service/);
  });

  it("refund-required ends the flow without calling it a refund", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    await setRun(ctx, run_id, "running");
    await env.DB.prepare("INSERT INTO deliveries(run_id,user_id,trip_id,output_json,drafting_method,created_at) VALUES(?1,?2,?3,?4,?5,?6)")
      .bind(run_id, ctx.userId, trip_id, JSON.stringify({ serviceOrderId: "x", trackingState: "prepared", materials: [{ kind: "x", text: "已退款" }] }), "test", new Date().toISOString())
      .run();
    const r = await verify.run(ctx, { trip_id, run_id });
    expect(sc(r).error.code).toBe("refund_required");
    expect(sc(r).guidance.next_steps).toEqual([]);
    expect(sc(r).guidance.end).toContain("Do not say a refund happened");
    expect((await fixtureRead<any>(env.DB, run_id)).receipt.chargeOutcome).toBe("refund-required");
  });
});

describe("split", () => {
  it("the quote needs agreement and states everyone's amount in text", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await split.run(ctx, { trip_id });
    expect(text(r)).toContain("USD 180.00 = USD 60.00 × 3");
    expect(text(r)).toContain("owes USD 0.00");
    expect(sc(r).shares.map((s: any) => [s.name, s.display_due])).toEqual([["Maya", "USD 0.00"], ["Leo", "USD 60.00"], ["Ava", "USD 60.00"]]);
    expect(sc(r).guidance.next_steps).toEqual([
      expect.objectContaining({ tool: "create_split_payments", needs_confirmation: true, card_action: "Confirm split", args: { trip_id, confirmation_code: sc(r).confirmation_code } }),
    ]);
    expect(sc(r).payee_notice).toBe("Pays the CozyTrip Team sandbox merchant, not Maya.");
    expect(tools(r)).not.toContain("quote_service");
  });

  it("unpaid shares lead to a check, one paid share stays visible, and all paid ends the flow", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const q = sc(await split.run(ctx, { trip_id }));
    const created = await createSplit.run(ctx, { trip_id, confirmation_code: q.confirmation_code });
    expect(tools(created)).toEqual(["split_status"]);
    expect(sc(created).guidance.fact).toContain("Leo's share USD 60.00: not paid.");
    expect(sc(created).guidance.fact).toContain("Maya owes USD 0.00.");
    expect(text(created)).toContain(sc(created).payments[0].approveUrl);

    const [leo, ava] = sc(created).payments;
    await capture(ctx, leo.payment_id);
    const one = await splitCheck.run(ctx, { trip_id });
    expect(sc(one).guidance.fact).toContain("Leo's share USD 60.00: paid.");
    expect(sc(one).guidance.fact).toContain("Ava's share USD 60.00: not paid.");
    expect(tools(one)).toEqual(["split_status"]);

    await capture(ctx, ava.payment_id);
    const all = await splitCheck.run(ctx, { trip_id });
    expect(sc(all).guidance.next_steps).toEqual([]);
    expect(sc(all).guidance.end).toContain("no payment entry remains");
    expect(JSON.stringify(sc(all).guidance)).not.toMatch(/create_split_payments|quote_split/);

    const requote = await split.run(ctx, { trip_id });
    expect(tools(requote)).toEqual(["split_status"]);
  });

  it("a create that failed partway reads as unfinished: no crash, and confirming again completes the same request", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const q = sc(await split.run(ctx, { trip_id }));
    // Both rows stuck: as many rows as shares, and still none of them is a finished request.
    for (const name of ["Leo", "Ava"]) {
      const member = (raw.prepare("SELECT participant_id FROM participants WHERE name=?").get(name) as any).participant_id;
      raw.prepare("INSERT INTO payments(payment_id,reference_id,trip_id,participant_id,amount_minor,currency,state,created_at,updated_at,user_id) VALUES(?,?,?,?,6000,'USD','creating','2026-11-01','2026-11-01',?)").run(`pay_stuck_${name}`, `settlement:pay_stuck_${name}`, trip_id, member, ctx.userId);
    }

    const check = await splitCheck.run(ctx, { trip_id });
    expect(check.isError).toBeUndefined();
    expect(sc(check).guidance.fact).toContain("did not finish being created");
    expect(tools(check)).toEqual(["quote_split"]);
    expect((await status.run(ctx, { trip_id })).isError).toBeUndefined();

    const again = await split.run(ctx, { trip_id });
    expect(tools(again)).toEqual(["create_split_payments"]);
    const done = await createSplit.run(ctx, sc(again).guidance.next_steps[0].args);
    expect(sc(done).payments.map((p: any) => p.payment_id)).toEqual(["pay_stuck_Leo", "pay_stuck_Ava"]);
    expect(sc(done).payments.every((p: any) => p.state === "awaiting-payment")).toBe(true);
    expect((raw.prepare("SELECT count(*) AS n FROM payments").get() as any).n).toBe(2);
    expect(q.confirmation_code).toBeTruthy();
  });

  it.each(["failed", "void"])("a %s share is not reported as if everything were paid", async (state) => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const q = sc(await split.run(ctx, { trip_id }));
    const [leo, ava] = sc(await createSplit.run(ctx, { trip_id, confirmation_code: q.confirmation_code })).payments;
    await capture(ctx, leo.payment_id);
    const order = await getSettlement(env, ava.payment_id);
    order.state = state as never;
    await fixtureWrite(env.DB, "settlement:" + ava.payment_id, order);
    const r = await splitCheck.run(ctx, { trip_id });
    expect(sc(r).guidance.end).toContain("Ava: this request closed without a verified payment");
    expect(sc(r).guidance.end).not.toContain("no payment entry remains");
  });

  it("checking before any split offers the free quote and creates nothing", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await splitCheck.run(ctx, { trip_id });
    expect(tools(r)).toEqual(["quote_split"]);
    expect((raw.prepare("SELECT count(*) AS n FROM payments").get() as any).n).toBe(0);
  });
});

describe("user-reported follow-up", () => {
  it("the preview hands back status, note and evidence with the code, and that exact call succeeds", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await delivered(ctx);
    for (const status of ["submitted_by_user", "awaiting_merchant"] as const) {
      const p = await updateCase.run(ctx, { trip_id, run_id, status });
      await updateCase.run(ctx, sc(p).guidance.next_steps[0].args);
    }
    const note = "Refund received in my account";
    const evidence = "User supplied bank statement reference";
    const p = await updateCase.run(ctx, { trip_id, run_id, status: "merchant_responded", note, evidence });
    const step = sc(p).guidance.next_steps[0];
    expect(step.needs_confirmation).toBe(true);
    expect(step.args).toEqual({ trip_id, run_id, status: "merchant_responded", note, evidence, confirmation_code: sc(p).confirmation_code });
    expect(sc(p)).toMatchObject({ note, evidence, preview: true });
    expect(sc(p).guidance.fact).toContain("for the whole service order");
    const done = await updateCase.run(ctx, step.args);
    expect(sc(done)).toMatchObject({ trackingState: "merchant_responded", provenance: "user-reported" });
    expect(sc(done).guidance.next_steps).toEqual([]);
    expect(sc(done).guidance.end).toContain("the person's own report");
  });

  it("after each record only the next stage is offered, and it stays in the chat", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await delivered(ctx);
    const p = await updateCase.run(ctx, { trip_id, run_id, status: "submitted_by_user" });
    const done = await updateCase.run(ctx, sc(p).guidance.next_steps[0].args);
    expect(sc(done).guidance.next_steps).toEqual([expect.objectContaining({ tool: "update_case_status", args: { trip_id, run_id, status: "awaiting_merchant" } })]);
    expect(buttons(done)).toEqual([]);
  });
});

describe("order check only", () => {
  it("reports no mismatch and needs no payment", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await reconcile.run(ctx, { trip_id });
    expect(sc(r).guidance.fact).toContain("No mismatch and no payment is needed.");
    expect(sc(r).display_total).toBe("USD 1,491.00");
    expect(buttons(r)).toEqual([]);
    expect(tools(r)).not.toContain("quote_service");
  });
});

describe("errors through the real tool wrapper", () => {
  it("a crash never claims nothing was charged and points back to the records", async () => {
    const { env } = testEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, DB: { prepare: () => { throw new Error("boom"); } } } as unknown as Env;
    const { client, close } = await connected(broken);
    try {
      const r: any = await client.callTool({ name: "get_status", arguments: {} });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.message).toBe("Unexpected error. No verified result yet. Check the existing record before trying again.");
      expect(JSON.stringify(r)).not.toMatch(/nothing was charged/i);
      expect(r.structuredContent.guidance.next_steps[0]).toMatchObject({ tool: "get_status", args: {} });
    } finally {
      await close();
    }
  });

  it("an ordinary failure gets the same safe way forward, in text as well", async () => {
    const { env } = testEnv();
    const { client, close } = await connected(env);
    try {
      const r: any = await client.callTool({ name: "quote_service", arguments: { trip_id: "trip_missing" } });
      expect(r.structuredContent.error.code).toBe("not_found");
      expect(r.structuredContent.guidance.next_steps[0]).toMatchObject({ tool: "get_status", args: {} });
      expect(r.content.map((c: any) => c.text).join("\n")).toContain('call get_status with {}');
    } finally {
      await close();
    }
  });

  it("every registered tool still lists, with no new names", async () => {
    const { env } = testEnv();
    const { client, close } = await connected(env);
    try {
      const { tools: listed } = await client.listTools();
      expect(listed.map((t) => t.name).sort()).toEqual([
        "create_service_payment", "create_split_payments", "detect_impact", "get_status", "import_orders", "plan_options",
        "quote_service", "quote_split", "reconcile_trip", "split_status", "verify_payment",
      ]);
    } finally {
      await close();
    }
  });
});
