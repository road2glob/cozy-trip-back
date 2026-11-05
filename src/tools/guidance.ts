// What the agent and the card read to stay on the same state. Every tool result says the current fact,
// the allowed next steps and, when nothing remains, that the flow has ended. Additive: existing fields
// stay as they are. The steps go into the text too, because some hosts only pass text to the model.
import { formatUsd } from "../domain/money";
import type { ReminderSummary } from "../domain/reminders";
import type { TripDetail } from "../domain/trips";
import { ok, type ToolResult } from "./common";

export interface NextStep {
  /** The person's intent that makes this step relevant */
  when: string;
  tool: string;
  /** Reuse as they are, including any code the result returned */
  args: Record<string, unknown>;
  /** true: only after the person clearly agrees. A press on the card's button counts. */
  needs_confirmation: boolean;
  /** Button text if the card may offer this step. Steps without it stay in the conversation. */
  card_action?: string;
  /**
   * Only the host can reach the person's calendar, so this button sends the person's words to the chat
   * instead of calling a tool.
   */
  card_message?: string;
}

export interface Guidance {
  fact: string;
  next_steps: NextStep[];
  /** Set when there is nothing further to do, so the agent does not invent a step */
  end: string | null;
}

function guidanceLines(g: Guidance): string[] {
  return [
    `Now: ${g.fact}`,
    ...g.next_steps.map(
      (s) => `Next, when ${s.when}: call ${s.tool} with ${JSON.stringify(s.args)}${s.needs_confirmation ? " once the person clearly agrees" : ""}.`,
    ),
    ...(g.end ? [`End: ${g.end}`] : []),
  ];
}

export function guided(text: string, structured: Record<string, unknown>, guidance: Guidance): ToolResult {
  return ok([...(text ? [text] : []), ...guidanceLines(guidance)].join("\n"), { ...structured, guidance });
}

/** A failed step with a stated way forward */
export function withGuidance(result: ToolResult, guidance: Guidance): ToolResult {
  return {
    ...result,
    content: [...result.content, { type: "text", text: guidanceLines(guidance).join("\n") }],
    structuredContent: { ...result.structuredContent, guidance },
  };
}

/**
 * Errors with no guidance of their own: the safe way forward is to read the existing records, which
 * state the real position. Without a trip_id, because the one passed in may be the thing that was wrong.
 */
export function ensureGuidance(result: ToolResult): ToolResult {
  if (!result.isError || result.structuredContent.guidance) return result;
  const message = (result.structuredContent.error as { message?: string } | undefined)?.message;
  return withGuidance(result, {
    fact: message ?? "That step did not complete.",
    next_steps: [{ when: "before retrying or describing the outcome", tool: "get_status", args: {}, needs_confirmation: false, card_action: "Check where things stand" }],
    end: null,
  });
}

export const NO_VERIFIED_CAPTURE = "No verified capture yet.";

