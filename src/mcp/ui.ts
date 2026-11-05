// MCP Apps (ui://) card. One HTML page serves the four phase 1 tools; it picks its view from each
// tool's structuredContent. Hosts without MCP Apps ignore all of this and show the tool text.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CARD_HTML } from "../ui/cardHtml.generated";
import type { Env } from "../env";
import { escapeHtml } from "../html";

export const CARD_URI = "ui://cozytrip/card.html";

/** Tool _meta that links a tool result to the card */
export const CARD_TOOL_META = { ui: { resourceUri: CARD_URI } } as const;

export const PAYPAL_CARD_CSP = {
  resourceDomains: ["https://www.sandbox.paypal.com", "https://www.paypalobjects.com", "https://*.paypalobjects.com"],
  connectDomains: ["https://www.sandbox.paypal.com", "https://api-m.sandbox.paypal.com", "https://www.paypalobjects.com"],
  frameDomains: ["https://www.sandbox.paypal.com", "https://www.paypalobjects.com"],
};

export function registerCardResource(server: McpServer, env: Pick<Env, "PAYPAL_CLIENT_ID_PUBLIC"> = {}): void {
  registerAppResource(
    server,
    "cozytrip-card",
    CARD_URI,
    { description: "CozyTrip card for trips, quotes, payments and status", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: CARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: CARD_HTML.replace("__COZYTRIP_PAYPAL_CLIENT_ID_PUBLIC__", () => escapeHtml(env.PAYPAL_CLIENT_ID_PUBLIC ?? "")),
          _meta: { ui: { prefersBorder: true, csp: PAYPAL_CARD_CSP } },
        },
      ],
    }),
  );
}
