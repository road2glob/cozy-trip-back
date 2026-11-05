// Handoff section 5.3. The contract response has no pageState; CozyTrip picks one sentence by where the
// browser landed and what confirm-return said. One sentence per screen. The page never says Verified.
import type { ConfirmResult, SettlementOrder } from "../../paymentService/types";

export const SENTENCES = {
  returned: "Payment received by PayPal Sandbox. Return to your AI chat and say 'check my payment'.",
  cancelled: "No payment was captured. Return to your AI chat. Nothing was charged.",
  unconfirmed: "PayPal Sandbox has not confirmed a capture. Return to your AI chat and say 'check my payment'.",
} as const;

export type Scenario = keyof typeof SENTENCES;

export function isScenario(v: string | undefined | null): v is Scenario {
  return v === "returned" || v === "cancelled" || v === "unconfirmed";
}

/**
 * /pay/return: if confirm-return failed, or the order is still awaiting payment (or failed/void, i.e. no capture
 * happened), the person gets the "has not confirmed a capture" sentence. Otherwise they get the "received" sentence,
 * even when the charge is already captured: the page never upgrades to Verified.
 */
export function scenarioForReturn(result: ConfirmResult | SettlementOrder | null): Scenario {
  if (!result) return "unconfirmed";
  const state = "charge" in result ? result.charge?.state : result.state;
  if (!state || state === "awaiting-payment" || state === "failed" || state === "void") return "unconfirmed";
  return "returned";
}
