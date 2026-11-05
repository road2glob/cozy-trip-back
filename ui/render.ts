// DOM rendering for the card. Text always goes in through text nodes (never innerHTML).
import { checkFee, checkShares, checkoutKey, quoteStage, shareKey, type CardAction, type CardView, type RunView, type StepView } from "./views";

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
  /** Calls a tool through the host. The server checks every input as it does for the model. */
  run(action: CardAction): void;
  openCheckout(key: string, url: string): void;
}

/** One payment control: the in-card button until it fails, then a link, then a check of the same order */
export interface CheckoutUi {
  phase: "loading" | "ready" | "fallback" | "opened" | "unconfirmed";
  button?: HTMLElement;
  /** Set when even the host's link did not work: copyable text is all that is left */
  manualLink?: string;
  /** The link was opened at least once, so it can be offered again */
  linkOpened?: boolean;
}

export interface UiState {
  busy: boolean;
  notice: string | null;
  now: number;
  checkouts: Record<string, CheckoutUi>;
}

const brand = () => h("div", { class: "brand" }, h("span", { class: "logo" }, icon("pin", "icon icon-sm")), h("span", {}, "CozyTrip"));
const sampleTag = (text: string) => h("span", { class: "chip chip-sim" }, text);
const chip = (text: string, tone = "neutral", iconName?: string) => h("span", { class: `chip chip-${tone}` }, iconName ? icon(iconName, "icon icon-xs") : null, text);
const button = (label: string, onClick: () => void, ui: UiState, kind: "primary" | "secondary" = "primary", iconName?: string, ariaLabel?: string) =>
  h("button", { type: "button", class: `btn btn-${kind}`, disabled: ui.busy, "aria-label": ariaLabel, onclick: () => onClick() }, label, iconName ? icon(iconName, "icon icon-sm") : null);
const note = (text: string) => h("p", { class: "note" }, icon("info", "icon icon-sm muted"), h("span", {}, text));
const stubBanner = () => h("div", { class: "banner" }, h("span", { class: "mono label" }, "LOCAL STUB"), h("span", {}, "Local contract stub. No PayPal order was created."));
const notice = (ui: UiState) => (ui.notice ? h("p", { class: "notice", role: "status" }, ui.notice) : null);

/** The first allowed step is the main action. A second, if any, stays quiet. */
function actionRow(list: CardAction[], actions: Actions, ui: UiState, style: "primary" | "secondary" = "primary"): HTMLElement | null {
  if (list.length === 0) return null;
  return h(
    "div",
    { class: "actions" },
    list.slice(0, 2).map((a, i) => button(a.label, () => actions.run(a), ui, i === 0 ? style : "secondary")),
  );
}

function stepRow(s: StepView, last: boolean): HTMLElement {
  return h(
    "li",
    { class: `step step-${s.state}` },
    h("div", { class: "rail" }, h("span", { class: "dot" }, s.state === "done" ? icon("check", "icon icon-xs") : null), last ? null : h("span", { class: "line" })),
    h("div", { class: "step-text" }, h("span", { class: "step-label" }, s.label), s.detail ? h("span", { class: "muted small" }, s.detail) : null),
  );
}

/** Internal IDs and steps stay out of the way until someone asks for them */
function runDetails(runs: RunView[]): HTMLElement | null {
  if (runs.length === 0) return null;
  return h(
    "details",
    { class: "details" },
    h("summary", {}, "Details"),
    runs.map((r) =>
      h(
        "div",
        { class: "run" },
        h("span", { class: "mono muted small" }, r.runId),
        h("ol", { class: "steps" }, r.steps.map((s, i) => stepRow(s, i === r.steps.length - 1))),
        r.chargeOutcome ? h("p", { class: "small muted" }, `Receipt: ${r.chargeOutcome}`) : null,
      ),
    ),
  );
}

const manualLink = (url: string) => h("p", { class: "small" }, "Copy this link into your browser: ", h("span", { class: "mono select" }, url));

/** The sentence or control for one order, by how far its payment has got */
function checkoutStatus(c: CheckoutUi | undefined): Child {
  if (c?.manualLink) return manualLink(c.manualLink);
  switch (c?.phase) {
    case "ready":
      return h("div", { class: "paypal-button-slot" }, c.button);
    case "opened":
      return h("p", { role: "status" }, "Complete the payment in PayPal, then come back.");
    case "unconfirmed":
      return h("p", { role: "status" }, "No verified capture yet.");
    case "fallback":
      return null;
    default:
      return h("p", { role: "status", class: "muted" }, "Loading PayPal…");
  }
}

