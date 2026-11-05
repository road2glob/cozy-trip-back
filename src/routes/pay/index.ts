// /pay/return and /pay/cancel. One sentence per screen, no second action, no order list, no deep link,
// no card form, no MCP call. Landing here is not payment success.
import { Hono, type Context } from "hono";
import type { Env } from "../../env";
import { confirmCancel, confirmReturn, type ConfirmRequest } from "../../paymentService";
import { escapeHtml, htmlPage } from "../../html";
import { logEvent } from "../../log";
import { SENTENCES, isScenario, scenarioForReturn, type Scenario } from "./sentences";

export const payRoutes = new Hono<{ Bindings: Env }>();

const render = (scenario: Scenario) => htmlPage(`<p>${escapeHtml(SENTENCES[scenario])}</p>`);

/**
 * Only charge_id or payment_id plus return_token are forwarded, values unchanged. PayPal's own `token`
 * (an order id) and PayerID are never forwarded or logged. Exactly one id is required.
 */
function confirmBody(c: Context<{ Bindings: Env }>): ConfirmRequest | null {
  const chargeId = c.req.query("charge_id");
  const paymentId = c.req.query("payment_id");
  const returnToken = c.req.query("return_token");
  if (!returnToken || !!chargeId === !!paymentId) return null;
  return chargeId ? { charge_id: chargeId, return_token: returnToken } : { payment_id: paymentId!, return_token: returnToken };
}

/** Stub mode only: ?scenario=returned|cancelled|unconfirmed shows that sentence, to look at the pages locally */
function stubScenario(c: Context<{ Bindings: Env }>): Scenario | null {
  if (c.env.TASKPASS_TRANSPORT !== "stub") return null;
  const s = c.req.query("scenario");
  return isScenario(s) ? s : null;
}

payRoutes.get("/return", async (c) => {
  const forced = stubScenario(c);
  if (forced) return render(forced);

  const body = confirmBody(c);
  if (!body) return render("unconfirmed");
  try {
    const result = await confirmReturn(c.env, body);
    const scenario = scenarioForReturn(result);
    logEvent({ event: "pay_return", chargeId: "charge" in result ? result.charge.chargeId : undefined, runId: "runId" in result ? result.runId : undefined, outcome: scenario });
    return render(scenario);
  } catch (e) {
    logEvent({ event: "pay_return", outcome: "confirm_failed", http_status: (e as { status?: number }).status });
    return render("unconfirmed");
  }
});

payRoutes.get("/cancel", async (c) => {
  const forced = stubScenario(c);
  if (forced) return render(forced);

  const body = confirmBody(c);
  if (body) {
    try {
      const result = await confirmCancel(c.env, body);
      const state='charge' in result?result.charge.state:result.state;
      if(state==='captured'||state==='refund-required')return render('returned');
      logEvent({ event: "pay_cancel", chargeId: "charge" in result ? result.charge.chargeId : undefined, outcome: "confirmed" });
    } catch (e) {
      logEvent({ event: "pay_cancel", outcome: "confirm_failed", http_status: (e as { status?: number }).status });
    }
  }
  return render("cancelled");
});
