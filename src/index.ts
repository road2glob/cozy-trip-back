import { fail } from "./tools/common";
import { ensureGuidance } from "./tools/guidance";
import { Hono } from "hono";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { authenticate, unauthorized } from "./mcp/auth";
import { createServerFactory } from "./mcp/server";
import { reminderTablesExist } from "./domain/reminders";
import { payRoutes } from "./routes/pay";
import { stubCheckoutPage } from "../stub/checkout";

const app = new Hono<{ Bindings: Env }>();

// Read-only health check: confirms the D1 binding answers; writes nothing
app.get("/health", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  ).first<{ tables: number }>();
  return c.json({ ok: true, tables: row?.tables ?? 0 });
});

app.route("/pay", payRoutes);

// Stands in for PayPal's approval page when TASKPASS_TRANSPORT=stub; does not exist otherwise
app.get("/__stub/checkout/:chargeId", (c) =>
  c.env.TASKPASS_TRANSPORT === "stub" ? stubCheckoutPage(c.env, c.req.param("chargeId")) : c.notFound(),
);

app.get("/", (c) => c.text("CozyTrip MCP server. MCP endpoint: /mcp"));

function isLocalOrWorkersDev(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".workers.dev");
}

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    // CORS preflight carries no Authorization header; the handler answers it
    return createMcpHandler(createServerFactory(env))(request, env, ctx);
  }
  const props = await authenticate(request, env);
  if (!props) return unauthorized();

  const delivered=await env.DB.prepare('SELECT run_id FROM case_progress WHERE user_id=?1 LIMIT 1').bind(props.userId).first();
  const caseAvailable=!!delivered;
  if(!caseAvailable&&request.method==='POST'){
    const message=await request.clone().json().catch(()=>null) as {id?:string|number;method?:string;params?:{name?:string}}|null;
    if(message?.method==='tools/call'&&message.params?.name==='update_case_status')return Response.json({jsonrpc:'2.0',id:message.id,result:ensureGuidance(fail('delivery_required','Case tracking becomes available after paid verified drafts are delivered.'))},{headers:{'Access-Control-Allow-Origin':'*'}});
  }
  const requestHost = new URL(request.url).hostname;
  // Deploys and remote migrations are separate steps: reminder tools appear only once their tables exist.
  const remindersAvailable = await reminderTablesExist(env.DB);
  const handler = createMcpHandler(createServerFactory(env,caseAvailable,remindersAvailable), {
    authContext: { props },
    // localhost and workers.dev use the handler's defaults; a custom domain accepts only the public hostname
    ...(isLocalOrWorkersDev(requestHost) ? {} : { allowedHostnames: [new URL(env.PUBLIC_RETURN_ORIGIN).hostname] }),
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
