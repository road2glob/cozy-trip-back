# CozyTrip — Devpost draft

Access and source-availability correction, 2026-11-06. The current judge entry paths are documented in the repository README. The original implementation narrative below records the November 5 release.

## Judge access

Connect an MCP client to https://mcp.cozytrip.dev/mcp with a published judge token from the README. Judge A has a verified USD 9.90 service receipt and two captured USD 60 shares, confirmed with hosted `get_status` on November 6. Use this identity to view the existing drafts and paid-share status with no new checkout. Start with `get_status` and reuse the returned trip/run IDs.

Judge B and C are reserved for sample onboarding and new orders. Read their current state first because the demo identities are shared, and reuse existing orders. A team-supplied PayPal Sandbox Personal buyer email and password are saved in the Devpost submission's private **Testing instructions or credentials** field for judges and organizers. Use that buyer only on the PayPal Sandbox checkout page, then return to chat and say “Check my payment.” Judges may alternatively use their own test buyer. The public README explains both entry paths and where judges can find the supplied login.

## Source availability for judging

The MIT repository contains the MCP application, UI, trip ledger, AI drafting, payment-service client and deterministic local stub. The server-side PayPal order/capture/webhook and receipt engine runs as a private hosted service. Local setup reproduces the simulated contract flow. The hosted endpoint provides the real Sandbox integration. Reproducing that integration from source also requires the private service.

The official rules require a public repository with the source, assets and instructions needed for a functional project, separately from access to a hosted demo. Organizer acceptance of this private-service dependency remains unconfirmed. This disclosure records the available source and testing routes. [Official rules, section 4](https://paypalaihackathon.devpost.com/rules)

## Inspiration

A disrupted group trip creates several kinds of unfinished work: understanding which bookings are affected, asking merchants about changes, tracking what the traveler actually sent, and settling the original shared expense. A chat assistant should distinguish those tasks and make its next step match the facts and the user's consent.

## What it does

CozyTrip is a hosted MCP server for compatible AI clients. A user starts with an empty ledger, explicitly imports a fictional Seattle–San Francisco itinerary, reconciles its source expenses and previews a fictional flight cancellation. A separate confirmation triggers the sample event and records an impact assessment with rule-based evidence. Recovery options explain unknown fees and availability instead of inventing live offers.

A quoted USD 9.90 Sandbox service order unlocks prepared request drafts only after captured payment and a passed verification receipt. Travelers can record that they personally sent the drafts and track user-reported merchant responses. The AA path calculates a prepaid USD 180 pickup as three USD 60 shares, excludes the organizer's sample-paid share and creates two member payment requests. The recipient is the CozyTrip Team Sandbox merchant, not the person who prepaid.

## How we built it

TypeScript, Cloudflare Workers and D1 maintain the trip ledger and purpose-bound confirmations. MCP SDK v2 tools return both text and structured content. A private hosted payment and verification service is reached through a Service Binding; CozyTrip never receives PayPal credentials.

PayPal Orders v2 Sandbox is central to both the service fee and separate merchant settlement orders. Payment creation and capture use server-side idempotency keys, and webhook events are accepted only after signature verification. The UI does not interpret a browser return as proof of delivery.

Workers AI drafts wording for airline contact points, hotel changes and pickup/cruise requests after payment. Deterministic code supplies dates, amounts and booking facts; the model cannot choose prices, capture money or contact a merchant. Unsafe or invalid prose, provider errors and a twelve-second timeout use templates. Every delivered item is marked Draft. Not sent.

## Challenges

Browser returns, webhook deliveries and polling may arrive in any order. We keep transaction identifiers and workflow state persistent and make retries reuse the existing work. Service-fee Charges and AA settlement payments are separate; the organizer never receives a duplicate payment request. Confirmations are also separate: simulating a problem, purchasing drafts, requesting member payments and recording personal submission are different decisions.

## Accomplishments

The deployed MCP release completed a real USD 9.90 Sandbox service capture and delivered three drafts only after a passed/captured receipt. It also captured separate USD 60 Sandbox settlement orders for Leo and Ava; Maya received no payment request. All three orders have signature-verified approval and capture webhook records. Repeated verification and settlement checks reused the same records, and the two member payments created no service-fee Charges.

The paid delivery used the documented template fallback. We diagnosed malformed model output, added a three-string JSON schema, and tested the exact updated drafting function with a real remote Workers AI binding: it returned AI-written requests in under two seconds. That separate AI test did not create another payment or replace a verified delivery. The release passes 57 offline tests. Case tracking remains prepared because the fictional merchants were never contacted; confirmed transitions are covered offline.

## What we learned

A useful assistant needs evidence for what changed, clear state for what has not happened, and a reliable continuation after the user leaves chat to approve a payment. AI can help with wording while deterministic rules control money, consent and delivery.

## What's next

Add dedicated judge Sandbox buyers, record a complete AI-assisted judging walkthrough, then improve parsing of user-provided orders, recovery suggestions and broader itinerary support. There are no live airline integrations, production payments or automated refunds in this demo.

## Built with

TypeScript, Cloudflare Workers, D1, Workers AI (Meta Llama 3.2), Model Context Protocol SDK v2, PayPal Orders v2 Sandbox, GitHub Actions, Hono, Zod, Vitest.
