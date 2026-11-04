import type { Env } from "../env";

export interface AuthProps extends Record<string, unknown> {
  userId: string;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Accepts only `Authorization: Bearer <demo token>`. D1 stores hashes only; unknown or revoked tokens return null. */
export async function authenticate(request: Request, env: Env): Promise<AuthProps | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare("SELECT user_id FROM demo_tokens WHERE token_hash = ?1 AND revoked_at IS NULL")
    .bind(tokenHash)
    .first<{ user_id: string }>();
  return row ? { userId: row.user_id } : null;
}

export function unauthorized(): Response {
  return Response.json(
    { error: { code: "unauthorized", message: "Missing or invalid bearer token" } },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="cozytrip"' } },
  );
}
