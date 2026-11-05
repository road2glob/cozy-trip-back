// Issues a demo token in the LOCAL D1 only. Remote databases are never touched.
// token = Base64url of 32 random bytes, printed once and never written to disk.
// token_hash = hex(hmac_sha256(DEMO_TOKEN_PEPPER, token)), with DEMO_TOKEN_PEPPER read from .dev.vars.
// Usage: npm run token:issue -- [--user usr_local_dev] [--label local]
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const EXPIRES_AT = "2026-11-14T00:00:00Z";
const SCOPES = "mcp:tools";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const userId = arg("user", "usr_local_dev");
const label = arg("label", "local");
if (!/^usr_[A-Za-z0-9_-]{1,40}$/.test(userId)) throw new Error("--user must look like usr_<letters/digits/_/->");
if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(label)) throw new Error("--label: 1-40 letters, digits, space, _ . -");

let pepper;
try {
  pepper = /^DEMO_TOKEN_PEPPER=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
} catch {
  // handled below
}
if (!pepper || pepper === "replace-me") throw new Error("Set DEMO_TOKEN_PEPPER in .dev.vars first (npm run dev:init).");

const token = randomBytes(32).toString("base64url");
const tokenHash = createHmac("sha256", pepper).update(token).digest("hex");
const tokenId = "tok_" + randomBytes(9).toString("base64url");
const now = new Date().toISOString();

const sql =
  "INSERT INTO demo_tokens (token_id, token_hash, user_id, label, scopes, expires_at, created_at) " +
  `VALUES ('${tokenId}', '${tokenHash}', '${userId}', '${label}', '${SCOPES}', '${EXPIRES_AT}', '${now}');`;

// Run wrangler's own entry with this node binary, without a shell, so the SQL argument
// reaches wrangler intact (a Windows shell would split it on spaces).
const require = createRequire(import.meta.url);
const wranglerPkgPath = require.resolve("wrangler/package.json");
const wranglerBin = join(dirname(wranglerPkgPath), require(wranglerPkgPath).bin.wrangler);
execFileSync(process.execPath, [wranglerBin, "d1", "execute", "cozytrip", "--local", "--command", sql], {
  stdio: ["ignore", "ignore", "inherit"],
});

console.log(`token_id:   ${tokenId}`);
console.log(`user_id:    ${userId}`);
console.log(`expires_at: ${EXPIRES_AT}`);
console.log(`token:      ${token}`);
console.log("(The token is shown once. D1 stores only its HMAC.)");
