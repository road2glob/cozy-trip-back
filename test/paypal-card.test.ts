// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalCallbacks, PayPalSdk } from "../ui/paypal";

const host = vi.hoisted(() => ({
  app: undefined as { ontoolresult?: (r: { structuredContent: Record<string, unknown> }) => void } | undefined,
  links: true,
  call: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    ontoolresult?: (r: { structuredContent: Record<string, unknown> }) => void;
    constructor() { host.app = this; }
    async connect() {}
    getHostContext() { return undefined; }
    getHostCapabilities() { return host.links ? { openLinks: {} } : {}; }
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

  it("approval asks only verify_payment once and renders only the server's pending result", async () => {
    await boot();
    await callbacks.onApprove({ orderId: "IGNORED-CALLBACK-ID" });
    await callbacks.onApprove({});
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(host.call).toHaveBeenCalledWith({ name: "verify_payment", arguments: { trip_id: "trip_test", run_id: "run_test" } });
    expect(document.body.textContent).toContain("Payment not confirmed yet");
    expect(document.body.textContent).not.toContain("Your prepared drafts");
    expect(document.querySelector("paypal-button")).toBeNull();
  });

  it("cancel reports the prescribed sentence without verifying or creating an order", async () => {
    await boot();
    callbacks.onCancel();
    expect(document.body.textContent).toContain("Nothing was charged.");
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

  it("payment errors do not imply success or start server work", async () => {
    await boot();
    callbacks.onError({ code: "INSTRUMENT_DECLINED" });
    expect(document.body.textContent).toContain("No verified result for this step.");
    expect(host.call).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Payment verified");
  });

  it("a blocked popup switches to the original host open-link button", async () => {
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
  });

  it("also catches a synchronous popup failure", async () => {
    start.mockImplementation(() => { throw { code: "ERR_DEV_UNABLE_TO_OPEN_POPUP" }; });
    await boot();
    document.querySelector<HTMLElement>("paypal-button")!.click();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
  });

  it.each(["denied", "throws"])("render failure falls back, and %s open-link becomes text only", async (mode) => {
    createInstance.mockRejectedValue(new Error("render-failed"));
    if (mode === "denied") host.open.mockResolvedValue({ isError: true });
    else host.open.mockRejectedValue(new Error("host rejected link"));
    await boot();
    expect(buttons().map(x => x.textContent)).toEqual(["Open PayPal"]);
    buttons()[0].click();
    await flush();
    expect(document.body.textContent).toContain(order.approveUrl);
    expect(buttons()).toHaveLength(0);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("an unsupported openLinks capability falls straight back to copyable text", async () => {
    host.links = false;
    createInstance.mockRejectedValue(new Error("SDK blocked"));
    await boot();
    expect(document.body.textContent).toContain(order.approveUrl);
    expect(buttons()).toHaveLength(0);
    expect(host.open).not.toHaveBeenCalled();
  });

  it("an eight-second SDK timeout falls back and a late load cannot restore a stale button", async () => {
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
