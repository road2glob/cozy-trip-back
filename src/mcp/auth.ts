import type { Env } from "../env";

export const REQUIRED_SCOPE = "mcp:tools";

export interface AuthProps extends Record<string, unknown> {
  userId: string;
  tokenId: string;
  requestId: string;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** hex(hmac_sha256(pepper, token)); the pepper's UTF-8 bytes are the key */
export async function hashDemoToken(pepper: string, token: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(token)));
}

/**
 * Accepts only `Authorization: Bearer <demo token>`. Missing header, unknown hash, revoked, expired or
 * missing scope all return null, and the request never reaches the MCP handler.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthProps | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match) return null;
  if (!env.DEMO_TOKEN_PEPPER) {
    console.error(JSON.stringify({ event: "auth_misconfigured", detail: "DEMO_TOKEN_PEPPER is not set" }));
    return null;
  }
  const tokenHash = await hashDemoToken(env.DEMO_TOKEN_PEPPER, match[1]);
  const row = await env.DB.prepare("SELECT token_id, user_id, scopes, expires_at, revoked_at FROM demo_tokens WHERE token_hash = ?1")
    .bind(tokenHash)
    .first<{ token_id: string; user_id: string; scopes: string; expires_at: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return null;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  if (!row.scopes.split(/\s+/).includes(REQUIRED_SCOPE)) return null;
  return { userId: row.user_id, tokenId: row.token_id, requestId: crypto.randomUUID() };
}

export function unauthorized(): Response {
  return Response.json(
    { error: { code: "unauthenticated", message: "Missing, invalid, expired or revoked bearer token" } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="cozytrip"',
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "WWW-Authenticate",
      },
    },
  );
}
