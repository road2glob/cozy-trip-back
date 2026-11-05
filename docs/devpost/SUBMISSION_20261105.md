# CozyTrip — Devpost draft

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

The initial private-service E2E test produced a real USD 9.90 Sandbox capture and a passed/captured receipt. A second real MCP-created service order was captured with verified webhook delivery and exposed the missing delivery-tool step. This release adds that step, problem tracking, AA requests and judge instructions. Full release evidence is recorded separately after deployment; untested paths must not be described as complete.

## What we learned

A useful assistant needs evidence for what changed, clear state for what has not happened, and a reliable continuation after the user leaves chat to approve a payment. AI can help with wording while deterministic rules control money, consent and delivery.

## What's next

Complete and document release acceptance with dedicated judge Sandbox buyers, then improve parsing of user-provided orders, recovery suggestions and broader itinerary support. There are no live airline integrations, production payments or automated refunds in this demo.

## Built with

TypeScript, Cloudflare Workers, D1, Workers AI (Meta Llama 3.2), Model Context Protocol SDK v2, PayPal Orders v2 Sandbox, GitHub Actions, Hono, Zod, Vitest.