/** After a link opens or fails, or PayPal approves, only a check of this same order can tell the result. */
const needsCheck = (c: CheckoutUi | undefined) => c?.phase === "opened" || c?.phase === "unconfirmed" || !!c?.manualLink;

function openButton(key: string, url: string, c: CheckoutUi | undefined, label: string, actions: Actions, ui: UiState, ariaLabel?: string): Child {
  if (c?.manualLink) return null;
  if (c?.phase === "fallback") return button(label, () => actions.openCheckout(key, url), ui, "primary", "external", ariaLabel);
  if (c?.linkOpened) return button("Open PayPal again", () => actions.openCheckout(key, url), ui, "secondary", "external", ariaLabel && `${ariaLabel} again`);
  return null;
}

const REMINDER_STATE: Record<string, string> = { written: "In your calendar", needs_update: "Needs updating", failed: "Not set" };

const PENDING: Record<string, { title: string; body: string }> = {
  unconfirmed: { title: "No verified capture yet.", body: "No drafts until PayPal Sandbox shows the capture and it passes verification." },
  checking: { title: "Checking this order", body: "No new payment is needed. Drafts appear once the check passes." },
  not_confirmed: { title: "Not confirmed yet", body: "No order exists and nothing is paid." },
  closed: { title: "This order is closed", body: "No drafts were delivered from it." },
};

const SIMULATED = "Simulated travel data";

