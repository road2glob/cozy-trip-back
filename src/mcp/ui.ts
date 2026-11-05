// MCP Apps (ui://) card. One HTML page serves the four phase 1 tools; it picks its view from each
// tool's structuredContent. Hosts without MCP Apps ignore all of this and show the tool text.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CARD_HTML } from "../ui/cardHtml.generated";

export const CARD_URI = "ui://cozytrip/card.html";

/** Tool _meta that links a tool result to the card */
export const CARD_TOOL_META = { ui: { resourceUri: CARD_URI } } as const;

export function registerCardResource(server: McpServer): void {
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
          text: CARD_HTML,
          // No csp entry: the card loads nothing from the network and needs no extra domains.
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );
}
