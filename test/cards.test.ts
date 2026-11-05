// @vitest-environment happy-dom
// Real tool results rendered to real DOM: what a person sees and can press in each state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cardFor, type CardAction } from "../ui/views";
import { render, type UiState } from "../ui/render";
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
import { fixtureWrite } from "../stub/complete";
import { testEnv, toolCtx } from "./helpers/env";

const sc = (r: any) => r.structuredContent as any;
let root: HTMLElement;
const pressed: CardAction[] = [];
const opened: Array<[string, string]> = [];
const actions = { run: (a: CardAction) => pressed.push(a), openCheckout: (key: string, url: string) => opened.push([key, url]) };
const ui = (over: Partial<UiState> = {}): UiState => ({ busy: false, notice: null, now: Date.now(), checkouts: {}, ...over });

function show(result: any, state: UiState = ui()) {
  render(root, cardFor(result.structuredContent), actions, state);
  return {
    text: root.textContent ?? "",
    buttons: [...root.querySelectorAll("button")].map((b) => b.textContent),
  };
}
const pressFirst = () => (root.querySelector("button") as HTMLButtonElement).click();

async function imported(ctx: any) {
  return sc(await imports.run(ctx, { mode: "sample" })).trip_id as string;
}
async function ordered(ctx: any) {
  const trip_id = await imported(ctx);
  const p = sc(await detect.run(ctx, { trip_id }));
  await detect.run(ctx, { trip_id, confirmation_code: p.confirmation_code });
  const q = sc(await quote.run(ctx, { trip_id }));
  const order = await pay.run(ctx, { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code });
  return { trip_id, run_id: q.runId as string, order };
}
async function delivered(ctx: any) {
  const o = await ordered(ctx);
  const r = await getRun(ctx.env, o.run_id);
  r.state = "running";
  await fixtureWrite(ctx.env.DB, o.run_id, { run: r });
  return { ...o, result: await verify.run(ctx, { trip_id: o.trip_id, run_id: o.run_id }) };
}
async function capture(ctx: any, paymentId: string) {
  const order = await getSettlement(ctx.env, paymentId);
  order.state = "captured";
  order.paypalCaptureId = "FAKE-" + paymentId;
  await fixtureWrite(ctx.env.DB, "settlement:" + paymentId, order);
}

const INTERNAL = /run_[a-z0-9]|chg_|apt_|trip_[A-Za-z0-9]|pay_[A-Za-z0-9]|confirmation_code/;

beforeEach(() => {
  document.body.innerHTML = '<main id="root"></main>';
  root = document.getElementById("root") as HTMLElement;
  pressed.length = 0;
  opened.length = 0;
});

describe("entry", () => {
  it("empty ledger: one action, and none of what comes later", async () => {
    const { env } = testEnv();
    const { text, buttons } = show(await status.run(toolCtx(env), {}));
    expect(buttons).toEqual(["Import sample trip"]);
    expect(text).toContain("CozyTrip is connected.");
    expect(text).not.toMatch(/seattle|cancel|9\.90|paypal|payment|usd/i);
  });

  it("trip: four bookings, three travelers, total and the simulated label, with no talk of an armed event", async () => {
    const { env } = testEnv();
    const { text } = show(await imports.run(toolCtx(env), { mode: "sample" }));
    for (const title of ["Sample Air 210", "Sample Bay Hotel", "Sample Transfer Co", "Sample Bay Cruise"]) expect(text).toContain(title);
    expect(text).toContain("3 travelers: Maya, Leo, Ava");
    expect(text).toContain("USD 1,491.00");
    expect(text).toContain("Simulated travel data");
    expect(text).not.toMatch(/armed|payment-service/i);
    expect(text).not.toMatch(INTERNAL);
  });

  it("order check: a read-only result with no button", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const { text, buttons } = show(await reconcile.run(ctx, { trip_id }));
    expect(text).toContain("4 bookings and their expenses both come to USD 1,491.00.");
    expect(text).toContain("No mismatch.");
    expect(buttons).toEqual([]);
  });

  it("a mismatch is an error card with no way to pay", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    raw.prepare("UPDATE expenses SET amount_minor=amount_minor+1").run();
    const { text, buttons } = show(await reconcile.run(ctx, { trip_id }));
    expect(text).toContain("That did not go through");
    expect(buttons).not.toContain("Confirm USD 9.90");
  });
});

describe("issue", () => {
  it("preview says nothing changed; its button confirms with the server's exact arguments", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await detect.run(ctx, { trip_id });
    const { text, buttons } = show(r);
    expect(text).toContain("Nothing has changed.");
    expect(text).toContain("Inferred.");
    expect(text).not.toMatch(/R-[A-Z]+-/);
    expect(buttons).toEqual(["Confirm simulation"]);
    pressFirst();
    expect(pressed[0]).toEqual({ label: "Confirm simulation", tool: "detect_impact", args: { trip_id, confirmation_code: sc(r).confirmation_code } });
  });

  it("the confirmed impact has no payment button, and options offer the quote only quietly", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await detect.run(ctx, { trip_id }));
    expect(show(await detect.run(ctx, { trip_id, confirmation_code: p.confirmation_code })).buttons).toEqual(["See recovery options"]);
    const { text, buttons } = show(await options.run(ctx, { trip_id }));
    expect(text).toContain("You can stop here.");
    expect(buttons).toEqual(["Get a quote for the drafts"]);
    expect(root.querySelector("button")?.className).toContain("btn-secondary");
  });
});