export function render(root: HTMLElement, view: CardView, actions: Actions, ui: UiState): void {
  root.setAttribute("aria-busy", ui.busy ? "true" : "false");
  let body: Array<Child | Child[]>;
  // Beside the name rather than on a row of its own, so the card opens on its one sentence.
  let tag: Child = null;
  switch (view.kind) {
    case "empty":
      body = [
        h("h2", {}, "No trips yet"),
        h("p", { class: "muted" }, "CozyTrip is connected."),
        actionRow(view.actions, actions, ui),
        h("p", { class: "muted small" }, "Uses fictional travel data."),
      ];
      break;
    case "trip":
      tag = view.simulated ? sampleTag(SIMULATED) : null;
      body = [
        h("h2", {}, view.title),
        h("p", { class: "muted" }, `${view.dates} · ${view.travelers.length} travelers: ${view.travelers.map((t) => t.name).join(", ")}`),
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
        actionRow(view.actions, actions, ui),
      ];
      break;
    case "reconcile":
      body = [
        h("h2", {}, "Orders checked"),
        h("p", {}, `${view.bookings} bookings and their expenses both come to ${view.total}.`),
        h("p", { class: "muted small" }, "No mismatch. No payment is needed and no merchant was contacted."),
      ];
      break;
    case "impact":
      tag = sampleTag(SIMULATED);
      body = [
        h("h2", {}, view.preview ? "Preview: a fictional flight cancellation" : "Simulated cancellation recorded"),
        view.preview ? h("p", { class: "muted" }, "Nothing has changed. Confirming records a simulation only: no real flight is cancelled, and it costs nothing.") : null,
        h(
          "ul",
          { class: "list" },
          view.rows.map((r) =>
            h(
              "li",
              { class: "item" },
              h(
                "div",
                { class: "item-text" },
                h("div", { class: "row between" }, h("span", { class: "strong" }, r.label), chip(r.statusLabel, r.tone)),
                h("span", { class: "muted small" }, `${r.provenance}. ${r.evidence}`),
              ),
            ),
          ),
        ),
        note("No airline was contacted. No refund was requested."),
        actionRow(view.actions, actions, ui),
      ];
      break;
    case "options":
      body = [
        h("h2", {}, "Recovery options"),
        h("p", { class: "muted" }, "Nothing has been bought. You can stop here."),
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
                h("div", { class: "row between" }, h("span", { class: "strong" }, o.title), o.cost ? h("span", { class: "amount" }, o.cost) : h("span", { class: "muted small nowrap" }, "Cost unknown")),
                h("span", { class: "small" }, o.summary),
                h("span", { class: "muted small" }, o.timing),
                h("span", { class: "muted small" }, o.limitations),
              ),
            ),
          ),
        ),
        // Offered, not pushed: nothing in this card is a main action.
        actionRow(view.actions, actions, ui, "secondary"),
      ];
      break;
    case "delivery":
      tag = view.paid ? chip("Payment verified.", "good", "check") : null;
      body = view.paid
        ? [
            h("h2", {}, "Your three drafts"),
            h(
              "ul",
              { class: "list" },
              view.materials.map((m, i) =>
                h(
                  "li",
                  { class: "item item-draft" },
                  h(
                    "details",
                    { class: "draft", open: i === 0 },
                    h("summary", {}, h("span", { class: "strong" }, m.title), h("span", { class: "muted small" }, "Draft. Not sent.")),
                    h("p", { class: "small pre" }, m.text),
                  ),
                ),
              ),
            ),
            h("p", { class: "muted small" }, "The merchants are fictional, so nothing needs sending. CozyTrip contacted no one."),
            h("p", { class: "muted small" }, `Progress: ${view.followUp}`),
          ]
        : [
            h("h2", {}, PENDING[view.pending].title),
            h("p", { class: "muted" }, PENDING[view.pending].body),
            actionRow(view.actions, actions, ui),
          ];
      break;
    case "quote": {
      const s = quoteStage(view, ui.now);
      body = [
        view.stub ? stubBanner() : null,
        h("h2", {}, view.title),
        h("p", { class: "price" }, view.price),
        view.scope.length ? h("ul", { class: "scope" }, view.scope.map((item) => h("li", {}, item))) : null,
        h("p", { class: "muted small" }, "Not a rebooking or hotel fee, and no refund is guaranteed."),
        s.stage === "approve"
          ? [
              h("p", { class: "muted small" }, "Not paid. No PayPal order exists until you confirm."),
              actionRow(view.actions, actions, ui),
              h("p", { class: "muted small" }, `This quote is good for ${s.minutesLeft} min.`),
            ]
          : s.stage === "approved"
            ? [h("p", { class: "muted small" }, "You confirmed this fee earlier. This uses the same order, not a new one."), actionRow(view.actions, actions, ui)]
            : [
                h("p", { class: "muted small" }, "This quote expired. No order was created from it."),
                h("div", { class: "actions" }, button("Get a new quote", () => actions.run({ label: "Get a new quote", tool: "quote_service", args: { trip_id: view.tripId } }), ui, "secondary")),
              ],
      ];
      break;
    }
    case "paypal_checkout":
    case "payment": {
      const key = checkoutKey(view);
      const c = ui.checkouts[key];
      const real = view.kind === "paypal_checkout";
      const openLabel = real ? "Open PayPal" : view.stub ? "Open stub checkout" : "Open PayPal Sandbox";
      const check = needsCheck(c) ? button("Check again", () => actions.run(checkFee(view.tripId, view.runId)), ui) : null;
      const open = openButton(key, view.approveUrl, c, openLabel, actions, ui);
      body = [
        view.stub ? stubBanner() : null,
        h("h2", {}, "Order ready. Not paid yet."),
        view.stub ? null : h("p", {}, "PayPal Sandbox — test money only"),
        view.displayAmount ? h("p", { class: "price" }, view.displayAmount) : null,
        checkoutStatus(c),
        check || open ? h("div", { class: "actions" }, check, open) : null,
        c?.phase === "ready" || c?.phase === "fallback" ? h("p", { class: "muted small" }, "Already paid? Say so in the chat and CozyTrip will check this same order.") : null,
      ];
      break;
    }
    case "split_quote":
      tag = sampleTag(SIMULATED);
      body = [
        h("h2", {}, "Split the airport pickup"),
        h("p", { class: "muted" }, `${view.total} prepaid by Maya, shared three ways.`),
        h(
          "ul",
          { class: "list" },
          view.rows.map((r) =>
            h(
              "li",
              { class: "item" },
              h("div", { class: "item-text" }, h("span", { class: "strong" }, r.name), h("span", { class: "muted small" }, r.prepaid ? "Prepaid in the sample" : `Share ${r.share}`)),
              h("span", { class: "amount" }, `${r.due} due`),
            ),
          ),
        ),
        note(view.notice),
        note(view.payeeNotice),
        actionRow(view.actions, actions, ui),
      ];
      break;
    case "split": {
      const payable = view.rows.filter((r) => r.payable);
      const anyCheck = payable.some((r) => needsCheck(ui.checkouts[shareKey(r)]));
      const openLabel = view.stub ? "Open stub checkout" : "Open PayPal";
      tag = sampleTag(SIMULATED);
      body = [
        h("h2", {}, view.rows.length === 0 ? "No share requests yet" : view.allPaid ? "All shares paid" : "Airport pickup shares"),
        view.rows.length
          ? h(
              "ul",
              { class: "list" },
              view.rows.map((r) => {
                const key = shareKey(r);
                const c = ui.checkouts[key];
                const open = r.payable ? openButton(key, r.approveUrl, c, openLabel, actions, ui, `Open PayPal for ${r.name}'s share`) : null;
                return h(
                  "li",
                  { class: "item item-stack" },
                  h(
                    "div",
                    { class: "row between" },
                    h("div", { class: "col" }, h("span", { class: "strong" }, `${r.name}'s share`), h("span", { class: "muted small" }, r.amount)),
                    chip(r.stateLabel, r.paid ? "good" : r.payable ? "warning" : "neutral", r.paid ? "check" : undefined),
                  ),
                  r.payable ? checkoutStatus(c) : null,
                  open ? h("div", { class: "actions" }, open) : null,
                );
              }),
            )
          : h("p", { class: "muted" }, "Nothing has been requested."),
        view.rows.length ? h("p", { class: "muted small" }, `${view.organizer.name} owes ${view.organizer.due} and has no payment.`) : null,
        payable.length ? h("p", { class: "muted small" }, "CozyTrip sends nothing to anyone. You can share these requests yourself.") : null,
        anyCheck ? h("div", { class: "actions" }, button("Check again", () => actions.run(checkShares(view.tripId)), ui)) : actionRow(view.actions, actions, ui),
        payable.some((r) => ["ready", "fallback"].includes(ui.checkouts[shareKey(r)]?.phase ?? "")) ? h("p", { class: "muted small" }, "Already paid? Say so in the chat and CozyTrip will check these shares.") : null,
        view.rows.length ? note(view.notice) : null,
        view.rows.length ? note(view.payeeNotice) : null,
      ];
      break;
    }
    case "reminder_plan": {
      const set = view.rows.filter((r) => r.state === "written").length;
      const changing = view.rows.filter((r) => r.state === "needs_update").length;
      const left = view.rows.length - set - changing;
      tag = sampleTag(view.label);
      body = [
        h("h2", {}, "Reminder plan"),
        h(
          "p",
          { class: "muted" },
          view.confirmed
            ? "You agreed to this plan. Your chat app will report the outcome of each calendar change."
            : changing || view.removals.length
              ? "Existing reminders stay scheduled until your calendar confirms each change."
            : view.rows.length === 0 && view.removals.length === 0
              ? "No reminder times are left on this trip."
              : set
                ? `${set} in your calendar, ${left} not set.`
                : "A plan only. Nothing is in your calendar yet.",
        ),
        view.rows.length
          ? h(
              "ul",
              { class: "list" },
              view.rows.map((r) =>
                h(
                  "li",
                  { class: "item" },
                  h(
                    "div",
                    { class: "item-text" },
                    h("div", { class: "row between" }, h("span", { class: "strong" }, r.what), REMINDER_STATE[r.state] ? chip(REMINDER_STATE[r.state], r.state === "written" ? "good" : "warning") : null),
                    h("span", { class: "small" }, `${r.when} · Beijing ${r.beijing}`),
                    h("span", { class: "muted small" }, r.lead),
                  ),
                ),
              ),
            )
          : null,
        view.removals.map((title) => h("p", { class: "small" }, `To remove from your calendar: ${title}`)),
        h("p", { class: "muted small" }, `Times are ${view.timezone}, with Beijing time beside them. Calendar: ${view.calendarName || "not chosen yet"}.`),
        actionRow(view.actions, actions, ui),
        view.actions.length ? h("p", { class: "muted small" }, "Want other times or fewer reminders? Say so in the chat.") : null,
        view.notes.length ? h("details", { class: "details" }, h("summary", {}, "Notes"), view.notes.map((n) => h("p", { class: "small" }, n))) : null,
      ];
      break;
    }
    case "reminder_results":
      body = [
        h("h2", {}, "Calendar result"),
        h("p", { class: "muted" }, "As reported by your chat app's calendar tool."),
        h(
          "ul",
          { class: "list" },
          view.rows.map((r) =>
            h(
              "li",
              { class: "item" },
              h(
                "div",
                { class: "item-text" },
                h("div", { class: "row between" }, h("span", { class: "strong" }, r.what), chip(r.outcome, r.failed ? "danger" : "good", r.failed ? undefined : "check")),
                r.when ? h("span", { class: "small" }, `${r.when} · Beijing ${r.beijing}`) : null,
                r.detail ? h("span", { class: "muted small" }, r.detail) : null,
              ),
            ),
          ),
        ),
        view.rejected ? h("p", { class: "small" }, `${view.rejected} could not be recorded and may not be set.`) : null,
        actionRow(view.actions, actions, ui),
        h("p", { class: "muted small" }, "CozyTrip does not watch your calendar. To continue later, ask CozyTrip in your chat."),
      ];
      break;
    case "case_preview":
      body = [
        h("h2", {}, `Record: ${view.proposed}?`),
        h("p", { class: "muted" }, `Currently: ${view.current}. Nothing is recorded until you confirm.`),
        view.note ? h("p", { class: "small" }, `Your note: ${view.note}`) : null,
        view.evidence ? h("p", { class: "small" }, `Your evidence: ${view.evidence}`) : null,
        h("p", { class: "muted small" }, "This covers the whole service order, not each draft. It is your report, and CozyTrip sends nothing."),
        actionRow(view.actions, actions, ui),
      ];
      break;
    case "case_record":
      body = [
        h("h2", {}, `Recorded: ${view.state}`),
        h("p", { class: "muted" }, "From your own report, for the whole service order. CozyTrip contacted no one."),
        view.note ? h("p", { class: "small" }, `Your note: ${view.note}`) : null,
        view.evidence ? h("p", { class: "small" }, `Your evidence: ${view.evidence}`) : null,
      ];
      break;
    case "status":
      tag = view.trips.some((t) => t.simulated) ? sampleTag(SIMULATED) : null;
      body = [
        ...view.trips.map((t) => [
          h("h2", {}, t.title),
          h("p", { class: "muted" }, `${t.dates} · ${t.bookings} bookings`),
        ]),
        view.runs.length || view.payments.length || view.followUp || view.reminders
          ? h(
              "ul",
              { class: "list" },
              view.runs.length ? h("li", { class: "item" }, h("div", { class: "item-text" }, h("span", { class: "muted small" }, "After-sales drafts"), h("span", {}, view.runs[view.runs.length - 1].sentence))) : null,
              view.followUp ? h("li", { class: "item" }, h("div", { class: "item-text" }, h("span", { class: "muted small" }, "Follow-up"), h("span", {}, `${view.followUp}${view.followUp === "Prepared" ? "" : " (your report)"}`))) : null,
              view.reminders
                ? h(
                    "li",
                    { class: "item" },
                    h("div", { class: "item-text" }, h("span", { class: "muted small" }, "Demo reminders"), h("span", {}, [view.reminders.written ? `${view.reminders.written} in your calendar` : "", view.reminders.failed ? `${view.reminders.failed} not set` : ""].filter(Boolean).join(" · "))),
                  )
                : null,
              view.payments.length
                ? h(
                    "li",
                    { class: "item" },
                    h("div", { class: "item-text" }, h("span", { class: "muted small" }, "Airport pickup shares"), h("span", {}, view.payments.map((p) => `${p.name}: ${p.stateLabel}`).join(" · "))),
                  )
                : null,
            )
          : null,
        actionRow(view.actions, actions, ui),
        runDetails(view.runs),
      ];
      break;
    case "error":
      body = [
        h("div", { class: "row" }, icon("alert", "icon danger"), h("h2", {}, "That did not go through")),
        h("p", {}, view.sentence),
        actionRow(view.actions, actions, ui, "secondary"),
        h("details", { class: "details" }, h("summary", {}, "Details"), h("p", { class: "small" }, view.message), h("p", { class: "mono" }, view.code)),
      ];
      break;
    default:
      body = [h("p", { class: "muted" }, "Waiting for CozyTrip…")];
  }
  root.replaceChildren(h("div", { class: "card" }, h("div", { class: "head" }, brand(), tag), ...body, notice(ui)));
}
