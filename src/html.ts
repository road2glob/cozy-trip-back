export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const BASE_STYLE =
  "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;" +
  "justify-content:center;padding:24px 16px;box-sizing:border-box;background:#fff;color:#111}" +
  "main{max-width:34rem}p{font-size:1.2rem;line-height:1.55;margin:0 0 1rem}" +
  "a{color:#0b57d0}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#8ab4f8}}";

/** Minimal page: no scripts, no external resources, not cached, no referrer leaks */
export function htmlPage(bodyHtml: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>CozyTrip</title><style>${BASE_STYLE}</style></head><body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
