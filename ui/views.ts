// Pure view models: tool structuredContent -> what a card shows. No DOM here, so it is unit-tested.
// Amounts and next steps come from the server as they are; this file never computes a price or decides
// what is allowed.

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

// ---- actions --------------------------------------------------------------------------------

/** A button the server allows from this state. Pressing it calls this tool with these exact arguments. */
export interface CardAction {
  label: string;
  tool: string;
  args: Rec;
}

function cardActions(sc: Rec): CardAction[] {
  const guidance = isRec(sc.guidance) ? sc.guidance : {};
  return arr(guidance.next_steps).flatMap((s) =>
    typeof s.card_action === "string" && s.card_action && typeof s.tool === "string" && isRec(s.args) ? [{ label: s.card_action, tool: s.tool, args: s.args }] : [],
  );
}

const checkFee = (tripId: string, runId: string): CardAction => ({ label: "Check again", tool: "verify_payment", args: { trip_id: tripId, run_id: runId } });
const checkShares = (tripId: string): CardAction => ({ label: "Check again", tool: "split_status", args: { trip_id: tripId } });

// ---- status (get_status) ------------------------------------------------------------------

const RUN_SENTENCE: Record<string, string> = {
  "awaiting-approval": "Quoted. Not confirmed.",
  "awaiting-payment": "Order created. Not paid.",
  running: "Checking the order.",
  verifying: "Checking the order.",
  verified: "Payment verified. Drafts ready.",
  failed: "Closed without drafts.",
  rejected: "Closed without drafts.",
  cancelled: "Closed without drafts.",
};

const STEP_LABEL: Record<string, string> = {
  approval: "Approval",
  payment: "Payment",
  execute: "Execute",
  verify: "Verify",
  receipt: "Receipt",
};

const SHARE_LABEL: Record<string, string> = {
  captured: "Paid",
  "awaiting-payment": "Not paid",
  failed: "Payment failed",
  void: "Cancelled",
  creating: "Not ready",
};

const CASE_LABEL: Record<string, string> = {
  prepared: "Prepared",
  submitted_by_user: "Sent by you",
  awaiting_merchant: "Waiting for the merchant",
  merchant_responded: "Merchant replied",
};
const caseLabel = (state: string) => CASE_LABEL[state] ?? state;

export interface StepView {
  label: string;
  state: "done" | "current" | "todo" | "failed" | "skipped";
  detail: string;
}

export interface RunView {
  runId: string;
  sentence: string;
  steps: StepView[];
  chargeOutcome: string | null;
}

export interface TripSummaryView {
  tripId: string;
  title: string;
  dates: string;
  bookings: number;
  simulated: boolean;
}

export interface SplitPaymentView {
  name: string;
  state: string;
  stateLabel: string;
}

export type StatusView =
  | { kind: "empty"; actions: CardAction[] }
  | { kind: "status"; trips: TripSummaryView[]; runs: RunView[]; payments: SplitPaymentView[]; followUp: string | null; actions: CardAction[] };

function stepState(s: string): StepView["state"] {
  if (s === "succeeded") return "done";
  if (s === "running") return "current";
  if (s === "failed") return "failed";
  if (s === "skipped") return "skipped";
  return "todo";
}

function runSentence(state: string, chargeOutcome: string | null): string {
  if (chargeOutcome === "refund-required") return "Refund required. This is not a completed refund.";
  if (state === "verified" && chargeOutcome !== "captured") return "Closed without drafts.";
  return RUN_SENTENCE[state] ?? state;
}

export function statusView(sc: Rec): StatusView {
  const trips = arr(sc.trips);
  const runs = arr(sc.runs);
  const actions = cardActions(sc);
  if (trips.length === 0 && runs.length === 0) return { kind: "empty", actions };
  const followUp = arr(sc.service_orders).map((o) => str(o.trackingState)).at(-1);
  return {
    kind: "status",
    trips: trips.map((t) => ({
      tripId: str(t.trip_id),
      title: str(t.title),
      dates: `${formatLocal(str(t.start_date))} – ${formatLocal(str(t.end_date))}`,
      bookings: num(t.booking_count) ?? 0,
      simulated: t.reality === "fictional_sample",
    })),
    runs: runs.map((r) => {
      const chargeOutcome = typeof r.chargeOutcome === "string" ? r.chargeOutcome : null;
      return {
        runId: str(r.runId),
        sentence: runSentence(str(r.state), chargeOutcome),
        steps: arr(r.steps).map((s) => ({ label: STEP_LABEL[str(s.name)] ?? str(s.name), state: stepState(str(s.state)), detail: str(s.detail) })),
        chargeOutcome,
      };
    }),
    payments: arr(sc.split_payments).map((p) => ({ name: str(p.name), state: str(p.state), stateLabel: SHARE_LABEL[str(p.state)] ?? str(p.state) })),
    followUp: followUp ? caseLabel(followUp) : null,
    actions,
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
  simulated: boolean;
  actions: CardAction[];
}

export function tripView(sc: Rec): TripView {
  const payerFor = new Map(arr(sc.balances).map((b) => [str(b.booking_id), str(b.to)]));
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
      return { kind: str(b.kind), title: str(b.title), detail: parts.join(" · "), amount: str(b.display_amount) };
    }),
    total: str(sc.display_total),
    simulated: sc.reality === "fictional_sample",
    actions: cardActions(sc),
  };
}

