// Phase 1 smoke test against a running `npm run dev` (stub transport), over MCP Streamable HTTP.
// Usage: COZYTRIP_TOKEN=<demo token> node scripts/smoke-local.mjs [http://localhost:8788]
// The token is read from the environment and never printed.
const base = (process.argv[2] ?? "http://localhost:8788").replace(/\/+$/, "");
const token = process.env.COZYTRIP_TOKEN;
if (!token) throw new Error("Set COZYTRIP_TOKEN to a demo token issued with npm run token:issue");

let id = 0;
async function rpc(method, params, auth = `Bearer ${token}`) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.text();
  if (!res.ok) return { httpStatus: res.status, body };
  const data = body.trimStart().startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  return { httpStatus: res.status, ...JSON.parse(data) };
}
const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
const text = (r) => r.content.map((c) => c.text).join("\n");

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const init = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cozytrip-smoke", version: "0" } };
check("no header -> 401", (await rpc("initialize", init, null)).httpStatus === 401);
check("bad token -> 401", (await rpc("initialize", init, "Bearer not-a-real-token")).httpStatus === 401);
const hello = await rpc("initialize", init);
check("initialize with demo token", hello.httpStatus === 200 && hello.result?.serverInfo?.name === "cozytrip");

const tools = (await rpc("tools/list", {})).result.tools;
const names = tools.map((t) => t.name).sort();
// update_case_status appears only after a paid, verified delivery
const EXPECTED_TOOLS = [
  "create_service_payment", "create_split_payments", "detect_impact", "get_status", "import_orders", "plan_options",
  "quote_service", "quote_split", "reconcile_trip", "split_status", "verify_payment",
];
check("the eleven tools for a new user", JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(", "));

// MCP Apps card: the tools it has views for point at the one ui:// resource (self-contained HTML)
const CARD_URI = "ui://cozytrip/card.html";
const CARD_TOOLS = ["create_service_payment", "detect_impact", "get_status", "import_orders", "plan_options", "quote_service", "verify_payment"];
const linked = tools.filter((t) => t._meta?.ui?.resourceUri === CARD_URI).map((t) => t.name).sort();
check("card linked on exactly the tools it has views for", JSON.stringify(linked) === JSON.stringify(CARD_TOOLS), linked.join(", "));
const card = (await rpc("resources/read", { uri: CARD_URI })).result?.contents?.[0];
check(
  "card resource: MCP Apps MIME type, inline only",
  card?.mimeType === "text/html;profile=mcp-app" && card.text.includes('<main id="root"') && !/<script[^>]+src=|<link[^>]+href=/i.test(card.text),
  card ? `${Math.round(card.text.length / 1024)} KiB` : "missing",
);

const empty = await call("get_status");
check(
  "first get_status is empty",
  empty.structuredContent.trips.length === 0 &&
    empty.structuredContent.runs.length === 0 &&
    empty.structuredContent.run_count === 0 &&
    empty.structuredContent.split_payments.length === 0 &&
    !/seattle|paypal|usd|\$|split/i.test(text(empty)),
  text(empty),
);

const early = await call("quote_service", { trip_id: "trip_does_not_exist" });
check("quote before import: no code, no link", early.isError === true && !JSON.stringify(early).includes("confirmation_code\""));

const imp1 = await call("import_orders", { mode: "sample" });
const imp2 = await call("import_orders", { mode: "sample" });
const tripId = imp1.structuredContent.trip_id;
check("sample import: demo_event armed", imp1.structuredContent.demo_event === "armed", tripId);
check("second import returns the same trip_id", imp2.structuredContent.trip_id === tripId);
check("still no runs", (await call("get_status")).structuredContent.run_count === 0);

// A quote needs a confirmed impact: preview (nothing changes), then confirm with the local code.
const preview = await call("detect_impact", { trip_id: tripId });
check("impact preview: local code, nothing changed", preview.structuredContent.preview === true && preview.structuredContent.codeKind === "local");
const confirmed = await call("detect_impact", { trip_id: tripId, confirmation_code: preview.structuredContent.confirmation_code });
check("impact confirmed: zero-price run", confirmed.structuredContent.preview === false && !!confirmed.structuredContent.runId);

const quote = await call("quote_service", { trip_id: tripId });
const q = quote.structuredContent;
check("quote: 9.90 from price.amountMinor", q.price?.amountMinor === 990 && text(quote).includes("USD 9.90"));
check("quote: confirmation_code (codeKind approval), no approveUrl, output null", !!q.confirmation_code && q.codeKind === "approval" && !("approveUrl" in q) && q.output === null);

const noCode = await call("create_service_payment", { trip_id: tripId, run_id: q.runId });
check("pay without code: confirmation_required", noCode.structuredContent?.error?.code === "confirmation_required" && !JSON.stringify(noCode).includes("approveUrl"));

const paid = await call("create_service_payment", { trip_id: tripId, run_id: q.runId, confirmation_code: q.confirmation_code });
const p = paid.structuredContent;
check("pay with code: approveUrl from the stub", !!p.approveUrl && !p.approveUrl.includes("paypal.com") && text(paid).includes(p.approveUrl), p.approveUrl);
check("pay: awaiting-payment, local stub wording", p.state === "awaiting-payment" && text(paid).includes("Local contract stub. No PayPal order was created.") && !text(paid).includes("Real PayPal Sandbox transaction"));

const again = await call("create_service_payment", { trip_id: tripId, run_id: q.runId, confirmation_code: q.confirmation_code });
check("pay again: same approveUrl, same chargeId", again.structuredContent.approveUrl === p.approveUrl && again.structuredContent.chargeId === p.chargeId && again.structuredContent.replay === true);

const checkout = await (await fetch(p.approveUrl)).text();
check("approve link opens the local stub page", checkout.includes("Local contract stub. No PayPal order was created."));
const links = [...checkout.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const page = async (url) => (await (await fetch(url)).text()).replace(/&#39;/g, "'");
const S1 = "Payment received by PayPal Sandbox. Return to your AI chat and say 'check my payment'.";
const S2 = "No payment was captured. Return to your AI chat. Nothing was charged.";
const S3 = "PayPal Sandbox has not confirmed a capture. Return to your AI chat and say 'check my payment'.";
const only = (html, s) => [S1, S2, S3].filter((x) => html.includes(x)).length === 1 && html.includes(s) && !/verified/i.test(html);
check("return from the stub (still awaiting payment) -> sentence 3", only(await page(links.find((l) => l.includes("/pay/return"))), S3));
check("cancel from the stub -> sentence 2", only(await page(links.find((l) => l.includes("/pay/cancel"))), S2));
check("scenario=returned -> sentence 1", only(await page(`${base}/pay/return?scenario=returned`), S1));
check("scenario=cancelled -> sentence 2", only(await page(`${base}/pay/cancel?scenario=cancelled`), S2));
check("scenario=unconfirmed -> sentence 3", only(await page(`${base}/pay/return?scenario=unconfirmed`), S3));

const status = await call("get_status", { trip_id: tripId });
const run = status.structuredContent.runs[0];
check("get_status shows the run: awaiting-payment, five steps, no receipt yet", run?.state === "awaiting-payment" && run.steps.length === 5 && !("chargeOutcome" in run));

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