describe("service fee", () => {
  it("quote: price, scope, not paid, one action, and no bare Approved", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await detect.run(ctx, { trip_id }));
    await detect.run(ctx, { trip_id, confirmation_code: p.confirmation_code });
    const { text, buttons } = show(await quote.run(ctx, { trip_id }));
    expect(text).toContain("USD 9.90");
    expect(text).toContain("Hotel change request");
    expect(text).toContain("Not paid. No PayPal order exists until you confirm.");
    expect(buttons).toEqual(["Confirm USD 9.90"]);
    expect(text).not.toMatch(/approved/i);
    expect(text).not.toMatch(INTERNAL);
  });

  it("a confirmed quote says so in full and only continues to the same order", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id } = await ordered(ctx);
    const { text, buttons } = show(await quote.run(ctx, { trip_id }));
    expect(buttons).toEqual(["Continue to PayPal"]);
    expect(text).toContain("You confirmed this fee earlier. This uses the same order, not a new one.");
    expect(text).not.toMatch(/\bapproved\b/i);
  });

  it("an expired quote asks for a new one and says what did not happen", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await detect.run(ctx, { trip_id }));
    await detect.run(ctx, { trip_id, confirmation_code: p.confirmation_code });
    const q = await quote.run(ctx, { trip_id });
    const later = Date.parse(sc(q).expires_at) + 60000;
    const { text, buttons } = show(q, ui({ now: later }));
    expect(buttons).toEqual(["Get a new quote"]);
    expect(text).toContain("No order was created from it.");
    expect(text).not.toMatch(/nothing was charged/i);
  });

  it("the stub order keeps its label, opens by link, and hides its IDs", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { order } = await ordered(ctx);
    const view = cardFor(order.structuredContent);
    if (view.kind !== "payment") throw new Error(view.kind);
    const key = `service:${view.tripId}:${view.runId}:${view.chargeId}`;
    const { text, buttons } = show(order, ui({ checkouts: { [key]: { phase: "fallback" } } }));
    expect(text).toContain("Local contract stub. No PayPal order was created.");
    expect(text).toContain("Order ready. Not paid yet.");
    expect(buttons).toEqual(["Open stub checkout"]);
    expect(text).not.toMatch(INTERNAL);
    pressFirst();
    expect(opened[0]).toEqual([key, view.approveUrl]);
  });

  it("an unconfirmed check states the exact sentence and offers the check first", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    const { text, buttons } = show(await verify.run(ctx, { trip_id, run_id }));
    expect(text).toContain("No verified capture yet.");
    expect(buttons).toEqual(["Check again", "Back to PayPal"]);
  });

  it("while the payment is being checked there is no payment entry", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    const r = await getRun(env, run_id);
    r.state = "verifying";
    await fixtureWrite(env.DB, run_id, { run: r });
    const { text, buttons } = show(await verify.run(ctx, { trip_id, run_id }));
    expect(text).toContain("Checking this order");
    expect(text).toContain("No new payment is needed.");
    expect(buttons).toEqual(["Check again"]);
  });

  it("delivery: three titled drafts each marked not sent, with no button of any kind", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { result } = await delivered(ctx);
    const { text, buttons } = show(result);
    expect(text).toContain("Payment verified");
    for (const t of ["Airline contact points", "Hotel change request", "Transfer and cruise change request"]) expect(text).toContain(t);
    expect(text.match(/Draft\. Not sent\./g)).toHaveLength(3);
    expect(buttons).toEqual([]);
    expect(text).not.toMatch(/mark as|submitted/i);
    expect(root.querySelectorAll("details")).toHaveLength(3);
  });
});

