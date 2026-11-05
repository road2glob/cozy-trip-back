// The card that MCP Apps hosts (Claude, ChatGPT, VS Code, …) render next to a CozyTrip tool result.
// It shows the tool's structuredContent and offers the next step as a button. Every button goes
// through the host: tools/call for CozyTrip tools, ui/open-link for the approve URL. The card holds
// no secrets, sends no amounts and never decides that something is paid.
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { cardFor, type CardView, type ImpactView, type PaymentView, type QuoteView } from "./views";
import { render, type UiState } from "./render";
import { mountPayPalCheckout } from "./paypal";

type HostContext = ReturnType<App["getHostContext"]>;

const root = document.getElementById("root") as HTMLElement;
const app = new App({ name: "CozyTrip card", version: "0.1.0" }, {}, { autoResize: true });
let view: CardView = { kind: "unknown" };
const ui: UiState = { busy: false, notice: null, manualLink: null, now: Date.now() };
let checkout: { key: string; dispose(): void } | undefined;

function paint(): void {
  ui.now = Date.now();
  const key = view.kind === "paypal_checkout" ? `${view.tripId}:${view.runId}:${view.paypalOrderId}` : "";
  if (checkout && checkout.key !== key) {
    checkout.dispose();
    checkout = undefined;
    ui.paypal = undefined;
  }
  if (view.kind === "paypal_checkout" && !checkout) {
    const payment = view;
    ui.paypal = { phase: "loading" };
    checkout = { key, dispose: () => {} };
    const clientId = document.querySelector<HTMLMetaElement>('meta[name="cozytrip-paypal-client-id"]')?.content ?? "";
    checkout.dispose = mountPayPalCheckout(clientId, payment.paypalOrderId, {
      ready: (button) => { ui.paypal = { phase: "ready", button }; paint(); },
      approve: () => {
        ui.paypal = { phase: "verifying" };
        return runTool("verify_payment", { trip_id: payment.tripId, run_id: payment.runId });
      },
      cancel: () => { ui.notice = "Nothing was charged."; paint(); },
      failed: () => { ui.notice = "No verified result for this step."; paint(); },
      fallback: () => {
        ui.paypal = { phase: "fallback" };
        ui.notice = "PayPal button unavailable. Open PayPal instead.";
        if (!app.getHostCapabilities()?.openLinks) ui.manualLink = payment.approveUrl;
        paint();
      },
    });
  }
  render(root, view, actions, ui);
}

function applyTheme(ctx: HostContext): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<void> {
  ui.busy = true;
  ui.notice = null;
  paint();
  try {
    const result = await app.callServerTool({ name, arguments: args });
    view = cardFor(result.structuredContent);
    ui.manualLink = null;
    try {
      // Tell the model what the person just did in the card, so the chat stays in step.
      await app.updateModelContext({ content: result.content });
    } catch {
      // optional for hosts
    }
  } catch {
    ui.notice = "The chat app did not run that step. You can ask for it in the chat instead.";
  } finally {
    ui.busy = false;
    paint();
  }
}

const actions = {
  importSample: () => void runTool("import_orders", { mode: "sample" }),
  previewImpact: (tripId: string) => void runTool("detect_impact", { trip_id: tripId }),
  // The person pressed Confirm: that click is the consent for the free, simulated assessment.
  confirmImpact: (v: ImpactView) => void runTool("detect_impact", { trip_id: v.tripId, confirmation_code: v.code }),
  options: (tripId: string) => void runTool("plan_options", { trip_id: tripId }),
  quote: (tripId: string) => void runTool("quote_service", { trip_id: tripId }),
  verify: (tripId: string, runId: string) => void runTool("verify_payment", { trip_id: tripId, run_id: runId }),
  // The person pressed Approve: that click is the consent. The server still checks the code.
  approve: (q: QuoteView) => void runTool("create_service_payment", { trip_id: q.tripId, run_id: q.runId, confirmation_code: q.code }),
  refresh: (tripId: string) => void runTool("get_status", { trip_id: tripId }),
  openCheckout: async (p: PaymentView) => {
    if (view.kind === "paypal_checkout" && !app.getHostCapabilities()?.openLinks) {
      ui.manualLink = p.approveUrl;
      ui.notice = "The link did not open. Copy it below.";
      paint();
      return;
    }
    ui.busy = true;
    paint();
    try {
      const res = await app.openLink({ url: p.approveUrl });
      if (res.isError) {
        ui.manualLink = p.approveUrl;
        ui.notice = "The link did not open. Copy it below.";
      } else {
        ui.notice = "Opened in your browser. After approving, come back and say 'check my payment'.";
      }
    } catch {
      ui.manualLink = p.approveUrl;
      ui.notice = "The link did not open. Copy it below.";
    } finally {
      ui.busy = false;
      paint();
    }
  },
};

app.ontoolresult = (result) => {
  view = cardFor(result.structuredContent);
  ui.manualLink = null;
  ui.notice = null;
  paint();
};
app.onhostcontextchanged = (ctx) => applyTheme(ctx);

async function main(): Promise<void> {
  paint();
  await app.connect();
  applyTheme(app.getHostContext());
}

void main();
