export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 只读健康检查：确认 D1 绑定能连通，不写任何数据
    if (url.pathname === "/health") {
      const row = await env.DB.prepare(
        "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      ).first<{ tables: number }>();
      return Response.json({ ok: true, tables: row?.tables ?? 0 });
    }

    return new Response("CozyTrip worker is running. Try /health", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
