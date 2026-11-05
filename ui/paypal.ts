// The SDK presents an existing server order. Approval only asks the host to verify it.
export const PAYPAL_CORE_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";
export const PAYPAL_READY_TIMEOUT_MS = 8000;

export interface PayPalCallbacks {
  onApprove(data: { orderId?: string }): Promise<void>;
  onCancel(): void;
  onError(error: { code?: string }): void;
}
export interface PayPalSession {
  start(options: { presentationMode: "popup" }, order: Promise<{ orderId: string }>): Promise<unknown>;
}
export interface PayPalSdk {
  createInstance(options: { clientId: string; components: ["paypal-payments"] }): Promise<{
    findEligibleMethods(): Promise<{ isEligible(method: "paypal"): boolean }>;
    createPayPalOneTimePaymentSession(callbacks: PayPalCallbacks): PayPalSession | Promise<PayPalSession>;
  }>;
}
declare global {
  interface Window { paypal?: PayPalSdk }
}

let loading: Promise<PayPalSdk> | undefined;

/** No script is requested until a real pending checkout card is rendered. */
export function loadPayPalSdk(): Promise<PayPalSdk> {
  if (window.paypal?.createInstance) return Promise.resolve(window.paypal);
  if (loading) return loading;
  const pending = new Promise<PayPalSdk>((resolve, reject) => {
    const script = document.createElement("script");
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };
    const failed = () => { cleanup(); script.remove(); reject(new Error("paypal-sdk-unavailable")); };
    timer = setTimeout(failed, PAYPAL_READY_TIMEOUT_MS);
    script.async = true;
    script.src = PAYPAL_CORE_URL;
    script.onload = () => {
      if (!window.paypal?.createInstance) return failed();
      cleanup();
      resolve(window.paypal);
    };
    script.onerror = failed;
    document.head.append(script);
  });
  loading = pending;
  // A later card can retry loading, but a failed card itself does not loop.
  void pending.catch(() => { if (loading === pending) loading = undefined; });
  return pending;
}

export interface CheckoutEvents {
  ready(button: HTMLElement): void;
  approve(): Promise<void>;
  cancel(): void;
  failed(): void;
  fallback(): void;
}

/** A single initialization deadline covers script, instance, eligibility and component readiness. */
export function mountPayPalCheckout(
  clientId: string,
  orderId: string,
  events: CheckoutEvents,
  loadSdk: () => Promise<PayPalSdk> = loadPayPalSdk,
): () => void {
  let active = true;
  let starting = false;
  let approvalStarted = false;
  let button: HTMLElement | undefined;
  let onClick: (() => void) | undefined;
  const detach = () => {
    if (button && onClick) button.removeEventListener("click", onClick);
  };
  const fallback = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    detach();
    events.fallback();
  };
  const timer = setTimeout(fallback, PAYPAL_READY_TIMEOUT_MS);
  const unlock = () => { starting = false; button?.removeAttribute("disabled"); };
  const paymentError = (error: { code?: string }) => {
    if (!active || approvalStarted) return;
    unlock();
    if (error.code === "ERR_DEV_UNABLE_TO_OPEN_POPUP") fallback();
    else events.failed();
  };
  const startFailed = (error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
    paymentError({ code });
  };
  const initialize = async () => {
    if (!clientId || !orderId) return fallback();
    const sdk = await loadSdk();
    if (!active) return;
    const instance = await sdk.createInstance({ clientId, components: ["paypal-payments"] });
    if (!active) return;
    const eligibility = await instance.findEligibleMethods();
    if (!active) return;
    if (!eligibility.isEligible("paypal")) return fallback();
    const session = await instance.createPayPalOneTimePaymentSession({
      onApprove: async () => {
        if (!active || approvalStarted) return;
        approvalStarted = true;
        unlock();
        // Do not use callback order IDs, amounts or a local success flag.
        await events.approve();
      },
      onCancel: () => {
        if (!active || approvalStarted) return;
        unlock();
        events.cancel();
      },
      onError: paymentError,
    });
    if (!active) return;
    await customElements.whenDefined("paypal-button");
    if (!active) return;
    button = document.createElement("paypal-button");
    button.setAttribute("type", "pay");
    button.setAttribute("class", "paypal-gold");
    button.setAttribute("aria-label", "Pay with PayPal Sandbox");
    button.addEventListener("error", fallback);
    onClick = () => {
      if (!active || starting || approvalStarted) return;
      starting = true;
      button?.setAttribute("disabled", "");
      // Pass a resolved existing ID immediately, preserving the user's activation for the popup.
      const createOrder = () => Promise.resolve({ orderId });
      try {
        void session.start({ presentationMode: "popup" }, createOrder()).catch(startFailed);
      } catch (error) {
        startFailed(error);
      }
    };
    button.addEventListener("click", onClick);
    events.ready(button);
    clearTimeout(timer);
  };
  // Defer callbacks until the caller has installed this controller's dispose handle.
  void Promise.resolve().then(initialize).catch(fallback);
  return () => {
    active = false;
    clearTimeout(timer);
    detach();
    button?.removeEventListener("error", fallback);
  };
}
