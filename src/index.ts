import { Hono } from "hono";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { authenticate, unauthorized } from "./mcp/auth";
import { createServerFactory } from "./mcp/server";
import { payRoutes } from "./routes/pay";

const app = new Hono<{ Bindings: Env }>();

// Read-only health check: confirms the D1 binding answers; writes nothing
app.get("/health", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  ).first<{ tables: number }>();
  return c.json({ ok: true, tables: row?.tables ?? 0 });
});

app.route("/pay", payRoutes);

app.get("/", (c) => c.text("CozyTrip MCP server. MCP endpoint: /mcp"));

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    // CORS preflight carries no Authorization header; the handler answers it
    return createMcpHandler(createServerFactory(env))(request, env, ctx);
  }
  const props = await authenticate(request, env);
  if (!props) return unauthorized();

  const publicHost = new URL(env.PUBLIC_RETURN_ORIGIN).hostname;
  const requestHost = new URL(request.url).hostname;
  const isLocal = requestHost === "localhost" || requestHost === "127.0.0.1";

  const handler = createMcpHandler(createServerFactory(env), {
    authContext: { props },
    // Locally, rely on the handler's localhost defaults; deployed, accept only the public hostname
    ...(isLocal ? {} : { allowedHostnames: [publicHost] }),
  });
  return handler(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp") return handleMcp(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
