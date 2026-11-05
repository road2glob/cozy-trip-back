import type { RunState } from "../paymentService/types";

/** Run states after which the payment service issues a receipt */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["verified", "failed", "rejected", "cancelled"]);

export function isTerminal(state: string | null | undefined): boolean {
  return !!state && TERMINAL_RUN_STATES.has(state as RunState);
}
