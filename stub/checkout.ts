// The page an approveUrl from the stub points to. It stands in for PayPal's approval page locally.
import type { Env } from "../src/env";
import { escapeHtml, htmlPage } from "../src/html";
import { stubReturnToken } from "./index";
import * as store from "./store";

export async function stubCheckoutPage(env: Env, chargeId: string): Promise<Response> {
  await store.ensureSchema(env.DB);
  const charge = await store.chargeById(env.DB, chargeId);
  if (!charge) return htmlPage("<p>Local contract stub. Unknown order.</p>", 404);

  const origin = env.PUBLIC_RETURN_ORIGIN.replace(/\/+$/, "");
  const query = new URLSearchParams({ charge_id: charge.charge_id, return_token: await stubReturnToken(env, charge.charge_id) });
  const returnUrl = `${origin}/pay/return?${query}`;
  const cancelUrl = `${origin}/pay/cancel?${query}`;

  return htmlPage(
    `<p><strong>Local contract stub. No PayPal order was created.</strong></p>` +
      `<p>This page stands in for the PayPal Sandbox approval page. Nothing is charged here.</p>` +
      `<p>Order <code>${escapeHtml(charge.charge_id)}</code>, USD 9.90 service fee (stub).</p>` +
      `<p><a href="${escapeHtml(returnUrl)}">Simulate returning from PayPal</a></p>` +
      `<p><a href="${escapeHtml(cancelUrl)}">Simulate cancelling on PayPal</a></p>`,
  );
}
