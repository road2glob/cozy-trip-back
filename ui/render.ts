// DOM rendering for the card. Text always goes in through text nodes (never innerHTML).
import { quoteStage, type CardView, type ImpactView, type PaymentView, type QuoteView, type RunView, type StepView } from "./views";

type Child = Node | string | null | undefined | false;
type Attr = string | boolean | ((e: Event) => void) | undefined;

function h(tag: string, attrs: Record<string, Attr> = {}, ...children: Array<Child | Child[]>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string[]> = {
  pin: ["M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0", "M12 7a3 3 0 1 0 0 6 3 3 0 1 0 0-6"],
  flight: [
    "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
  ],
  hotel: ["M2 4v16", "M2 8h18a2 2 0 0 1 2 2v10", "M2 17h20", "M6 8v9"],
  transfer: [
    "M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2",
    "M7 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4",
    "M9 17h6",
    "M17 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4",
  ],
  activity: [
    "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
    "M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76",
    "M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6",
    "M12 10v4",
    "M12 2v3",
  ],
  check: ["M20 6 9 17l-5-5"],
  clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20", "M12 6v6l4 2"],
  info: ["M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20", "M12 16v-4", "M12 8h.01"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
};

function icon(name: string, cls = "icon"): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: cls })) {
    svg.setAttribute(k, v);
  }
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

export interface Actions {
  importSample(): void;
  previewImpact(tripId: string): void;
  confirmImpact(v: ImpactView): void;
  options(tripId: string): void;
  quote(tripId: string): void;
  approve(q: QuoteView): void;
  openCheckout(p: PaymentView): void;
  verify(tripId: string, runId: string): void;
  refresh(tripId: string): void;
}

export interface UiState {
  busy: boolean;
  notice: string | null;
  manualLink: string | null;
  now: number;
  paypal?: { phase: "loading" | "ready" | "fallback" | "verifying"; button?: HTMLElement };
}

const brand = () => h("div", { class: "brand" }, h("span", { class: "logo" }, icon("pin", "icon icon-sm")), h("span", {}, "CozyTrip"));
const chip = (text: string, tone = "neutral", iconName?: string) => h("span", { class: `chip chip-${tone}` }, iconName ? icon(iconName, "icon icon-xs") : null, text);
const button = (label: string, onClick: () => void, ui: UiState, kind: "primary" | "secondary" = "primary", iconName?: string) =>
  h("button", { type: "button", class: `btn btn-${kind}`, disabled: ui.busy, onclick: () => onClick() }, label, iconName ? icon(iconName, "icon icon-sm") : null);
const note = (text: string) => h("p", { class: "note" }, icon("info", "icon icon-sm muted"), h("span", {}, text));
const stubBanner = () => h("div", { class: "banner" }, h("span", { class: "mono label" }, "LOCAL STUB"), h("span", {}, "Local contract stub. No PayPal order was created."));
const sandboxBanner = () => h("div", { class: "banner banner-solid" }, h("span", { class: "mono label" }, "PAYPAL SANDBOX"), h("span", {}, "Real PayPal Sandbox transaction."));
const notice = (ui: UiState) => (ui.notice ? h("p", { class: "notice", role: "status" }, ui.notice) : null);

function stepRow(s: StepView, last: boolean): HTMLElement {
  return h(
    "li",
    { class: `step step-${s.state}` },
    h("div", { class: "rail" }, h("span", { class: "dot" }, s.state === "done" ? icon("check", "icon icon-xs") : null), last ? null : h("span", { class: "line" })),
    h("div", { class: "step-text" }, h("span", { class: "step-label" }, s.label), s.detail ? h("span", { class: "muted small" }, s.detail) : null),
  );
}

function runBlock(r: RunView): HTMLElement {
  return h(
    "section",
    { class: "run" },
    h("div", { class: "row between" }, h("h3", {}, "After-sales service fee"), chip(r.label, r.tone, r.tone === "warning" ? "clock" : undefined)),
    h("span", { class: "mono muted small" }, r.runId),
    h("ol", { class: "steps" }, r.steps.map((s, i) => stepRow(s, i === r.steps.length - 1))),
    r.chargeOutcome ? h("p", { class: "small" }, `Receipt: chargeOutcome ${r.chargeOutcome}`) : null,
  );
}

