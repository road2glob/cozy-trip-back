// Issues a new demo token in the LOCAL D1: creates a new user and stores only the token's SHA-256 digest.
// The token is printed once and never written to disk. Remote databases are never touched.
// Usage: node scripts/issue-demo-token.mjs [label]
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Run wrangler's own entry with this node binary, without a shell, so the SQL argument
// reaches wrangler intact (a Windows shell would split it on spaces).
const require = createRequire(import.meta.url);
const wranglerPkgPath = require.resolve("wrangler/package.json");
const wranglerBin = join(dirname(wranglerPkgPath), require(wranglerPkgPath).bin.wrangler);

const label = (process.argv[2] ?? "local").replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 40);
const token = "ctd_" + randomBytes(24).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const userId = "usr_" + randomBytes(9).toString("base64url");
const now = new Date().toISOString();

const sql =
  `INSERT INTO users (user_id, created_at) VALUES ('${userId}', '${now}'); ` +
  `INSERT INTO demo_tokens (token_hash, user_id, label, created_at) VALUES ('${tokenHash}', '${userId}', '${label}', '${now}');`;

execFileSync(process.execPath, [wranglerBin, "d1", "execute", "cozytrip", "--local", "--command", sql], {
  stdio: ["ignore", "ignore", "inherit"],
});

console.log(`user_id: ${userId}`);
console.log(`token:   ${token}`);
console.log("(Shown once. D1 stores only the hash.)");
