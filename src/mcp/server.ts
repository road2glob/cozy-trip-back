import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { registerTools } from "../tools";
import { registerCardResource } from "./ui";

/** Called once per request; returns a fresh server each time */
export function createServerFactory(env: Env,caseAvailable=false) {
  return () => {
    const server = new McpServer({ name: "cozytrip", version: "0.1.0" }, {
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    });
    registerTools(server, env,caseAvailable);
    // Registered on every request: a stateless server cannot see which host is asking, and hosts
    // without MCP Apps support ignore it.
    registerCardResource(server, env);
    return server;
  };
}