// ---- reconcile (reconcile_trip) -------------------------------------------------------------

export interface ReconcileView {
  total: string;
  bookings: number;
}

// ---- quote (quote_service) ----------------------------------------------------------------

export interface QuoteView {
  tripId: string;
  title: string;
  price: string;
  scope: string[];
  expiresAt: string;
  /** Run state from the service: awaiting-approval until the person confirms */
  state: string;
  stub: boolean;
  actions: CardAction[];
}

export function quoteView(sc: Rec): QuoteView {
  return {
    tripId: str(sc.trip_id),
    title: str(sc.title) || "CozyTrip Team after-sales",
    price: str(sc.display_amount),
    scope: Array.isArray(sc.scope) ? sc.scope.map(str).filter(Boolean) : [],
    expiresAt: str(sc.expires_at),
    state: str(sc.state),
    stub: sc.reality === "local_stub",
    actions: cardActions(sc),
  };
}

/** What the quote card offers: confirm, a new quote (expired), or whatever the server allows once confirmed */
export function quoteStage(q: Pick<QuoteView, "state" | "expiresAt">, now: number): { stage: "approve"; minutesLeft: number } | { stage: "expired" } | { stage: "approved" } {
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
  stub: boolean;
}

export interface PayPalCheckoutView extends PaymentView {
  paypalOrderId: string;
  displayAmount: string;
}

export function paymentView(sc: Rec): PaymentView {
  return {
    tripId: str(sc.trip_id),
    runId: str(sc.runId),
    chargeId: str(sc.chargeId),
    approveUrl: str(sc.approveUrl),
    stub: sc.reality === "local_stub",
  };
}

// ---- impact (detect_impact) ---------------------------------------------------------------

const IMPACT_STATUS: Record<string, { label: string; tone: Tone }> = {
  disrupted: { label: "Disrupted", tone: "danger" },
  at_risk: { label: "At risk", tone: "warning" },
  unaffected: { label: "Unaffected", tone: "info" },
};

const PROVENANCE: Record<string, string> = { simulated: "Simulated", inferred: "Inferred", source: "From the booking" };

export interface ImpactView {
  tripId: string;
  /** true: nothing changed yet, the person still has to confirm */
  preview: boolean;
  rows: Array<{ label: string; statusLabel: string; tone: Tone; evidence: string; provenance: string }>;
  actions: CardAction[];
}

export function impactView(sc: Rec): ImpactView {
  return {
    tripId: str(sc.trip_id),
    preview: sc.preview === true,
    rows: arr(sc.impacts).map((i) => {
      const st = IMPACT_STATUS[str(i.status)] ?? { label: str(i.status), tone: "neutral" as Tone };
      return { label: str(i.title) || "Booking", statusLabel: st.label, tone: st.tone, evidence: str(i.evidence), provenance: PROVENANCE[str(i.provenance)] ?? str(i.provenance) };
    }),
    actions: cardActions(sc),
  };
}

// ---- options (plan_options) ---------------------------------------------------------------

export interface OptionsView {
  options: Array<{ kind: string; title: string; summary: string; timing: string; limitations: string; cost: string | null }>;
  actions: CardAction[];
}

export function optionsView(sc: Rec): OptionsView {
  return {
    options: arr(sc.options).map((o) => ({
      kind: str(o.kind),
      title: str(o.title) || str(o.kind),
      summary: str(o.summary),
      timing: str(o.timing),
      limitations: str(o.limitations),
      cost: str(o.display_cost) || null,
    })),
    actions: cardActions(sc),
  };
}

// ---- delivery (verify_payment) ------------------------------------------------------------

export type PendingKind = "unconfirmed" | "checking" | "not_confirmed" | "closed";

