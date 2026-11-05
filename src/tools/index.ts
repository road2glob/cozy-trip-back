import type { McpServer, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
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

function register<S extends StandardSchemaWithJSON>(server: McpServer, env: Env, tool: ToolModule<S>): void {
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
  server.registerTool<StandardSchemaWithJSON, S>(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    callback as unknown as ToolCallback<S>,
  );
}

// Phase 1 registers only these four tools. No resources, prompts or ui:// apps.
export function registerTools(server: McpServer, env: Env): void {
  register(server, env, getStatus);
  register(server, env, importOrders);
  register(server, env, quoteService);
  register(server, env, createServicePayment);
}
