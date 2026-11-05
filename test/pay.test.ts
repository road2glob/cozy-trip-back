import {fixtureWrite} from '../stub/complete';
import {hmacHex} from '../stub/crypto';
import * as detectImpact from '../src/tools/detectImpact';
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import { payRoutes } from "../src/routes/pay";
import { SENTENCES, scenarioForReturn } from "../src/routes/pay/sentences";
import * as importOrders from "../src/tools/importOrders";
import * as quoteService from "../src/tools/quoteService";
import * as createServicePayment from "../src/tools/createServicePayment";
import { stubReturnToken } from "../stub";
import { testEnv, toolCtx } from "./helpers/env";

const app = new Hono<{ Bindings: Env }>().route("/pay", payRoutes);
const page = async (env: Env, path: string) => {
  const res = await app.fetch(new Request(`http://localhost:8788${path}`), env);
  return { status: res.status, html: await res.text(), headers: res.headers };
};
const sentencesIn = (html: string) => Object.entries(SENTENCES).filter(([, s]) => html.includes(s.replace(/'/g, "&#39;"))).map(([k]) => k);

describe("return pages", () => {
  it("shows exactly one sentence per screen, chosen by scenario in stub mode", async () => {
    const { env } = testEnv();
    const ret = await page(env, "/pay/return?scenario=returned");
    const unc = await page(env, "/pay/return?scenario=unconfirmed");
    const can = await page(env, "/pay/cancel?scenario=cancelled");
    expect(sentencesIn(ret.html)).toEqual(["returned"]);
    expect(sentencesIn(unc.html)).toEqual(["unconfirmed"]);
    expect(sentencesIn(can.html)).toEqual(["cancelled"]);
    for (const p of [ret, unc, can]) {
      expect(p.html).not.toMatch(/verified|refunded|<form|<input|<script|<a /i);
      expect(p.headers.get("Cache-Control")).toBe("no-store");
      expect(p.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  it("ignores scenario outside stub mode", async () => {
    const { env } = testEnv({ TASKPASS_TRANSPORT: "binding" });
    expect(sentencesIn((await page(env, "/pay/return?scenario=returned")).html)).toEqual(["unconfirmed"]);
    expect(sentencesIn((await page(env, "/pay/cancel?scenario=returned")).html)).toEqual(["cancelled"]);
  });

  it("a real stub return with the order still awaiting payment says capture is not confirmed", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const tripId = (((await importOrders.run(ctx, { mode: "sample" })).structuredContent) as any).trip_id;
    const preview=(await detectImpact.run(ctx,{trip_id:tripId})).structuredContent as any; await detectImpact.run(ctx,{trip_id:tripId,confirmation_code:preview.confirmation_code});
    const q = (await quoteService.run(ctx, { trip_id: tripId })).structuredContent as any;
    const p = (await createServicePayment.run(ctx, { trip_id: tripId, run_id: q.runId, confirmation_code: q.confirmation_code }))
      .structuredContent as any;
    const qs = new URLSearchParams({ charge_id: p.chargeId, return_token: await stubReturnToken(env, p.chargeId), token: "PAYPAL-ORDER-ID", PayerID: "X" });
    expect(sentencesIn((await page(env, `/pay/return?${qs}`)).html)).toEqual(["unconfirmed"]);
    expect(sentencesIn((await page(env, `/pay/cancel?${qs}`)).html)).toEqual(["cancelled"]);
    expect(sentencesIn((await page(env, `/pay/return?charge_id=${p.chargeId}&return_token=wrong`)).html)).toEqual(["unconfirmed"]);
  });

  it("maps confirm results to sentences without ever upgrading to verified", () => {
    const charge = (state: string) => ({ runId: "r", state: "awaiting-payment", charge: { state } }) as any;
    expect(scenarioForReturn(null)).toBe("unconfirmed");
    expect(scenarioForReturn(charge("awaiting-payment"))).toBe("unconfirmed");
    expect(scenarioForReturn(charge("failed"))).toBe("unconfirmed");
    expect(scenarioForReturn(charge("captured"))).toBe("returned");
    expect(scenarioForReturn({ state: "captured" } as any)).toBe("returned");
  });

  it("uses the exact copy from section 5.3", () => {
    expect(SENTENCES.returned).toBe("Payment received by PayPal Sandbox. Return to your AI chat and say 'check my payment'.");
    expect(SENTENCES.cancelled).toBe("No payment was captured. Return to your AI chat. Nothing was charged.");
    expect(SENTENCES.unconfirmed).toBe("PayPal Sandbox has not confirmed a capture. Return to your AI chat and say 'check my payment'.");
  });
});

it('payment_id return/cancel preserve the captured settlement result and never say nothing charged',async()=>{const {env}=testEnv();const id='pay_test';await fixtureWrite(env.DB,'settlement:'+id,{paymentId:id,amountMinor:6000,currency:'USD',mode:'sandbox',state:'captured',paypalOrderId:'STUB',paypalCaptureId:'STUB-CAP',paypalRequestId:id,approveUrl:null,disclaimer:'Sandbox demo'});const token=(await hmacHex(env.TASKPASS_PRODUCT_TOKEN,'settlement-return:'+id)).slice(0,32);for(const route of ['return','cancel']){const result=await page(env,`/pay/${route}?payment_id=${id}&return_token=${token}`);expect(sentencesIn(result.html)).toEqual(['returned'])}});
