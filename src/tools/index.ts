import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";

// get_status / import_orders / quote_service / create_service_payment follow section 5 of the handoff.
// Tools call only paymentService and domain.
export function registerTools(_server: McpServer, _env: Env): void {}
