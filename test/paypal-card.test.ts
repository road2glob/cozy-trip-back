// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalCallbacks, PayPalSdk } from "../ui/paypal";

const host = vi.hoisted(() => ({
  app: undefined as { ontoolresult?: (r: { structuredContent: Record<string, unknown> }) => void } | undefined,
  links: true,
  messages: true,
  send: vi.fn(),
  call: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    ontoolresult?: (r: { structuredContent: Record<string, unknown> }) => void;
    constructor() { host.app = this; }
    async connect() {}
    getHostContext() { return undefined; }
    getHostCapabilities() { return { ...(host.links ? { openLinks: {} } : {}), ...(host.messages ? { message: {} } : {}) }; }
    sendMessage = host.send;
    callServerTool = host.call;
    openLink = host.open;
    async updateModelContext() {}
  },
  applyDocumentTheme: vi.fn(),
  applyHostFonts: vi.fn(),
  applyHostStyleVariables: vi.fn(),
}));

const order = {
  view: "paypal_checkout", reality: "paypal_sandbox", state: "awaiting-payment",
  trip_id: "trip_test", runId: "run_test", chargeId: "charge_test",
  paypalOrderId: "ORDER-FROM-SERVER", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER",
  display_amount: "USD 9.90",
};
let callbacks: PayPalCallbacks;
let start: ReturnType<typeof vi.fn>;
let createInstance: ReturnType<typeof vi.fn>;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const result = (sc: Record<string, unknown>) => host.app?.ontoolresult?.({ structuredContent: sc });
const buttons = () => [...document.querySelectorAll("button")];

async function boot(sc = order) {
  await import("../ui/main");
  await flush();
  result(sc);
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  host.links = true;
  host.messages = true;
  host.send.mockReset().mockResolvedValue({});
  host.app = undefined;
  host.call.mockReset().mockResolvedValue({ content: [{ type: "text", text: "No verified capture yet." }], structuredContent: { trip_id: "trip_test", runId: "run_test", paid: false, output: null } });
  host.open.mockReset().mockResolvedValue({});
  document.head.innerHTML = '<meta name="cozytrip-paypal-client-id" content="public-test-client">';
  document.body.innerHTML = '<main id="root"></main>';
  if (!customElements.get("paypal-button")) customElements.define("paypal-button", class extends HTMLElement {});
  start = vi.fn().mockResolvedValue(undefined);
  createInstance = vi.fn().mockResolvedValue({
    findEligibleMethods: async () => ({ isEligible: () => true }),
    createPayPalOneTimePaymentSession: (c: PayPalCallbacks) => { callbacks = c; return { start }; },
  });
  window.paypal = { createInstance } as PayPalSdk;
});
afterEach(() => {
  result({ error: { code: "test-finished", message: "finished" } });
  vi.useRealTimers();
  delete window.paypal;
  vi.restoreAllMocks();
});

