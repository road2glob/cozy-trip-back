# CozyTrip

A remote MCP server (Cloudflare Worker) for group trips. Payments and verification are handled by a separate payment & verification service, reached only through `src/paymentService/`. CozyTrip never calls PayPal and holds no PayPal credentials.

Phase 1 runs locally with `TASKPASS_TRANSPORT=stub`: a deterministic fake of the payment service contract. Nothing reaches PayPal and nothing is charged.

## Run locally

Requirements: Node.js 22+ (uses `node:sqlite` in tests). No Cloudflare login is needed.

```sh
npm ci
npm run dev:init            # creates .dev.vars with local random DEMO_TOKEN_PEPPER and TASKPASS_PRODUCT_TOKEN
npm run db:migrate:local    # creates the tables in the local D1 only (no rows)
npm run token:issue         # prints a new demo token once, for user usr_local_dev; D1 stores only its HMAC
npm run dev                 # http://localhost:8788
```

`npm run token:issue -- --user usr_someone_else --label laptop` issues a token for another user, which starts with an empty ledger.

### Connect with MCP Inspector

```sh
npx @modelcontextprotocol/inspector@latest
```

Transport: Streamable HTTP. URL: `http://localhost:8788/mcp`. Header: `Authorization: Bearer <demo token>`.

Tools in phase 1: `get_status`, `import_orders` (`mode: "sample"`), `quote_service`, `create_service_payment`. The approve link that `create_service_payment` returns opens a local stub page, not PayPal.

### Return pages

`/pay/return` and `/pay/cancel` show one sentence each. In stub mode only, `?scenario=returned|cancelled|unconfirmed` selects the sentence so each one can be viewed:

- http://localhost:8788/pay/return?scenario=returned
- http://localhost:8788/pay/cancel?scenario=cancelled
- http://localhost:8788/pay/return?scenario=unconfirmed

Outside stub mode `scenario` is ignored.

### Checks

```sh
npm run typecheck
npm test                                                    # unit tests, no server needed
COZYTRIP_TOKEN=<demo token> node scripts/smoke-local.mjs    # end-to-end against npm run dev
```

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | `fetch`: `/mcp` → MCP handler, `/pay/*` and `/health` → Hono |
| `src/mcp/` | Per-request MCP server, bearer token lookup |
| `src/tools/` | MCP tools; call only `paymentService` and `domain` |
| `src/domain/` | Trips, integer cents, the sample trip (`seattle-sfo.json`), D1 access |
| `src/paymentService/` | One function per endpoint of the payment & verification service; the only outbound module |
| `src/routes/pay/` | `/pay/return` and `/pay/cancel` |
| `stub/` | Deterministic fake of the service contract (stub mode only). Its fake state lives in local D1 tables prefixed `stub_`, created on demand, never in migrations |
| `migrations/` | Table definitions only, no rows |
| `scripts/` | Local helpers: `.dev.vars` setup, demo token issuance, smoke test |
| `test/` | Unit tests (vitest) on an in-memory SQLite stand-in for D1 |

Amounts are integer US cents (`990` = USD 9.90). Only USD.

## Configuration

| Name | Where | Notes |
|---|---|---|
| `TASKPASS_TRANSPORT` | `wrangler.jsonc` vars / `.dev.vars` | `binding` when deployed, `stub` locally, `https` fallback only |
| `PUBLIC_RETURN_ORIGIN` | `wrangler.jsonc` vars / `.dev.vars` | Origin of the return pages, no path |
| `TASKPASS_PRODUCT_TOKEN` | secret / `.dev.vars` | Second credential sent on every call to the payment service |
| `DEMO_TOKEN_PEPPER` | secret / `.dev.vars` | HMAC key for demo token hashes; without it every MCP request gets 401 |
| `TASKPASS_BASE_URL` | optional | Only for `TASKPASS_TRANSPORT=https` |

## License

MIT
