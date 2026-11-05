import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { authenticate, hashDemoToken } from "../src/mcp/auth";
import { testEnv } from "./helpers/env";

async function seedToken(raw: ReturnType<typeof testEnv>["raw"], env: ReturnType<typeof testEnv>["env"], token: string, over: Record<string, unknown> = {}) {
  const row = {
    token_id: "tok_abcdefghijkl",
    token_hash: await hashDemoToken(env.DEMO_TOKEN_PEPPER, token),
    user_id: "usr_local_dev",
    label: "local",
    scopes: "mcp:tools",
    expires_at: "2099-01-01T00:00:00Z",
    revoked_at: null,
    created_at: "2026-11-05T00:00:00Z",
    ...over,
  };
  raw
    .prepare("INSERT INTO demo_tokens (token_id, token_hash, user_id, label, scopes, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.token_id, row.token_hash, row.user_id, row.label, row.scopes, row.expires_at, row.revoked_at as null, row.created_at);
}

const req = (auth?: string) => new Request("http://localhost:8788/mcp", { method: "POST", headers: auth ? { Authorization: auth } : {} });

describe("demo token auth", () => {
  it("hashes as hex(hmac_sha256(pepper, token)), same as the issuing script", async () => {
    expect(await hashDemoToken("pepper", "token")).toBe(createHmac("sha256", "pepper").update("token").digest("hex"));
  });

  it("accepts a valid token and exposes only user_id / token_id", async () => {
    const { env, raw } = testEnv();
    await seedToken(raw, env, "good-token");
    const props = await authenticate(req("Bearer good-token"), env);
    expect(props).toMatchObject({ userId: "usr_local_dev", tokenId: "tok_abcdefghijkl" });
  });

  it("rejects a missing header, an unknown token, a revoked, an expired, or an out-of-scope token", async () => {
    const { env, raw } = testEnv();
    await seedToken(raw, env, "revoked", { token_id: "tok_revoked00000", revoked_at: "2026-11-05T01:00:00Z" });
    await seedToken(raw, env, "expired", { token_id: "tok_expired00000", expires_at: "2026-01-01T00:00:00Z" });
    await seedToken(raw, env, "noscope", { token_id: "tok_noscope00000", scopes: "other" });
    expect(await authenticate(req(), env)).toBeNull();
    expect(await authenticate(req("Bearer unknown"), env)).toBeNull();
    expect(await authenticate(req("Bearer revoked"), env)).toBeNull();
    expect(await authenticate(req("Bearer expired"), env)).toBeNull();
    expect(await authenticate(req("Bearer noscope"), env)).toBeNull();
  });

  it("fails closed without a pepper", async () => {
    const { env, raw } = testEnv();
    await seedToken(raw, env, "good-token");
    expect(await authenticate(req("Bearer good-token"), { ...env, DEMO_TOKEN_PEPPER: "" })).toBeNull();
  });
});