export interface DeliveryView {
  paid: boolean;
  /** What an unpaid result means. Only the server's own state decides this. */
  pending: PendingKind;
  materials: Array<{ title: string; text: string }>;
  followUp: string;
  actions: CardAction[];
}

function pendingKind(state: string): PendingKind {
  switch (state) {
    case "":
    case "awaiting-payment":
      return "unconfirmed";
    case "awaiting-approval":
      return "not_confirmed";
    case "running":
    case "verifying":
    case "captured":
      return "checking";
    default:
      return "closed";
  }
}

const NOT_SENT_LINE = /\n?Draft\. Not sent\.\s*$/;

export function deliveryView(sc: Rec): DeliveryView {
  const output = isRec(sc.output) ? sc.output : {};
  const tripId = str(sc.trip_id);
  const runId = str(sc.runId);
  const pending = pendingKind(str(sc.state));
  const actions = cardActions(sc);
  return {
    // Materials only count when the server says paid (receipt passed + captured); never inferred here.
    paid: sc.paid === true,
    pending,
    // The card shows "Draft. Not sent." beside each title, where it cannot be scrolled past.
    materials: sc.paid === true ? arr(output.materials).map((m) => ({ title: str(m.title) || str(m.kind), text: str(m.text).replace(NOT_SENT_LINE, "") })) : [],
    followUp: caseLabel(str(sc.trackingState) || "prepared"),
    actions: actions.length || sc.paid === true || !runId || pending === "closed" ? actions : [checkFee(tripId, runId)],
  };
}

// ---- split (quote_split, create_split_payments, split_status) --------------------------------

export interface SplitQuoteView {
  total: string;
  rows: Array<{ name: string; share: string; due: string; prepaid: boolean }>;
  notice: string;
  payeeNotice: string;
  actions: CardAction[];
}

export function splitQuoteView(sc: Rec): SplitQuoteView {
  return {
    total: str(sc.display_total),
    rows: arr(sc.shares).map((s) => ({ name: str(s.name), share: str(s.display_share), due: str(s.display_due), prepaid: s.sample_prepayment === true })),
    notice: str(sc.disclaimer),
    payeeNotice: str(sc.payee_notice),
    actions: cardActions(sc),
  };
}

export interface ShareView {
  paymentId: string;
  name: string;
  amount: string;
  state: string;
  stateLabel: string;
  paid: boolean;
  /** The server still prompts for this share and gave a link */
  payable: boolean;
  approveUrl: string;
  /** Only for a real, unpaid order. Never guessed or created in the browser. */
  paypalOrderId: string;
}

export interface SplitView {
  tripId: string;
  stub: boolean;
  /** Only a real Sandbox order can use the in-card button */
  realSandbox: boolean;
  rows: ShareView[];
  organizer: { name: string; due: string };
  allPaid: boolean;
  notice: string;
  payeeNotice: string;
  actions: CardAction[];
}

export function splitView(sc: Rec): SplitView {
  const rows = arr(sc.payments).map((p) => {
    const state = str(p.state);
    const approveUrl = str(p.approveUrl);
    return {
      paymentId: str(p.payment_id),
      name: str(p.name),
      amount: str(p.display_amount),
      state,
      stateLabel: SHARE_LABEL[state] ?? state,
      paid: state === "captured",
      payable: p.prompt === true && !!approveUrl,
      approveUrl,
      paypalOrderId: str(p.paypalOrderId),
    };
  });
  const organizer = isRec(sc.organizer) ? sc.organizer : {};
  return {
    tripId: str(sc.trip_id),
    stub: sc.reality === "local_stub",
    realSandbox: sc.reality === "paypal_sandbox",
    rows,
    organizer: { name: str(organizer.name), due: str(organizer.display_due) },
    allPaid: rows.length > 0 && rows.every((r) => r.paid),
    notice: str(sc.disclaimer),
    payeeNotice: str(sc.payee_notice),
    actions: cardActions(sc),
  };
}

// ---- case follow-up (update_case_status) ----------------------------------------------------

export interface CasePreviewView {
  current: string;
  proposed: string;
  note: string;
  evidence: string;
  actions: CardAction[];
}

export interface CaseRecordView {
  state: string;
  note: string;
  evidence: string;
}

// ---- dispatch -------------------------------------------------------------------------------

