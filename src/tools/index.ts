import * as splitStatus from './splitStatus';
import * as updateCaseStatus from "./updateCaseStatus";
import * as createSplitPayments from "./createSplitPayments";
import * as quoteSplit from "./quoteSplit";
import * as planOptions from "./planOptions";
import * as detectImpact from "./detectImpact";
import * as reconcileTrip from "./reconcileTrip";
import * as verifyPayment from "./verifyPayment";
import type { McpServer, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { CARD_TOOL_META } from "../mcp/ui";
import type { Env } from "../env";
import type { AuthProps } from "../mcp/auth";
import { logEvent } from "../log";
import { fail, type ToolContext, type ToolResult } from "./common";
import * as getStatus from "./getStatus";
import * as importOrders from "./importOrders";
import * as quoteService from "./quoteService";
import * as createServicePayment from "./createServicePayment";

interface ToolModule<S extends StandardSchemaWithJSON> {
  name: string;
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(ctx: ToolContext, args: StandardSchemaWithJSON.InferOutput<S>): Promise<ToolResult>;
}

/** Built from this request's auth context only; nothing about the user lives at module level */
function requestContext(env: Env): ToolContext | null {
  const props = getMcpAuthContext()?.props as AuthProps | undefined;
  if (!props?.userId) return null;
  return { env, userId: props.userId, tokenId: props.tokenId, requestId: props.requestId };
}

/** `card: true` links the tool's result to the MCP Apps card; only tools the card has a view for set it */
function register<S extends StandardSchemaWithJSON>(server: McpServer, env: Env, tool: ToolModule<S>, card = false): void {
  // The SDK's callback type is conditional on S, which TypeScript cannot resolve inside a generic function.
  const callback = async (args: StandardSchemaWithJSON.InferOutput<S>): Promise<ToolResult> => {
    const ctx = requestContext(env);
    if (!ctx) return fail("unauthenticated", "No signed-in user for this request.");
    const base = { event: "tool_call", tool: tool.name, request_id: ctx.requestId, token_id: ctx.tokenId, user_id: ctx.userId };
    try {
      const result = await tool.run(ctx, args);
      const sc = result.structuredContent;
      logEvent({
        ...base,
        trip_id: typeof sc.trip_id === "string" ? sc.trip_id : undefined,
        runId: typeof sc.runId === "string" ? sc.runId : undefined,
        chargeId: typeof sc.chargeId === "string" ? sc.chargeId : undefined,
        outcome: result.isError ? String((sc.error as { code?: string } | undefined)?.code ?? "error") : "ok",
      });
      return result;
    } catch (e) {
      logEvent({ ...base, outcome: "internal_error" });
      console.error(e instanceof Error ? e.message : "unknown error");
      return fail("internal_error", "Unexpected error. Nothing was charged.");
    }
  };
  const config = { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations };
  if (card) {
    // registerAppTool = registerTool plus the MCP Apps _meta that points hosts at the card.
    registerAppTool<StandardSchemaWithJSON, S>(server, tool.name, { ...config, _meta: CARD_TOOL_META }, callback as unknown as ToolCallback<S>);
  } else {
    server.registerTool<StandardSchemaWithJSON, S>(tool.name, config, callback as unknown as ToolCallback<S>);
  }
}

// No prompts. Tools marked `true` also show the MCP Apps card (one ui:// resource, src/mcp/ui.ts).
export function registerTools(server: McpServer, env: Env, caseAvailable=false): void {
  register(server, env, getStatus, true);
  register(server, env, importOrders, true);
  register(server, env, quoteService, true);
  register(server, env, createServicePayment, true);
  register(server, env, verifyPayment, true);
  register(server, env, reconcileTrip);
  register(server, env, detectImpact, true);
  register(server, env, planOptions, true);
  register(server, env, quoteSplit);
  register(server, env, createSplitPayments);
  register(server, env, splitStatus);
  if(caseAvailable) register(server, env, updateCaseStatus);

}
