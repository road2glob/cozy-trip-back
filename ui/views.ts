// Pure view models: tool structuredContent -> what a card shows. No DOM here, so it is unit-tested.
// Amounts arrive as integer cents from the server and are only formatted here, never computed.
import { formatUsd } from "../src/domain/money";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

export type Tone = "neutral" | "accent" | "warning" | "danger" | "info";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-08" -> "Nov 8"; "2026-11-08T08:00" -> "Nov 8, 08:00". Local trip time, no time-zone math. */
export function formatLocal(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!m) return value;
  const day = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
  return m[4] ? `${day}, ${m[4]}:${m[5]}` : day;
}

export function minutesLeft(expiresAtIso: string, now: number): number | null {
  const t = Date.parse(expiresAtIso);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 60000)) : null;
}

const money = (minor: unknown) => {
  const n = num(minor);
  return n === null ? "" : formatUsd(n);
};

// ---- status (get_status) ------------------------------------------------------------------

const RUN_STATE: Record<string, { label: string; tone: Tone }> = {
  "awaiting-approval": { label: "Awaiting your approval", tone: "warning" },
  "awaiting-payment": { label: "Awaiting payment", tone: "warning" },
  running: { label: "In progress", tone: "info" },
  verifying: { label: "Verifying", tone: "info" },
  verified: { label: "Verified", tone: "accent" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Rejected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const STEP_LABEL: Record<string, string> = {
  approval: "Approval",
  payment: "Payment",
  execute: "Execute",
  verify: "Verify",
  receipt: "Receipt",
};

export interface StepView {
  label: string;
  state: "done" | "current" | "todo" | "failed" | "skipped";
  detail: string;
}

export interface RunView {
  runId: string;
  label: string;
  tone: Tone;
  steps: StepView[];
  chargeOutcome: string | null;
}

export interface TripSummaryView {
  tripId: string;
  title: string;
  dates: string;
  bookings: number;
  state: string;
  simulated: boolean;
}

export interface SplitPaymentView {
  name: string;
  state: string;
  prompt: boolean;
}

export type StatusView = { kind: "empty" } | { kind: "status"; trips: TripSummaryView[]; runs: RunView[]; payments: SplitPaymentView[] };

function stepState(s: string): StepView["state"] {
  if (s === "succeeded") return "done";
  if (s === "running") return "current";
  if (s === "failed") return "failed";
  if (s === "skipped") return "skipped";
  return "todo";
}

export function statusView(sc: Rec): StatusView {
  const trips = arr(sc.trips);
  const runs = arr(sc.runs);
  if (trips.length === 0 && runs.length === 0) return { kind: "empty" };
  return {
    kind: "status",
    trips: trips.map((t) => ({
      tripId: str(t.trip_id),
      title: str(t.title),
      dates: `${formatLocal(str(t.start_date))} – ${formatLocal(str(t.end_date))}`,
      bookings: num(t.booking_count) ?? 0,
      state: str(t.state),
      simulated: t.reality === "fictional_sample",
    })),
    runs: runs.map((r) => {
      const st = RUN_STATE[str(r.state)] ?? { label: str(r.state), tone: "neutral" as Tone };
      return {
        runId: str(r.runId),
        label: st.label,
        tone: st.tone,
        steps: arr(r.steps).map((s) => ({ label: STEP_LABEL[str(s.name)] ?? str(s.name), state: stepState(str(s.state)), detail: str(s.detail) })),
        chargeOutcome: typeof r.chargeOutcome === "string" ? r.chargeOutcome : null,
      };
    }),
    payments: arr(sc.split_payments).map((p) => ({ name: str(p.name), state: str(p.state), prompt: p.prompt === true })),
  };
}

// ---- trip (import_orders) -----------------------------------------------------------------

export interface BookingView {
  kind: string;
  title: string;
  detail: string;
  amount: string;
}

export interface TripView {
  tripId: string;
  title: string;
  dates: string;
  travelers: Array<{ name: string; organizer: boolean }>;
  bookings: BookingView[];
  total: string;
  balances: Array<{ text: string; amount: string }>;
  simulated: boolean;
  demoArmed: boolean;
}

export function tripView(sc: Rec): TripView {
  const balances = arr(sc.balances);
  const payerFor = new Map(balances.map((b) => [str(b.booking_id), str(b.to)]));
  const bookings = arr(sc.bookings);
  const titleById = new Map(bookings.map((b) => [str(b.booking_id), str(b.title)]));
  return {
    tripId: str(sc.trip_id),
    title: str(sc.title),
    dates: `${formatLocal(str(sc.start_date))} – ${formatLocal(str(sc.end_date))}`,
    travelers: arr(sc.participants).map((p) => ({ name: str(p.name), organizer: p.role === "organizer" })),
    bookings: bookings.map((b) => {
      const parts = [formatLocal(str(b.local_start))];
      const linked = titleById.get(str(b.linked_booking_id));
      if (linked) parts.push(`linked to ${linked}`);
      const payer = payerFor.get(str(b.booking_id));
      if (payer) parts.push(`prepaid by ${payer}`);
      return { kind: str(b.kind), title: str(b.title), detail: parts.join(" · "), amount: money(b.amount_minor) };
    }),
    total: money(sc.total_minor),
    balances: balances.map((b) => ({ text: `${str(b.from)} owes ${str(b.to)}`, amount: money(b.amount_minor) })),
    simulated: sc.reality === "fictional_sample",
    demoArmed: sc.demo_event === "armed",
  };
}

// ---- quote (quote_service) ----------------------------------------------------------------

export interface QuoteView {
  tripId: string;
  runId: string;
  title: string;
  price: string;
  code: string;
  expiresAt: string;
  /** Run state from the service: awaiting-approval until the person approves */
  state: string;
  stub: boolean;
}

export function quoteView(sc: Rec): QuoteView {
  const price = isRec(sc.price) ? sc.price : {};
  return {
    tripId: str(sc.trip_id),
    runId: str(sc.runId),
    title: str(sc.title) || "CozyTrip Team after-sales",
    price: money(price.amountMinor),
    code: str(sc.confirmation_code),
    expiresAt: str(sc.expires_at),
    state: str(sc.state),
    stub: sc.reality === "local_stub",
  };
}

/** What the quote card offers: approve, a new quote (code expired), or the existing payment link (already approved) */
export function quoteStage(q: QuoteView, now: number): { stage: "approve"; minutesLeft: number } | { stage: "expired" } | { stage: "approved" } {
  if (q.state && q.state !== "awaiting-approval") return { stage: "approved" };
  const left = minutesLeft(q.expiresAt, now);
  if (left === null || left <= 0) return { stage: "expired" };
  return { stage: "approve", minutesLeft: left };
}

// ---- payment (create_service_payment) -----------------------------------------------------

export interface PaymentView {
  tripId: string;
  runId: string;
  chargeId: string;
  approveUrl: string;
  stateLabel: string;
  stub: boolean;
  replay: boolean;
}

export interface PayPalCheckoutView extends PaymentView {
  paypalOrderId: string;
  displayAmount: string;
}

export function paymentView(sc: Rec): PaymentView {
  const state = str(sc.state);
  return {
    tripId: str(sc.trip_id),
    runId: str(sc.runId),
    chargeId: str(sc.chargeId),
    approveUrl: str(sc.approveUrl),
    stateLabel: state === "awaiting-payment" ? "Awaiting payment" : state,
    stub: sc.reality === "local_stub",
    replay: sc.replay === true,
  };
}

// ---- impact (detect_impact) ---------------------------------------------------------------

// The impact entries carry no booking title; the rule id says which booking it is.
const RULE_LABEL: Record<string, string> = {
  "R-FLIGHT-DEMO": "Flight",
  "R-TRANSFER-FLIGHT-LINKED": "Airport pickup",
  "R-HOTEL-SAME-DAY": "Hotel",
  "R-ACTIVITY-DATE-MISMATCH": "Activity",
};

const IMPACT_STATUS: Record<string, { label: string; tone: Tone }> = {
  disrupted: { label: "Disrupted", tone: "danger" },
  at_risk: { label: "At risk", tone: "warning" },
  unaffected: { label: "Unaffected", tone: "info" },
};

export interface ImpactView {
  tripId: string;
  /** true: nothing changed yet, a local code confirms it */
  preview: boolean;
  code: string;
  runId: string;
  rows: Array<{ label: string; statusLabel: string; tone: Tone; evidence: string; rule: string }>;
}

export function impactView(sc: Rec): ImpactView {
  return {
    tripId: str(sc.trip_id),
    preview: sc.preview === true,
    code: sc.codeKind === "local" ? str(sc.confirmation_code) : "",
    runId: str(sc.runId),
    rows: arr(sc.impacts).map((i) => {
      const st = IMPACT_STATUS[str(i.status)] ?? { label: str(i.status), tone: "neutral" as Tone };
      return { label: RULE_LABEL[str(i.rule)] ?? "Booking", statusLabel: st.label, tone: st.tone, evidence: str(i.evidence), rule: str(i.rule) };
    }),
  };
}

// ---- options (plan_options) ---------------------------------------------------------------

const OPTION_TITLE: Record<string, string> = {
  "airline-rebooking": "Rebook with the airline",
  "coordinate-bookings": "Coordinate the hotel and pickup",
  "cozytrip-drafts": "CozyTrip prepared drafts",
};

export interface OptionsView {
  tripId: string;
  issueId: string;
  options: Array<{ kind: string; title: string; summary: string; timing: string; limitations: string; cost: string | null }>;
}

export function optionsView(sc: Rec): OptionsView {
  return {
    tripId: str(sc.trip_id),
    issueId: str(sc.issue_id),
    options: arr(sc.options).map((o) => ({
      kind: str(o.kind),
      title: OPTION_TITLE[str(o.kind)] ?? str(o.kind),
      summary: str(o.summary),
      timing: str(o.timing),
      limitations: str(o.limitations),
      cost: num(o.cost_minor) === null ? null : money(o.cost_minor),
    })),
  };
}

// ---- delivery (verify_payment) ------------------------------------------------------------

export interface DeliveryView {
  tripId: string;
  runId: string;
  paid: boolean;
  materials: Array<{ kind: string; text: string }>;
  trackingState: string;
}

export function deliveryView(sc: Rec): DeliveryView {
  const output = isRec(sc.output) ? sc.output : {};
  return {
    tripId: str(sc.trip_id),
    runId: str(sc.runId),
    // Materials only count when the server says paid (receipt passed + captured); never inferred here.
    paid: sc.paid === true,
    materials: sc.paid === true ? arr(output.materials).map((m) => ({ kind: str(m.kind), text: str(m.text) })) : [],
    trackingState: str(sc.trackingState),
  };
}

// ---- dispatch -------------------------------------------------------------------------------

export type CardView =
  | { kind: "error"; code: string; message: string }
  | StatusView
  | ({ kind: "trip" } & TripView)
  | ({ kind: "impact" } & ImpactView)
  | ({ kind: "options" } & OptionsView)
  | ({ kind: "quote" } & QuoteView)
  | ({ kind: "payment" } & PaymentView)
  | ({ kind: "paypal_checkout" } & PayPalCheckoutView)
  | ({ kind: "delivery" } & DeliveryView)
  | { kind: "unknown" };

/** Picks the card from the shape of structuredContent, so one page serves every tool that links it */
export function cardFor(structured: unknown): CardView {
  if (!isRec(structured)) return { kind: "unknown" };
  if (isRec(structured.error)) return { kind: "error", code: str(structured.error.code), message: str(structured.error.message) };
  if (structured.view === "paypal_checkout" && structured.reality === "paypal_sandbox" && structured.state === "awaiting-payment" &&
      typeof structured.paypalOrderId === "string" && structured.paypalOrderId && typeof structured.approveUrl === "string" && "chargeId" in structured) {
    return { kind: "paypal_checkout", ...paymentView(structured), paypalOrderId: structured.paypalOrderId, displayAmount: str(structured.display_amount) };
  }
  if (typeof structured.approveUrl === "string" && "chargeId" in structured) return { kind: "payment", ...paymentView(structured) };
  if (structured.codeKind === "approval") return { kind: "quote", ...quoteView(structured) };
  if (Array.isArray(structured.impacts)) return { kind: "impact", ...impactView(structured) };
  if (Array.isArray(structured.options)) return { kind: "options", ...optionsView(structured) };
  if (typeof structured.paid === "boolean" && "output" in structured) return { kind: "delivery", ...deliveryView(structured) };
  if (Array.isArray(structured.bookings) && "total_minor" in structured) return { kind: "trip", ...tripView(structured) };
  if (Array.isArray(structured.trips) && Array.isArray(structured.runs)) return statusView(structured);
  return { kind: "unknown" };
}