export function render(root: HTMLElement, view: CardView, actions: Actions, ui: UiState): void {
  root.setAttribute("aria-busy", ui.busy ? "true" : "false");
  let body: Array<Child | Child[]>;
  switch (view.kind) {
    case "empty":
      body = [
        h("h2", {}, "No trips yet"),
        h("p", { class: "muted" }, "Your ledger is empty. Nothing has been imported and there are no payment-service runs."),
        h("div", { class: "actions" }, button("Import the sample trip", actions.importSample, ui), h("span", { class: "muted small" }, "Uses fictional travel data.")),
      ];
      break;
    case "trip":
      body = [
        h("div", { class: "chips" }, view.simulated ? chip("Simulated travel data") : null, chip("Draft", "accent")),
        h("h2", {}, view.title),
        h("p", { class: "muted" }, `${view.dates} · ${view.travelers.length} travelers`),
        h("p", {}, view.travelers.map((t, i) => `${i ? ", " : ""}${t.name}${t.organizer ? " (organizer)" : ""}`).join("")),
        h(
          "ul",
          { class: "list" },
          view.bookings.map((b) =>
            h(
              "li",
              { class: "item" },
              h("span", { class: "item-icon" }, icon(b.kind in ICONS ? b.kind : "activity")),
              h("div", { class: "item-text" }, h("span", { class: "strong" }, b.title), h("span", { class: "muted small" }, b.detail)),
              h("span", { class: "amount" }, b.amount),
            ),
          ),
        ),
        h("div", { class: "row between total" }, h("span", { class: "muted" }, "Trip total"), h("span", { class: "amount big" }, view.total)),
        view.balances.length
          ? h("div", { class: "panel" }, view.balances.map((b) => h("div", { class: "row between" }, h("span", {}, b.text), h("span", { class: "amount" }, b.amount))))
          : null,
        view.demoArmed ? note("A demo flight cancellation is armed, not fired. No payment-service run was started.") : null,
        h("div", { class: "actions" }, button("Preview the demo impact", () => actions.previewImpact(view.tripId), ui, "secondary")),
      ];
      break;
    case "impact":
      body = [
        h("div", { class: "chips" }, chip("Simulated travel data"), view.preview ? chip("Preview · nothing changed") : chip("Confirmed simulation", "accent", "check")),
        h("h2", {}, "Demo flight cancellation"),
        h(
          "ul",
          { class: "list" },
          view.rows.map((r) =>
            h(
              "li",
              { class: "item" },
              h("div", { class: "item-text" }, h("span", { class: "strong" }, r.label), h("span", { class: "muted small" }, r.evidence), h("span", { class: "mono muted" }, r.rule)),
              chip(r.statusLabel, r.tone, r.tone === "danger" ? "alert" : r.tone === "warning" ? "clock" : "check"),
            ),
          ),
        ),
        note("No airline was contacted. No refund was requested."),
        view.preview
          ? h("div", { class: "actions" }, button("Confirm this simulated cancellation", () => actions.confirmImpact(view), ui), h("span", { class: "muted small" }, "Free · no payment"))
          : h(
              "div",
              { class: "actions" },
              button("See recovery options", () => actions.options(view.tripId), ui, "secondary"),
              button("Get the after-sales quote", () => actions.quote(view.tripId), ui),
            ),
      ];
      break;
    case "options":
      body = [
        h("h2", {}, "Recovery options"),
        h(
          "ul",
          { class: "list" },
          view.options.map((o) =>
            h(
              "li",
              { class: "item" },
              h(
                "div",
                { class: "item-text" },
                h("span", { class: "strong" }, o.title),
                h("span", { class: "small" }, o.summary),
                h("span", { class: "muted small" }, o.timing),
                h("span", { class: "muted small" }, o.limitations),
              ),
              o.cost ? h("span", { class: "amount" }, o.cost) : null,
            ),
          ),
        ),
        note("No purchase, submission or merchant contact was made."),
        h("div", { class: "actions" }, button("Get the after-sales quote", () => actions.quote(view.tripId), ui)),
      ];
      break;
    case "delivery":
      body = view.paid
        ? [
            chip("Payment verified", "accent", "check"),
            h("h2", {}, "Your prepared drafts"),
            h(
              "ul",
              { class: "list" },
              view.materials.map((m) => h("li", { class: "item" }, h("div", { class: "item-text" }, h("span", { class: "strong" }, m.kind), h("span", { class: "small pre" }, m.text)))),
            ),
            h("div", { class: "chips" }, chip(`Tracking: ${view.trackingState || "prepared"}`)),
            note("Drafts only. Not sent. Only you can send them to merchants."),
          ]
        : [
            chip("Not confirmed yet", "warning", "clock"),
            h("h2", {}, "Payment not confirmed yet"),
            h("p", { class: "muted" }, "No materials until the receipt shows the capture and a passed verification."),
            h("div", { class: "actions" }, button("Check again", () => actions.verify(view.tripId, view.runId), ui, "secondary")),
          ];
      break;
    case "quote": {
      const s = quoteStage(view, ui.now);
      const side =
        s.stage === "approve"
          ? h("div", { class: "col right" }, h("span", { class: "muted small" }, "Code expires"), h("span", { class: "strong" }, `in ${s.minutesLeft} min`))
          : s.stage === "approved"
            ? chip("Approved", "accent", "check")
            : chip("Code expired", "neutral");
      const next =
        s.stage === "approve"
          ? [button(`Approve ${view.price} service fee`, () => actions.approve(view), ui)]
          : s.stage === "approved"
            ? [button("Show the payment link", () => actions.approve(view), ui)]
            : [button("Get a new quote", () => actions.quote(view.tripId), ui, "secondary")];
      body = [
        view.stub ? stubBanner() : null,
        h("h2", {}, view.title),
        h(
          "div",
          { class: "panel row between end" },
          h("div", { class: "col" }, h("span", { class: "price" }, view.price), h("span", { class: "muted small" }, "per verified result · from the payment-service price list")),
          side,
        ),
        h(
          "ol",
          { class: "numbered" },
          h("li", {}, `You approve the ${view.price} service fee here.`),
          h("li", {}, "CozyTrip creates a PayPal Sandbox order. You approve it on PayPal."),
          h("li", {}, "The recovery pack comes only after the payment is captured and the result is verified."),
        ),
        h("div", { class: "actions" }, ...next),
        h(
          "p",
          { class: "muted small" },
          s.stage === "approved"
            ? "You approved this fee earlier. The same payment link opens again; no second order is created."
            : s.stage === "expired"
              ? "This confirmation code expired. A new quote opens a new run; nothing was charged."
              : "No PayPal order exists until you approve.",
        ),
      ];
      break;
    }
    case "paypal_checkout":
      body = [
        h("p", {}, "Real PayPal Sandbox transaction"),
        h("h2", {}, "Open PayPal"),
        h("p", {}, "PayPal Sandbox — test money only"),
        view.displayAmount ? h("p", { class: "price" }, view.displayAmount) : null,
        ui.paypal?.phase === "verifying"
          ? h("div", {}, h("p", { role: "status" }, "No verified capture yet."), h("div", { class: "actions" }, button("Check again", () => actions.verify(view.tripId, view.runId), ui, "secondary")))
          : ui.paypal?.phase === "fallback"
          ? ui.manualLink
            ? h("p", { class: "small" }, "Copy this link into your browser: ", h("span", { class: "mono select" }, ui.manualLink))
            : h("div", { class: "actions" }, button("Open PayPal", () => actions.openCheckout(view), ui, "primary", "external"))
          : h("div", { class: "paypal-button-slot" }, ui.paypal?.button ?? h("p", { role: "status", class: "muted" }, "Loading PayPal…")),
        note("Not paid yet. Payment counts only when the receipt shows the capture and a passed verification."),
      ];
      break;
    case "payment":
      body = [
        view.stub ? stubBanner() : sandboxBanner(),
        chip(view.stateLabel, "warning", "clock"),
        h("h2", {}, view.stub ? "Approve the service fee on the stub checkout" : "Approve the service fee on PayPal Sandbox"),
        h(
          "div",
          { class: "panel grid2" },
          h("div", { class: "col" }, h("span", { class: "muted small" }, "Order"), h("span", { class: "mono" }, view.chargeId)),
          h("div", { class: "col" }, h("span", { class: "muted small" }, "Run"), h("span", { class: "mono" }, view.runId)),
        ),
        h(
          "div",
          { class: "actions" },
          button(view.stub ? "Open stub checkout" : "Open PayPal Sandbox", () => actions.openCheckout(view), ui, "primary", "external"),
          button("Check my payment", () => actions.verify(view.tripId, view.runId), ui, "secondary"),
        ),
        ui.manualLink ? h("p", { class: "small" }, "Copy this link into your browser: ", h("span", { class: "mono select" }, ui.manualLink)) : null,
        note("Not paid yet. Payment counts only when the receipt shows the capture and a passed verification."),
      ];
      break;
    case "status":
      body = [
        ...view.trips.map((t) =>
          h(
            "div",
            { class: "panel row between" },
            h("div", { class: "col" }, h("span", { class: "strong" }, t.title), h("span", { class: "muted small" }, `${t.dates} · ${t.bookings} bookings${t.simulated ? " · Simulated travel data" : ""}`)),
            chip(t.state === "draft" ? "Draft" : t.state, "accent"),
          ),
        ),
        view.runs.length ? view.runs.map(runBlock) : h("p", { class: "muted" }, "No payment-service runs."),
        view.payments.length
          ? h(
              "div",
              { class: "panel" },
              h("span", { class: "strong small" }, "Airport pickup split (Sandbox)"),
              view.payments.map((p) => h("div", { class: "row between" }, h("span", {}, p.name), h("span", { class: "small muted" }, `${p.state}${p.prompt ? " · payment requested" : ""}`))),
            )
          : null,
        note("Returning from PayPal does not mean paid. The receipt decides."),
        view.trips[0] ? h("div", { class: "actions" }, button("Refresh", () => actions.refresh(view.trips[0].tripId), ui, "secondary")) : null,
      ];
      break;
    case "error":
      body = [h("div", { class: "row" }, icon("alert", "icon danger"), h("h2", {}, "That did not go through")), h("p", {}, view.message), h("p", { class: "mono muted small" }, view.code)];
      break;
    default:
      body = [h("p", { class: "muted" }, "Waiting for CozyTrip…")];
  }
  root.replaceChildren(h("div", { class: "card" }, brand(), ...body, notice(ui)));
}
