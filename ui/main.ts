// The card that MCP Apps hosts (Claude, ChatGPT, VS Code, …) render next to a CozyTrip tool result.
// It shows the tool's structuredContent and offers the next step as a button. Every button goes
// through the host: tools/call for CozyTrip tools, ui/open-link for the approve URL. The card holds
// no secrets, sends no amounts and never decides that something is paid.
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { cardFor, checkoutTargets, type CardAction, type CardView, type CheckoutTarget } from "./views";
import { render, type UiState } from "./render";
import { mountPayPalCheckout } from "./paypal";

type HostContext = ReturnType<App["getHostContext"]>;

const root = document.getElementById("root") as HTMLElement;
const app = new App({ name: "CozyTrip card", version: "0.1.0" }, {}, { autoResize: true });
let view: CardView = { kind: "unknown" };
const ui: UiState = { busy: false, notice: null, now: Date.now(), checkouts: {} };
const mounted = new Map<string, () => void>();

const LINK_FAILED = "The link did not open. Copy it below.";

function mountCheckout(target: CheckoutTarget): void {
  const { key, approveUrl, paypalOrderId, check } = target;
  // A link is the only way when the server gave no real order ID. No SDK is loaded for it.
  if (!paypalOrderId) {
    ui.checkouts[key] = { phase: "fallback" };
    mounted.set(key, () => {});
    return;
  }
  ui.checkouts[key] = { phase: "loading" };
  const clientId = document.querySelector<HTMLMetaElement>('meta[name="cozytrip-paypal-client-id"]')?.content ?? "";
  mounted.set(
    key,
    mountPayPalCheckout(clientId, paypalOrderId, {
      ready: (button) => {
        ui.checkouts[key] = { phase: "ready", button };
        paint();
      },
      approve: () => {
        // Approval is not payment. The only thing it does is ask the server about this same order.
        ui.checkouts[key] = { phase: "unconfirmed" };
        return runTool(check, "PayPal reported an approval in the card, so CozyTrip checked this order.");
      },
      cancel: () => {
        ui.notice = "PayPal was closed. No verified payment yet.";
        paint();
      },
      failed: () => {
        ui.notice = "No verified result for this step.";
        paint();
      },
      fallback: () => {
        ui.checkouts[key] = { phase: "fallback", ...(app.getHostCapabilities()?.openLinks ? {} : { manualLink: approveUrl }) };
        ui.notice = "PayPal button unavailable. Open PayPal instead.";
        paint();
      },
    }),
  );
}

/** Keeps one live control per order on the current card, and drops the rest with their old callbacks */
function syncCheckouts(): void {
  const targets = checkoutTargets(view);
  for (const [key, dispose] of mounted) {
    if (!targets.some((t) => t.key === key)) {
      dispose();
      mounted.delete(key);
      delete ui.checkouts[key];
    }
  }
  for (const target of targets) if (!mounted.has(target.key)) mountCheckout(target);
}

function paint(): void {
  ui.now = Date.now();
  syncCheckouts();
  render(root, view, actions, ui);
}

function applyTheme(ctx: HostContext): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

async function runTool(action: CardAction, happened: string): Promise<void> {
  ui.busy = true;
  ui.notice = null;
  paint();
  try {
    const result = await app.callServerTool({ name: action.tool, arguments: action.args });
    view = cardFor(result.structuredContent);
    // A share still unpaid after a check keeps its row, so its sentence moves on from "come back".
    for (const c of Object.values(ui.checkouts)) if (c.phase === "opened") c.phase = "unconfirmed";
    try {
      // Tell the model what the person just did in the card, so the chat stays in step.
      await app.updateModelContext({ content: [{ type: "text", text: happened }, ...(result.content ?? [])] });
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

/** The card cannot reach a calendar, or any other tool on the host. It can only speak up in the chat. */
async function askChat(text: string): Promise<void> {
  const said = "Sent to the chat. Reminders are not set until the chat reports the calendar result.";
  const sayIt = `Your chat app did not take that from the card. Say "${text}" in the chat instead.`;
  ui.busy = true;
  ui.notice = null;
  paint();
  try {
    const res = app.getHostCapabilities()?.message ? await app.sendMessage({ role: "user", content: [{ type: "text", text }] }) : { isError: true };
    ui.notice = res.isError ? sayIt : said;
  } catch {
    ui.notice = sayIt;
  } finally {
    ui.busy = false;
    paint();
  }
}

const actions = {
  // Pressing the button is the consent for that step. The server still checks every input.
  run: (action: CardAction) =>
    void (action.message ? askChat(action.message) : runTool(action, `The person pressed "${action.label}" on the CozyTrip card. Do not ask them to confirm this step again.`)),
  openCheckout: async (key: string, url: string) => {
    const manual = () => {
      ui.checkouts[key] = { ...ui.checkouts[key], manualLink: url };
      ui.notice = LINK_FAILED;
    };
    if (!app.getHostCapabilities()?.openLinks) {
      manual();
      paint();
      return;
    }
    ui.busy = true;
    paint();
    try {
      const res = await app.openLink({ url });
      if (res.isError) manual();
      else {
        // The tab being open says nothing about payment, so the card now only offers to check.
        ui.checkouts[key] = { phase: "opened", linkOpened: true };
        ui.notice = null;
      }
    } catch {
      manual();
    } finally {
      ui.busy = false;
      paint();
    }
  },
};

app.ontoolresult = (result) => {
  view = cardFor(result.structuredContent);
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
