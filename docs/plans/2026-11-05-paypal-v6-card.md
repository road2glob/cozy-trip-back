# PayPal v6 service-fee card spike

Base: main `e18b028` after Tim merged PR #9. Branch: `feat/paypal-v6-card`.

Keep the existing ui/views.ts, ui/render.ts, App host bridge, esbuild output and stale-output test. Only real, pending service orders with a server-provided PayPal order ID select the new paypal_checkout view. Stub checkout and every other existing view retain their behavior. The resource URI remains ui://cozytrip/card.html.

1. Pass the public Sandbox client ID from the ordinary Wrangler var into a safely escaped resource placeholder. Generated source contains no actual ID. Add only the specified Sandbox PayPal CSP domains.
2. Add a small PayPal v6 controller. Load the Sandbox core script only for checkout, reuse the existing order ID with popup presentation, and call the existing verify_payment host action on approval. No browser payment API or capture operation.
3. Bound initialization/render readiness to eight seconds. Failure switches to the existing open-link button; unsupported/rejected host links become copyable text. Cancel shows Nothing was charged. No local state declares payment success. Dispose stale listeners and ignore old asynchronous results when a new tool result arrives.
4. Test the existing flows plus SDK approval/cancel/failure, invalid IDs, initialization timeout, host fallback, resource metadata and build freshness. Run TypeScript, offline tests, local stub/Inspector and a Worker dry build.
5. Open PR, pass CI, merge using the authorized admin squash, and deploy only with GitHub Actions. Verify hosted tools/resource/health without paying. Record the five Cursor checks as pending Tim tests.

AA and case/reconciliation cards are explicitly deferred until Tim validates this spike. Do not change private-service code, secrets, token pepper, migrations, prices, confirmation gates or return-page copy. Judge B/C are untouched. No payment is performed by Codex.