describe("split", () => {
  it("the quote shows everyone's amount, both notices and only Confirm split", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await split.run(ctx, { trip_id });
    const { text, buttons } = show(r);
    expect(text).toContain("USD 180.00 prepaid by Maya");
    expect(text).toContain("USD 0.00 due");
    expect(text.match(/USD 60\.00 due/g)).toHaveLength(2);
    expect(text).toContain("not a real person-to-person transfer");
    expect(text).toContain("Pays the CozyTrip Team sandbox merchant, not Maya.");
    expect(buttons).toEqual(["Confirm split"]);
    expect(root.querySelectorAll("a")).toHaveLength(0);
    pressFirst();
    expect(pressed[0]).toMatchObject({ tool: "create_split_payments", args: { trip_id, confirmation_code: sc(r).confirmation_code } });
  });

  it("one paid member shows as paid while the other keeps a payment entry; all paid has none", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const q = sc(await split.run(ctx, { trip_id }));
    const created = await createSplit.run(ctx, { trip_id, confirmation_code: q.confirmation_code });
    const [leo, ava] = sc(created).payments;
    expect(leo.paypalOrderId).toBe("STUB-" + leo.payment_id);
    expect(sc(created).reality).toBe("local_stub");

    const checkouts = { [`share:${leo.payment_id}`]: { phase: "fallback" as const }, [`share:${ava.payment_id}`]: { phase: "fallback" as const } };
    const first = show(created, ui({ checkouts }));
    expect(first.buttons).toEqual(["Open stub checkout", "Open stub checkout"]);
    expect(first.text).toContain("Maya owes USD 0.00 and has no payment.");
    expect(first.text).not.toContain("Maya's share");
    expect(first.text).not.toMatch(INTERNAL);

    await capture(ctx, leo.payment_id);
    const one = await splitCheck.run(ctx, { trip_id });
    expect(sc(one).payments[0]).not.toHaveProperty("paypalOrderId");
    expect(sc(one).payments[0]).not.toHaveProperty("approveUrl");
    expect(sc(one).payments[1].paypalOrderId).toBe("STUB-" + ava.payment_id);
    const second = show(one, ui({ checkouts }));
    expect(second.buttons).toEqual(["Open stub checkout"]);
    expect(second.text).toContain("Leo's share");
    expect(second.text).toContain("Paid");
    expect(second.text).toContain("Not paid");

    await capture(ctx, ava.payment_id);
    const all = show(await splitCheck.run(ctx, { trip_id }), ui());
    expect(all.buttons).toEqual([]);
    expect(all.text).toContain("All shares paid");
  });

  it("checking before any split offers the free quote", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const { text, buttons } = show(await splitCheck.run(ctx, { trip_id }));
    expect(text).toContain("No share requests yet");
    expect(buttons).toEqual(["Review the split"]);
  });
});

describe("user-reported follow-up", () => {
  it("the preview shows the person's own words, its scope, and confirms with them intact", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await delivered(ctx);
    for (const s of ["submitted_by_user", "awaiting_merchant"] as const) {
      const p = await updateCase.run(ctx, { trip_id, run_id, status: s });
      await updateCase.run(ctx, sc(p).guidance.next_steps[0].args);
    }
    const note = "Refund received in my account";
    const evidence = "User supplied bank statement reference";
    const r = await updateCase.run(ctx, { trip_id, run_id, status: "merchant_responded", note, evidence });
    const { text, buttons } = show(r);
    expect(text).toContain("Record: Merchant replied?");
    expect(text).toContain(`Your note: ${note}`);
    expect(text).toContain(`Your evidence: ${evidence}`);
    expect(text).toContain("the whole service order, not each draft");
    expect(buttons).toEqual(["Confirm my report"]);
    pressFirst();
    const done = await updateCase.run(ctx, pressed[0].args as any);
    expect(sc(done).trackingState).toBe("merchant_responded");
    const recorded = show(done);
    expect(recorded.text).toContain("Recorded: Merchant replied");
    expect(recorded.text).toContain("From your own report");
    expect(recorded.buttons).toEqual([]);
  });
});

describe("status", () => {
  it("states where things stand and tucks run IDs and steps into details", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const { trip_id, run_id } = await ordered(ctx);
    const { text, buttons } = show(await status.run(ctx, { trip_id }));
    expect(text).toContain("Order created. Not paid.");
    expect(buttons[0]).toBe("Check again");
    const details = root.querySelector("details") as HTMLDetailsElement;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.textContent).toContain(run_id);
    const outside = (root.textContent ?? "").replace(details.textContent ?? "", "");
    expect(outside).not.toContain(run_id);
    expect(root.querySelectorAll(".steps")).toHaveLength(1);
    expect(details.querySelector(".steps")).not.toBeNull();
  });

  it("refund-required is never shown as refunded", () => {
    const view = cardFor({ trips: [], runs: [{ runId: "run_x", state: "verified", steps: [], chargeOutcome: "refund-required" }], split_payments: [] });
    render(root, view, actions, ui());
    expect(root.textContent).toContain("Refund required. This is not a completed refund.");
    expect(root.textContent).not.toMatch(/\brefunded\b/i);
  });
});

describe("errors", () => {
  it("offers the safe way back and keeps the code in details", () => {
    const view = cardFor({ error: { code: "internal_error", message: "Unexpected error. No verified result yet. Check the existing record before trying again." }, guidance: { fact: "x", end: null, next_steps: [{ when: "w", tool: "get_status", args: {}, needs_confirmation: false, card_action: "Check where things stand" }] } });
    render(root, view, actions, ui());
    expect([...root.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Check where things stand"]);
    expect(root.querySelector("details")?.textContent).toContain("internal_error");
    expect(root.textContent).not.toMatch(/nothing was charged/i);
  });
});

it("does not render unknown shapes as anything actionable", () => {
  const spy = vi.fn();
  render(root, cardFor({ whatever: true }), { run: spy, openCheckout: spy }, ui());
  expect(root.querySelector("button")).toBeNull();
});
