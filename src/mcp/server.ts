import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import type { Env } from "../env";
import type { AuthProps } from "./auth";
import { registerTools } from "../tools";

/** The user id comes only from this request's auth context, never from module-level state */
export function currentUserId(): string {
  const userId = (getMcpAuthContext()?.props as AuthProps | undefined)?.userId;
  if (!userId) throw new Error("No authenticated user in this request");
  return userId;
}

/** Called once per request; returns a fresh server each time */
export function createServerFactory(env: Env) {
  return () => {
    const server = new McpServer({ name: "cozytrip", version: "0.1.0" });
    registerTools(server, env);
    return server;
  };
}
