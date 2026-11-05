import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { registerTools } from "../tools";

/** Called once per request; returns a fresh server each time */
export function createServerFactory(env: Env,caseAvailable=false) {
  return () => {
    const server = new McpServer({ name: "cozytrip", version: "0.1.0" });
    registerTools(server, env,caseAvailable);
    return server;
  };
}