describe("PayPal service card through the existing App host bridge", () => {
  it("uses the existing order, popup presentation and server-formatted amount", async () => {
    await boot();
    expect(createInstance).toHaveBeenCalledWith({ clientId: "public-test-client", components: ["paypal-payments"] });
    expect(document.body.textContent).toContain("PayPal Sandbox — test money only");
    expect(document.body.textContent).toContain("USD 9.90");
    expect(document.body.textContent).not.toContain(order.approveUrl);
    document.querySelector<HTMLElement>("paypal-button")!.click();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toEqual({ presentationMode: "popup" });
    expect(await start.mock.calls[0][1]).toEqual({ orderId: order.paypalOrderId });
    expect(host.call).not.toHaveBeenCalled();
  });

  it("[S8] approval asks only verify_payment once and renders only the server's pending result", async () => {
    await boot();
    await callbacks.onApprove({ orderId: "IGNORED-CALLBACK-ID" });
    await callbacks.onApprove({});
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(host.call).toHaveBeenCalledWith({ name: "verify_payment", arguments: { trip_id: "trip_test", run_id: "run_test" } });
    expect(document.body.textContent).toContain("No verified capture yet.");
    expect(document.body.textContent).not.toContain("Your three drafts");
    expect(document.querySelector("paypal-button")).toBeNull();
  });

  it("[S9] closing PayPal never claims nothing was charged, and starts no verification or new order", async () => {
    await boot();
    callbacks.onCancel();
    expect(document.body.textContent).toContain("PayPal was closed. No verified payment yet.");
    expect(document.body.textContent).not.toMatch(/nothing was charged/i);
    expect(document.querySelector("paypal-button")).not.toBeNull();
    expect(host.call).not.toHaveBeenCalled();
  });

  it("a host verification failure offers a server check instead of another SDK payment", async () => {
    host.call.mockRejectedValue(new Error("host tool unavailable"));
    await boot();
    await callbacks.onApprove({});
    expect(document.querySelector("paypal-button")).toBeNull();
    expect(buttons().map(x => x.textContent)).toEqual(["Check again"]);
    buttons()[0].click();
    await flush();
    expect(host.call).toHaveBeenCalledTimes(2);
    expect(host.call.mock.calls.every(([request]) => request.name === "verify_payment")).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("[S9] payment errors do not imply success or start server work", async () => {
    await boot();
    callbacks.onError({ code: "INSTRUMENT_DECLINED" });
    expect(document.body.textContent).toContain("No verified result for this step.");
    expect(host.call).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Payment verified");
  });

  it("[S8] a blocked popup switches to the host open-link button, and opening it makes checking the main action", async () => {
    start.mockRejectedValue({ code: "ERR_DEV_UNABLE_TO_OPEN_POPUP" });
    await boot();
    document.querySelector<HTMLElement>("paypal-button")!.click();
    await flush();
    expect(document.querySelector("paypal-button")).toBeNull();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
    buttons()[0].click();
    await flush();
    expect(host.open).toHaveBeenCalledWith({ url: order.approveUrl });
    expect(host.call).not.toHaveBeenCalled();
    // The tab being open proves nothing: no paid claim, and the check comes first.
    expect(document.body.textContent).toContain("Complete the payment in PayPal, then come back.");
    expect(document.body.textContent).not.toMatch(/verified payment|paid\b(?! yet)/i);
    expect(buttons().map(x => x.textContent)).toEqual(["Check again", "Open PayPal again"]);
    buttons()[0].click();
    await flush();
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(host.call).toHaveBeenCalledWith({ name: "verify_payment", arguments: { trip_id: "trip_test", run_id: "run_test" } });
    expect(document.body.textContent).toContain("No verified capture yet.");
    expect(buttons().map(x => x.textContent)).toEqual(["Check again"]);
  });

  it("the open-link button can be used again, for the same order", async () => {
    createInstance.mockRejectedValue(new Error("SDK blocked"));
    await boot();
    buttons()[0].click();
    await flush();
    buttons()[1].click();
    await flush();
    expect(host.open).toHaveBeenCalledTimes(2);
    expect(host.open.mock.calls.every(([request]) => request.url === order.approveUrl)).toBe(true);
    expect(host.call).not.toHaveBeenCalled();
  });

  it("also catches a synchronous popup failure", async () => {
    start.mockImplementation(() => { throw { code: "ERR_DEV_UNABLE_TO_OPEN_POPUP" }; });
    await boot();
    document.querySelector<HTMLElement>("paypal-button")!.click();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
  });

  it.each(["denied", "throws"])("render failure falls back, and %s open-link becomes copyable text with a check", async (mode) => {
    createInstance.mockRejectedValue(new Error("render-failed"));
    if (mode === "denied") host.open.mockResolvedValue({ isError: true });
    else host.open.mockRejectedValue(new Error("host rejected link"));
    await boot();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
    buttons()[0].click();
    await flush();
    expect(document.body.textContent).toContain(order.approveUrl);
    expect(buttons().map(x => x.textContent)).toEqual(["Check again"]);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("an unsupported openLinks capability falls straight back to copyable text with a check", async () => {
    host.links = false;
    createInstance.mockRejectedValue(new Error("SDK blocked"));
    await boot();
    expect(document.body.textContent).toContain(order.approveUrl);
    expect(buttons().map(x => x.textContent)).toEqual(["Check again"]);
    expect(host.open).not.toHaveBeenCalled();
  });

  it("[S9] an eight-second SDK timeout falls back and a late load cannot restore a stale button", async () => {
    vi.useFakeTimers();
    delete window.paypal;
    const append = vi.spyOn(document.head, "append").mockImplementation(() => {});
    await boot();
    const script = append.mock.calls[0][0] as HTMLScriptElement;
    expect(script.src).toBe("https://www.sandbox.paypal.com/web-sdk/v6/core");
    await vi.advanceTimersByTimeAsync(8000);
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
    window.paypal = { createInstance } as PayPalSdk;
    script.dispatchEvent(new Event("load"));
    await flush();
    expect(document.querySelector("paypal-button")).toBeNull();
    expect(createInstance).not.toHaveBeenCalled();
  });

  it("script errors automatically reveal fallback", async () => {
    delete window.paypal;
    const append = vi.spyOn(document.head, "append").mockImplementation(() => {});
    await boot();
    (append.mock.calls[0][0] as HTMLScriptElement).dispatchEvent(new Event("error"));
    await flush();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
  });

  it("[S8] in a srcdoc document, where the SDK can never finish, it goes straight to the link without requesting the SDK", async () => {
    delete window.paypal;
    const append = vi.spyOn(document.head, "append").mockImplementation(() => {});
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("about:srcdoc");
    try {
      expect(window.location.origin).toBe("null");
      await boot();
      expect(append).not.toHaveBeenCalled();
      expect(createInstance).not.toHaveBeenCalled();
      expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
      expect(document.body.textContent).toContain("PayPal button unavailable. Open PayPal instead.");
    } finally {
      (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost:3000/");
    }
  });

  it("old SDK callbacks cannot verify after a different tool result replaces the card", async () => {
    await boot();
    const oldCallbacks = callbacks;
    result({ trips: [], runs: [] });
    await oldCallbacks.onApprove({});
    expect(host.call).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("No trips yet");
  });

  it("a missing server ID keeps the existing payment view and never loads the SDK", async () => {
    await boot({ ...order, paypalOrderId: "" });
    expect(createInstance).not.toHaveBeenCalled();
    expect(document.querySelector("paypal-button")).toBeNull();
    expect(document.body.textContent).toContain("Open PayPal Sandbox");
  });
});

describe("the reminder plan card", () => {
  const plan = {
    reminder_plan: true, label: "CozyTrip Demo", timezone: "America/Los_Angeles", calendar_name: null, confirmed: false,
    reminders: [{ key: "a", what: "Departs in 3 days", lead: "3 days before", display_when: "Nov 5, 09:00", display_beijing: "Nov 6, 01:00", state: "planned" }],
    removals: [], notes: [],
    guidance: { fact: "x", end: null, next_steps: [{ when: "w", tool: "plan_reminders", args: { trip_id: "t", confirmation_code: "c" }, needs_confirmation: true, card_action: "Add to my calendar", card_message: "I agree to this CozyTrip demo reminder plan. Please add it to my calendar." }] },
  };

  it("asks through the chat, calls no tool, and says reminders are not set yet", async () => {
    await boot(plan as never);
    buttons()[0].click();
    await flush();
    expect(host.send).toHaveBeenCalledWith({ role: "user", content: [{ type: "text", text: "I agree to this CozyTrip demo reminder plan. Please add it to my calendar." }] });
    expect(host.call).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Reminders are not set until the chat reports the calendar result.");
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each(["no capability", "refused", "throws"])("when the chat cannot take it (%s), it says what to type and claims nothing", async (mode) => {
    if (mode === "no capability") host.messages = false;
    if (mode === "refused") host.send.mockResolvedValue({ isError: true });
    if (mode === "throws") host.send.mockRejectedValue(new Error("no"));
    await boot(plan as never);
    buttons()[0].click();
    await flush();
    expect(document.body.textContent).toContain('Say "I agree to this CozyTrip demo reminder plan. Please add it to my calendar." in the chat instead.');
    expect(document.body.textContent).not.toContain("Sent to the chat");
    expect(host.call).not.toHaveBeenCalled();
  });
});

describe("member shares on one card", () => {
  const share = (name: string, id: string, extra: Record<string, unknown> = {}) => ({
    trip_id: "trip_test", payment_id: id, participant_id: "ppl_" + id, name, amount_minor: 6000, display_amount: "USD 60.00", currency: "USD",
    state: "awaiting-payment", prompt: true,
    approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, paypalOrderId: `ORDER-${id}`,
    ...extra,
  });
  const paid = (name: string, id: string) => {
    const { approveUrl: _url, paypalOrderId: _id, ...row } = share(name, id, { state: "captured", prompt: false });
    return row;
  };
  const splitResult = (payments: unknown[], extra: Record<string, unknown> = {}) => ({
    trip_id: "trip_test", reality: "paypal_sandbox", payments,
    organizer: { name: "Maya", due_minor: 0, display_due: "USD 0.00", prompt: false },
    disclaimer: "Sandbox demo: funds go to the CozyTrip Team sandbox merchant, not a real person-to-person transfer.",
    payee_notice: "Pays the CozyTrip Team sandbox merchant, not Maya.",
    ...extra,
  });
  const unpaid = () => splitResult([share("Leo", "pay_leo"), share("Ava", "pay_ava")]);
  const sessions: Array<{ callbacks: PayPalCallbacks; start: ReturnType<typeof vi.fn> }> = [];

  beforeEach(() => {
    sessions.length = 0;
    createInstance = vi.fn().mockResolvedValue({
      findEligibleMethods: async () => ({ isEligible: () => true }),
      createPayPalOneTimePaymentSession: (c: PayPalCallbacks) => {
        const session = { callbacks: c, start: vi.fn().mockResolvedValue(undefined) };
        sessions.push(session);
        return session;
      },
    });
    window.paypal = { createInstance } as PayPalSdk;
    host.call.mockResolvedValue({ content: [{ type: "text", text: "shares" }], structuredContent: unpaid() });
  });

  it("gives Leo and Ava their own control for their own server order, and Maya none", async () => {
    await boot(unpaid());
    expect(createInstance).toHaveBeenCalledTimes(1);
    const controls = [...document.querySelectorAll<HTMLElement>("paypal-button")];
    expect(controls).toHaveLength(2);
    controls[1].click();
    expect(await sessions[1].start.mock.calls[0][1]).toEqual({ orderId: "ORDER-pay_ava" });
    expect(sessions[0].start).not.toHaveBeenCalled();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Leo's share");
    expect(text).toContain("Ava's share");
    expect(text).toContain("Maya owes USD 0.00 and has no payment.");
    expect(text).toContain("Pays the CozyTrip Team sandbox merchant, not Maya.");
    expect(text).toContain("not a real person-to-person transfer");
    expect(text).not.toContain("Maya's share");
    expect(host.call).not.toHaveBeenCalled();
  });

  it("[S8] an approval checks split_status, never verify_payment, and keeps the other member's button", async () => {
    await boot(unpaid());
    host.call.mockResolvedValue({ content: [{ type: "text", text: "one paid" }], structuredContent: splitResult([paid("Leo", "pay_leo"), share("Ava", "pay_ava")]) });
    await sessions[0].callbacks.onApprove({ orderId: "IGNORED" });
    await flush();
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(host.call).toHaveBeenCalledWith({ name: "split_status", arguments: { trip_id: "trip_test" } });
    expect(document.querySelectorAll("paypal-button")).toHaveLength(1);
    expect(document.body.textContent).toContain("Paid");
    expect(document.body.textContent).toContain("Not paid");
    expect(document.body.textContent).not.toContain("All shares paid");
  });

  it("an approval the server has not confirmed stays unpaid and offers only a check for that member", async () => {
    await boot(unpaid());
    await sessions[0].callbacks.onApprove({});
    await flush();
    expect(document.body.textContent).toContain("No verified capture yet.");
    expect(document.querySelectorAll("paypal-button")).toHaveLength(1);
    expect(buttons().map(x => x.textContent)).toEqual(["Check again"]);
    expect(document.body.textContent).not.toContain("All shares paid");
  });

  it("when both are paid there is no payment control or check, and old callbacks do nothing", async () => {
    await boot(unpaid());
    const old = sessions[1].callbacks;
    result(splitResult([paid("Leo", "pay_leo"), paid("Ava", "pay_ava")], { guidance: { fact: "done", next_steps: [], end: "No share is waiting" } }));
    await flush();
    expect(document.querySelector("paypal-button")).toBeNull();
    expect(buttons()).toHaveLength(0);
    expect(document.body.textContent).toContain("All shares paid");
    await old.onApprove({});
    expect(host.call).not.toHaveBeenCalled();
  });

  it("[S8] a blocked popup falls back for that member only, and returning means checking the shares", async () => {
    await boot(unpaid());
    sessions[0].start.mockRejectedValue({ code: "ERR_DEV_UNABLE_TO_OPEN_POPUP" });
    [...document.querySelectorAll<HTMLElement>("paypal-button")][0].click();
    await flush();
    expect(document.querySelectorAll("paypal-button")).toHaveLength(1);
    expect(buttons().map(x => x.getAttribute("aria-label"))).toEqual(["Open PayPal for Leo's share"]);
    buttons()[0].click();
    await flush();
    expect(host.open).toHaveBeenCalledWith({ url: "https://www.sandbox.paypal.com/checkoutnow?token=pay_leo" });
    expect(document.body.textContent).toContain("Complete the payment in PayPal, then come back.");
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal again", "Check again"]);
    buttons()[1].click();
    await flush();
    expect(host.call).toHaveBeenCalledWith({ name: "split_status", arguments: { trip_id: "trip_test" } });
    expect(document.body.textContent).toContain("No verified capture yet.");
    expect(document.querySelectorAll("paypal-button")).toHaveLength(1);
  });

  it("local stub shares never load the SDK and use the link", async () => {
    await boot(splitResult([share("Leo", "pay_leo", { paypalOrderId: "STUB-pay_leo" })], { reality: "local_stub" }));
    expect(createInstance).not.toHaveBeenCalled();
    expect(buttons().map(x => x.textContent)).toEqual(["Open stub checkout"]);
  });

  it("a share with no server order ID uses the link instead of guessing", async () => {
    await boot(splitResult([share("Leo", "pay_leo", { paypalOrderId: undefined })]));
    expect(createInstance).not.toHaveBeenCalled();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
  });
});