export type CardView =
  | { kind: "error"; code: string; message: string; actions: CardAction[] }
  | StatusView
  | ({ kind: "trip" } & TripView)
  | ({ kind: "reconcile" } & ReconcileView)
  | ({ kind: "impact" } & ImpactView)
  | ({ kind: "options" } & OptionsView)
  | ({ kind: "quote" } & QuoteView)
  | ({ kind: "payment" } & PaymentView)
  | ({ kind: "paypal_checkout" } & PayPalCheckoutView)
  | ({ kind: "delivery" } & DeliveryView)
  | ({ kind: "split_quote" } & SplitQuoteView)
  | ({ kind: "split" } & SplitView)
  | ({ kind: "case_preview" } & CasePreviewView)
  | ({ kind: "case_record" } & CaseRecordView)
  | { kind: "unknown" };

/** Picks the card from the shape of structuredContent, so one page serves every tool that links it */
export function cardFor(structured: unknown): CardView {
  if (!isRec(structured)) return { kind: "unknown" };
  const sc = structured;
  if (isRec(sc.error)) return { kind: "error", code: str(sc.error.code), message: str(sc.error.message), actions: cardActions(sc) };
  if (sc.view === "paypal_checkout" && sc.reality === "paypal_sandbox" && sc.state === "awaiting-payment" && typeof sc.paypalOrderId === "string" && sc.paypalOrderId && typeof sc.approveUrl === "string" && "chargeId" in sc) {
    return { kind: "paypal_checkout", ...paymentView(sc), paypalOrderId: sc.paypalOrderId, displayAmount: str(sc.display_amount) };
  }
  if (typeof sc.approveUrl === "string" && "chargeId" in sc) return { kind: "payment", ...paymentView(sc) };
  // A repeat order call on an order with nothing left to pay reads like an unpaid check, without a link.
  if ("chargeId" in sc) return { kind: "delivery", ...deliveryView({ ...sc, paid: false, output: null }) };
  if (sc.codeKind === "approval") return { kind: "quote", ...quoteView(sc) };
  if (Array.isArray(sc.impacts)) return { kind: "impact", ...impactView(sc) };
  if (Array.isArray(sc.options)) return { kind: "options", ...optionsView(sc) };
  if (Array.isArray(sc.shares)) return { kind: "split_quote", ...splitQuoteView(sc) };
  if (Array.isArray(sc.payments) && isRec(sc.organizer)) return { kind: "split", ...splitView(sc) };
  if (typeof sc.paid === "boolean" && "output" in sc) return { kind: "delivery", ...deliveryView(sc) };
  if (sc.reconciled === true) return { kind: "reconcile", total: str(sc.display_total), bookings: num(sc.booking_count) ?? 0 };
  if (sc.preview === true && typeof sc.proposedState === "string") {
    return { kind: "case_preview", current: caseLabel(str(sc.currentState)), proposed: caseLabel(sc.proposedState), note: str(sc.note), evidence: str(sc.evidence), actions: cardActions(sc) };
  }
  if (sc.provenance === "user-reported" && typeof sc.trackingState === "string") {
    return { kind: "case_record", state: caseLabel(sc.trackingState), note: str(sc.report), evidence: str(sc.evidence) };
  }
  if (Array.isArray(sc.bookings) && "total_minor" in sc) return { kind: "trip", ...tripView(sc) };
  if (Array.isArray(sc.trips) && Array.isArray(sc.runs)) return statusView(sc);
  return { kind: "unknown" };
}

// ---- payment controls -----------------------------------------------------------------------

/** One order the card can pay. The order ID is the server's; a null ID means a link is the only way. */
export interface CheckoutTarget {
  key: string;
  approveUrl: string;
  paypalOrderId: string | null;
  /** The only thing that follows an approval or a return: a server check of this same order */
  check: CardAction;
}

export function checkoutKey(view: PaymentView): string {
  return `service:${view.tripId}:${view.runId}:${view.chargeId}`;
}

export const shareKey = (row: ShareView): string => `share:${row.paymentId}`;

export function checkoutTargets(view: CardView): CheckoutTarget[] {
  switch (view.kind) {
    case "paypal_checkout":
      return [{ key: checkoutKey(view), approveUrl: view.approveUrl, paypalOrderId: view.paypalOrderId, check: checkFee(view.tripId, view.runId) }];
    case "payment":
      return view.approveUrl ? [{ key: checkoutKey(view), approveUrl: view.approveUrl, paypalOrderId: null, check: checkFee(view.tripId, view.runId) }] : [];
    case "split":
      return view.rows
        .filter((r) => r.payable)
        .map((r) => ({ key: shareKey(r), approveUrl: r.approveUrl, paypalOrderId: view.realSandbox && r.paypalOrderId ? r.paypalOrderId : null, check: checkShares(view.tripId) }));
    default:
      return [];
  }
}

export { checkFee, checkShares };
