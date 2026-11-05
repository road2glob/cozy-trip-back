// Creates .dev.vars from .dev.vars.example with fresh local random values for the two secrets.
// Never overwrites an existing .dev.vars. Usage: npm run dev:init
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".dev.vars")) {
  console.log(".dev.vars already exists; left unchanged.");
  process.exit(0);
}
const filled = readFileSync(".dev.vars.example", "utf8")
  .replace(/^DEMO_TOKEN_PEPPER=.*$/m, `DEMO_TOKEN_PEPPER=${randomBytes(32).toString("base64url")}`)
  .replace(/^TASKPASS_PRODUCT_TOKEN=.*$/m, `TASKPASS_PRODUCT_TOKEN=${randomBytes(32).toString("base64url")}`);
writeFileSync(".dev.vars", filled, { encoding: "utf8", flag: "wx" });
console.log("Wrote .dev.vars with new local random values (not printed).");