export const nextStep = {
  seeReminders: (tripId: string, card_action?: string): NextStep => ({
    when: "the person wants to see the trip's key dates and reminders. Offer this first once a trip is organized",
    tool: "plan_reminders",
    args: { trip_id: tripId },
    needs_confirmation: false,
    ...(card_action ? { card_action } : {}),
  }),
  adjustReminders: (tripId: string): NextStep => ({
    when: "the person wants other times, fewer reminders or a certain calendar: add notify_time, leave_home_at, follow_up_at, exclude or calendar_name",
    tool: "plan_reminders",
    args: { trip_id: tripId },
    needs_confirmation: false,
  }),
  removeStaleReminder: (tripId: string): NextStep => ({
    when: "a CozyTrip Demo reminder in the person's calendar no longer applies and should be removed",
    tool: "plan_reminders",
    args: { trip_id: tripId },
    needs_confirmation: false,
  }),
  importSample: (): NextStep => ({
    when: "the person chooses to try the fictional sample",
    tool: "import_orders",
    args: { mode: "sample" },
    needs_confirmation: true,
    card_action: "Import sample trip",
  }),
  resume: (tripId: string): NextStep => ({
    when: "before describing or continuing this trip",
    tool: "get_status",
    args: { trip_id: tripId },
    needs_confirmation: false,
    card_action: "See where this trip stands",
  }),
  checkOrders: (tripId: string): NextStep => ({
    when: "the person wants the orders checked",
    tool: "reconcile_trip",
    args: { trip_id: tripId },
    needs_confirmation: false,
  }),
  previewIssue: (tripId: string, card_action?: string): NextStep => ({
    when: "the person asks about a flight problem or wants to see what it would affect",
    tool: "detect_impact",
    args: { trip_id: tripId },
    needs_confirmation: false,
    ...(card_action ? { card_action } : {}),
  }),
  confirmIssue: (tripId: string, code: string): NextStep => ({
    when: "the person agrees to record this simulated cancellation",
    tool: "detect_impact",
    args: { trip_id: tripId, confirmation_code: code },
    needs_confirmation: true,
    card_action: "Confirm simulation",
  }),
  options: (tripId: string): NextStep => ({
    when: "the person wants to know what can be done",
    tool: "plan_options",
    args: { trip_id: tripId },
    needs_confirmation: false,
    card_action: "See recovery options",
  }),
  quoteDrafts: (tripId: string, card_action?: string): NextStep => ({
    when: "the person asks for CozyTrip's prepared drafts",
    tool: "quote_service",
    args: { trip_id: tripId },
    needs_confirmation: false,
    ...(card_action ? { card_action } : {}),
  }),
  reviewQuote: (tripId: string): NextStep => ({
    when: "the person wants to continue the quoted drafts",
    tool: "quote_service",
    args: { trip_id: tripId },
    needs_confirmation: false,
    card_action: "Review the quote",
  }),
  confirmFee: (tripId: string, runId: string, code: string, price: string): NextStep => ({
    when: `the person confirms ${price} for the drafts`,
    tool: "create_service_payment",
    args: { trip_id: tripId, run_id: runId, confirmation_code: code },
    needs_confirmation: true,
    card_action: `Confirm ${price}`,
  }),
  /** The fee was confirmed before: this reopens the same order, so no second confirmation or order */
  continuePayment: (tripId: string, runId: string, code: string, card_action: string): NextStep => ({
    when: "the person wants to go back to PayPal for this same order",
    tool: "create_service_payment",
    args: { trip_id: tripId, run_id: runId, confirmation_code: code },
    needs_confirmation: false,
    card_action,
  }),
  returnToQuote: (tripId: string): NextStep => ({
    when: "the person wants to go back to PayPal for this same order",
    tool: "quote_service",
    args: { trip_id: tripId },
    needs_confirmation: false,
    card_action: "Back to PayPal",
  }),
  checkFee: (tripId: string, runId: string, card_action?: string): NextStep => ({
    when: "the person says they paid, came back or asks to check",
    tool: "verify_payment",
    args: { trip_id: tripId, run_id: runId },
    needs_confirmation: false,
    ...(card_action ? { card_action } : {}),
  }),
  viewDrafts: (tripId: string, runId: string): NextStep => ({
    when: "the person wants to read the drafts again",
    tool: "verify_payment",
    args: { trip_id: tripId, run_id: runId },
    needs_confirmation: false,
    card_action: "View drafts",
  }),
  quoteSplit: (tripId: string, card_action?: string): NextStep => ({
    when: "the person wants to split the airport pickup",
    tool: "quote_split",
    args: { trip_id: tripId },
    needs_confirmation: false,
    ...(card_action ? { card_action } : {}),
  }),
  confirmSplit: (tripId: string, code: string): NextStep => ({
    when: "the person confirms the split",
    tool: "create_split_payments",
    args: { trip_id: tripId, confirmation_code: code },
    needs_confirmation: true,
    card_action: "Confirm split",
  }),
  checkShares: (tripId: string, card_action?: string): NextStep => ({
    when: "the person says a share was paid, came back or asks who has not paid",
    tool: "split_status",
    args: { trip_id: tripId },
    needs_confirmation: false,
    ...(card_action ? { card_action } : {}),
  }),
};

// ---- case follow-up -------------------------------------------------------------------------

export type CaseStatus = "submitted_by_user" | "awaiting_merchant" | "merchant_responded";

const CASE_NEXT: Record<string, CaseStatus | undefined> = {
  prepared: "submitted_by_user",
  submitted_by_user: "awaiting_merchant",
  awaiting_merchant: "merchant_responded",
};

const CASE_REPORT: Record<CaseStatus, string> = {
  submitted_by_user: "the person reports they sent the drafts themselves",
  awaiting_merchant: "the person reports they are now waiting for the merchant",
  merchant_responded: "the person reports what the merchant replied, passed as note",
};

/** Chat only: a card never offers to mark something as sent */
export function reportCaseStep(tripId: string, runId: string, state: string): NextStep | null {
  const status = CASE_NEXT[state];
  if (!status) return null;
  return { when: CASE_REPORT[status], tool: "update_case_status", args: { trip_id: tripId, run_id: runId, status }, needs_confirmation: true };
}

// ---- where a trip stands --------------------------------------------------------------------

export interface ShareFact {
  name?: string;
  state: string;
  display_amount: string;
  prompt: boolean;
}

