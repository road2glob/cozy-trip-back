import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServerFactory } from "../src/mcp/server";
import { CARD_URI, PAYPAL_CARD_CSP } from "../src/mcp/ui";
import { CARD_HTML } from "../src/ui/cardHtml.generated";
import { testEnv } from "./helpers/env";
import { toolCtx } from "./helpers/env";
import { stubFetch } from "../stub";
import * as imports from "../src/tools/importOrders";
import * as detect from "../src/tools/detectImpact";
import * as quote from "../src/tools/quoteService";
import * as pay from "../src/tools/createServicePayment";
import { cardFor } from "../ui/views";

vi.mock("agents/mcp/server", () => ({ getMcpAuthContext: () => ({ props: { userId: "usr_test", tokenId: "test-id", requestId: "test-request" } }) }));

describe("MCP resource protocol and PayPal boundary", () => {
  it("the service tool forwards the provider order ID and formats its price without changing text", async () => {
    const { env } = testEnv();
    env.TASKPASS_TRANSPORT = "binding";
    env.TASKPASS = { fetch: async (req: Request) => {
      const response = await stubFetch(req, env);
      if (/\/charge$/.test(new URL(req.url).pathname) && req.method === "POST") {
        return Response.json({ ...await response.json(), paypalOrderId: "SERVER-ORDER", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TEST" }, { status: response.status });
      }
      return response;
    } } as Fetcher;
    const ctx = toolCtx(env);
    const trip_id = (await imports.run(ctx, { mode: "sample" })).structuredContent.trip_id as string;
    const preview = (await detect.run(ctx, { trip_id })).structuredContent;
    await detect.run(ctx, { trip_id, confirmation_code: preview.confirmation_code as string });
    const q = (await quote.run(ctx, { trip_id })).structuredContent;
    const payment = await pay.run(ctx, { trip_id, run_id: q.runId as string, confirmation_code: q.confirmation_code as string });
    expect(payment.isError).not.toBe(true);
    expect(payment.structuredContent).toMatchObject({ view: "paypal_checkout", paypalOrderId: "SERVER-ORDER", display_amount: "USD 9.90" });
    expect(cardFor(payment.structuredContent)).toMatchObject({ kind: "paypal_checkout", paypalOrderId: "SERVER-ORDER", displayAmount: "USD 9.90" });
    expect(payment.content[0].text).toContain("Payment is not successful until a receipt shows chargeOutcome captured and verificationState passed.");
  });
  it("preserves existing linked tools/URI and returns escaped public configuration with Sandbox-only CSP", async () => {
    const { env } = testEnv({ PAYPAL_CLIENT_ID_PUBLIC: 'public-test-"<&' });
    const server = createServerFactory(env)();
    const client = new Client({ name: "offline-app-check", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      expect(client.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/ui"]).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
      const { tools } = await client.listTools();
      const linked = tools.filter(t => t._meta?.ui).map(t => t.name).sort();
      expect(linked).toEqual(["create_service_payment", "detect_impact", "get_status", "import_orders", "plan_options", "quote_service", "verify_payment"]);
      for (const t of tools.filter(t => linked.includes(t.name))) {
        expect(t._meta?.ui).toEqual({ resourceUri: CARD_URI });
        expect(t._meta?.["ui/resourceUri"]).toBe(CARD_URI);
      }
      const resource = (await client.readResource({ uri: CARD_URI })).contents[0];
      expect(resource.mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.text).toMatch(/^<!doctype html>/i);
      expect(resource.text).toContain('content="public-test-&quot;&lt;&amp;"');
      expect(resource._meta?.ui).toEqual({ prefersBorder: true, csp: PAYPAL_CARD_CSP });
      expect(resource.text).not.toContain("__COZYTRIP_PAYPAL_CLIENT_ID_PUBLIC__");
      expect(JSON.stringify(resource._meta)).not.toMatch(/www\.paypal\.com|venmo/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps generated HTML credential-free and external SDK use confined to the Sandbox core URL", () => {
    expect(CARD_HTML).toContain("__COZYTRIP_PAYPAL_CLIENT_ID_PUBLIC__");
    expect(CARD_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(CARD_HTML).not.toContain("test-pepper");
    expect(CARD_HTML).not.toContain("test-product-token");
    const source = readFileSync(new URL("../ui/paypal.ts", import.meta.url), "utf8");
    expect(source.match(/https:\/\/[^"'\s]+/g)).toEqual(["https://www.sandbox.paypal.com/web-sdk/v6/core"]);
    expect(source).not.toMatch(/actions\.order\.capture|\/capture\b|fetch\s*\(/);
    expect(source).not.toMatch(/\/\s*100|\*\s*60/);
  });
});
