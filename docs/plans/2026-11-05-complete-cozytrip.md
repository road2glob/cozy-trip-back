# Complete CozyTrip Implementation Plan

> Execute this plan task by task in the current isolated worktree, preserving coworker changes.

**Goal:** Deliver paid after-sales drafts, confirmed impact tracking, AA settlement, user-reported case status, and judge access.

**Architecture:** Keep all payment calls in paymentService. Persist operation leases, confirmations, runs, draft output, and case status in CozyTrip D1. Use existing TaskPass free schemas without changing the private engine. Workers AI writes prose only; deterministic facts and template fallback preserve the output contract.

**Tech Stack:** TypeScript, Cloudflare Worker/D1/AI, MCP server v2, Zod, Vitest/node:sqlite, GitHub Actions.

## 1. Persistence and domain rules

Create migrations/0002_complete.sql (schema only), src/domain/operations.ts and impact.ts. Add tests for empty migration, confirmed event changes, integer reconciliation, per-user ownership, lease contention and retries. Add new state without rewriting existing paid runs.

## 2. Paid delivery

Create src/domain/materials.ts and src/tools/verifyPayment.ts. Add Workers AI binding and bounded timeout fallback. Cache a validated draft before submit; under D1 operation lease submit only while remote Run is running, then poll terminal receipt; show output only for passed+captured. Verify existing captured run regression after deployment. Test no output before capture, failed verification/refund-required, model timeout, unsafe claims, retries and duplicate calls.

## 3. Impact and case tools

Create reconcileTrip/detectImpact/planOptions/updateCaseStatus tools. Impact preview has stateless HMAC local confirmation code and no writes. Confirmed event has deterministic idempotency key and zero-price Run; store evidence only after passed verification. Quote only for confirmed issue. Case status only after delivered receipt; local confirmation for user-submitted transitions and clearly user-reported responses.

## 4. AA tools

Create quoteSplit/createSplitPayments and persistent settlement polling. Use existing free workflow input/output and one payment ID per debtor. Only Leo/Ava receive links; Maya always due0. No links before confirmation. Refresh awaiting-payment through TaskPass reconcile and hide prompt/URL once captured. Test invalid confirmation, zero due, repeated creation, concurrent retries, callbacks and isolation.

## 5. Offline stub and all tests

Extend public deterministic stub for zero-price/output/settlement paths, never represent stub payment as real. Add integrated new-tool tests with fake completed fixture controls, model success/failure fixtures and all six minimization rules. Update existing phase-one tests to confirmed-impact gate. Add CI test job for PRs and main, with no Cloudflare secrets; main deployment depends on checks.

## 6. Judge docs, PR and release

Create English README and docs/devpost draft with truthful AI/PayPal scope and six-step judge route. Mint three judge tokens with expiry2026-12-16T00:00Z only into README and one Tim token only in reply; pepper rotation invalidates old tokens. Local typecheck/tests/build must pass. Recheck remote main and open PRs, push feature branch, create PR, await CI, admin squash merge only on pass, wait Actions deploy, inspect AI/TASKPASS bindings. Apply only schema migrations remotely.

## 7. Live acceptance

Use a transient recovery token for old run owner to complete captured order68431E then revoke it; new Tim identity remains empty for full scenario. Test all non-payment gates; stop for Tim at service-fee and two AA links. Verify captured+passed, duplicate calls, submitted_by_user confirmation, no AA Charges. Judge token pre-payment smoke uses a fresh identity. Record provider suffixes only in private E2E report, never credentials. Do not modify TaskPass paid/payment/verification code.