const SHARE_STATE: Record<string, string> = {
  captured: "paid",
  "awaiting-payment": "not paid",
  failed: "payment failed",
  void: "cancelled",
  creating: "not ready",
};

export function sharesFact(shares: ShareFact[]): string {
  return shares.map((s) => `${s.name ?? "Member"}'s share ${s.display_amount}: ${SHARE_STATE[s.state] ?? s.state}.`).join(" ");
}

export function sharesGuidance(tripId: string, shares: ShareFact[], staleReminder = false): Guidance {
  if (shares.length === 0) {
    return { fact: "No share payments exist yet.", next_steps: [nextStep.quoteSplit(tripId, "Review the split")], end: null };
  }
  const fact = `${sharesFact(shares)} Maya owes USD 0.00.`;
  if (shares.some((s) => s.prompt)) return { fact, next_steps: [nextStep.checkShares(tripId)], end: null };
  const done = "No share is waiting for payment, so no payment entry remains.";
  return staleReminder ? { fact: `${fact} ${done}`, next_steps: [nextStep.removeStaleReminder(tripId)], end: null } : { fact, next_steps: [], end: done };
}

export interface RunFact {
  runId: string;
  state: string;
  chargeOutcome?: string;
}

interface TripFacts {
  detail: TripDetail;
  run: RunFact | null;
  /** case_progress state; set only after a paid, verified delivery */
  trackingState: string | null;
  shares: ShareFact[];
  /** null until the reminder migration has been applied, and then the plan is not offered */
  reminders: ReminderSummary | null;
}

function runPosition(tripId: string, run: RunFact, trackingState: string | null): { fact: string; steps: NextStep[] } {
  switch (run.state) {
    case "awaiting-approval":
      return { fact: "After-sales drafts are quoted, not confirmed and not paid.", steps: [nextStep.reviewQuote(tripId)] };
    case "awaiting-payment":
      return {
        fact: `The after-sales order exists and is unpaid. ${NO_VERIFIED_CAPTURE}`,
        steps: [nextStep.checkFee(tripId, run.runId, "Check again"), nextStep.returnToQuote(tripId)],
      };
    case "running":
    case "verifying":
      return {
        fact: "CozyTrip is still checking the original after-sales order. No new payment is needed.",
        steps: [nextStep.checkFee(tripId, run.runId, "Check again")],
      };
    case "verified":
      if (run.chargeOutcome === "captured") {
        const report = trackingState ? reportCaseStep(tripId, run.runId, trackingState) : null;
        return {
          fact: "Payment verified. Three drafts are ready. Draft. Not sent.",
          steps: [nextStep.viewDrafts(tripId, run.runId), ...(report ? [report] : [])],
        };
      }
      break;
  }
  if (run.chargeOutcome === "refund-required") {
    return { fact: "This after-sales order did not pass verification. Refund-required is not a completed refund. No drafts are available.", steps: [] };
  }
  return { fact: "The after-sales run is closed. No order is in progress.", steps: [nextStep.quoteDrafts(tripId)] };
}

/** Reads like the trip itself: what is true now and only the steps that make sense from here */
export function tripGuidance({ detail: d, run, trackingState, shares, reminders }: TripFacts): Guidance {
  const tripId = d.trip.trip_id;
  const facts = [`${d.trip.title}: ${d.bookings.length} bookings, ${d.participants.length} travelers, ${formatUsd(d.totalMinor)}. Simulated travel data.`];
  const steps: NextStep[] = [];

  const issueConfirmed = d.demoEvent?.state === "fired";
  if (run) {
    const position = runPosition(tripId, run, trackingState);
    facts.push(position.fact);
    steps.push(...position.steps);
  } else if (issueConfirmed) {
    facts.push("A simulated cancellation is recorded. No airline was contacted.");
    steps.push(nextStep.options(tripId), nextStep.quoteDrafts(tripId));
  }

  if (shares.length > 0) {
    facts.push(sharesFact(shares));
    if (shares.some((s) => s.prompt)) steps.push(nextStep.checkShares(tripId, "Check shares"));
  }
  if (reminders) {
    if (reminders.written) facts.push(`${reminders.written} Demo reminders are in the calendar, as its tool reported.`);
    if (reminders.failed) facts.push(`${reminders.failed} reminders failed and are not set.`);
    steps.push(nextStep.seeReminders(tripId, "See reminder plan"));
  }
  if (shares.length === 0) steps.push(nextStep.quoteSplit(tripId));
  if (!run && !issueConfirmed) steps.push(nextStep.previewIssue(tripId, reminders ? undefined : "Preview a simulated issue"), nextStep.checkOrders(tripId));

  return { fact: facts.join(" "), next_steps: steps, end: steps.length ? null : "Nothing is waiting on this trip." };
}
