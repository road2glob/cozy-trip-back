# CozyTrip

A remote MCP server (Cloudflare Worker) for group trips. Payments and verification are handled by a separate payment & verification service, reached only through `src/paymentService/`.

## Run locally

Requirements: Node.js 20+.

```sh
npm ci
cp .dev.vars.example .dev.vars        # local settings; TASKPASS_TRANSPORT=stub
npm run db:migrate:local              # creates tables in the local D1 only
npm run token:issue -- my-laptop      # prints a new demo token once; D1 stores only its hash
npm run dev                           # http://localhost:8788
```

- MCP endpoint: `http://localhost:8788/mcp` (Streamable HTTP, stateless). Send `Authorization: Bearer <demo token>`.
- Health check: `http://localhost:8788/health`
- With `TASKPASS_TRANSPORT=stub`, calls to the payment & verification service go to the deterministic stub in `stub/`. Nothing reaches PayPal.

Every `npm run token:issue` creates a new user with an empty ledger. Tokens are shown only once and are never written to the repository.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | `fetch`: `/mcp` → MCP handler, `/pay/*` and `/health` → Hono |
| `src/mcp/` | Per-request MCP server, bearer token lookup |
| `src/tools/` | MCP tools; call only `paymentService` and `domain` |
| `src/domain/` | Trips, integer cents, sample data, pure rules |
| `src/paymentService/` | One function per endpoint of the payment & verification service; the only outbound module |
| `src/routes/pay/` | `/pay/return` and `/pay/cancel` |
| `stub/` | Deterministic fake of the payment & verification service contract |
| `migrations/` | Table definitions only, no rows |
| `scripts/` | Local helpers (demo token issuance) |

Amounts are integer US cents (`990` = $9.90). Only USD.

## Configuration

| Name | Where | Notes |
|---|---|---|
| `TASKPASS_TRANSPORT` | `wrangler.jsonc` vars / `.dev.vars` | `binding` when deployed, `stub` locally, `https` as fallback |
| `PUBLIC_RETURN_ORIGIN` | `wrangler.jsonc` vars / `.dev.vars` | Origin of the return pages, no path |
| `TASKPASS_PRODUCT_TOKEN` | secret / `.dev.vars` | Sent as a second credential on every call |
| `TASKPASS_BASE_URL` | optional | Only for `TASKPASS_TRANSPORT=https` |

## License

MIT
