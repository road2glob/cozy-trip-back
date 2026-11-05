# Acceptance result for the product logic handoff

Date: 2026-11-05. Covers section 8 of `PRODUCT_LOGIC_HANDOFF_20261105.md`, on the branch stack #11 to #15.

**Result: of the 24 scenarios, 19 are proven on CozyTrip's side and 5 are proven in part. None failed. Nothing here ran on a real host, a real calendar or a real PayPal payment, so the demo still needs the checks listed under "What only a real host can prove".**

## How each result was checked

| Evidence | What it is | What it does not prove |
|---|---|---|
| **Tests** | `npm test`, 231 tests. `test/acceptance.test.ts` has one test or more per scenario (`npx vitest run -t "S13"`), through the real tool wrapper and real card DOM, checked in both the text and the card. | Payments and calendar receipts are fixtures. |
| **Browser** | The real built card in headless Chrome, under the official `AppBridge` and the resource's own CSP, calling a real local Worker on the stub transport. 41 checks. | Not a real host. No PayPal payment. |
| **Real SDK** | The real PayPal v6 Sandbox SDK and button inside the real card. Fake order IDs, nothing clicked. | No popup and no approval. |
| **Model** | Three scripted Chinese conversations with a small Claude model (Haiku), given only the server's instructions, tool list and text results, on the local stub. 29 turns. | One model, not a real host, no cards. |
| **Smoke** | `scripts/smoke-local.mjs` against `wrangler dev --local`. 35 checks, including time-zone maths on workerd. | Stub transport. |

I also broke 39 key behaviors one at a time to confirm the tests catch them. All 39 are caught, after two tests were tightened because of this check and one was extended. An independent code review of the whole stack raised 10 findings. All 10 were real and are fixed here, each with a test.

## Results

| # | Scenario | Result | Evidence and what is open |
|---|---|---|---|
| 1 | Empty ledger shows only import | Proven | Tests, browser, model. The first model run named Seattle, taken from a tool description. That is fixed, and the second run did not. |
| 2 | Existing ledger resumes, no re-import or new order | Proven | Tests |
| 3 | Order check only | Proven | Tests |
| 4 | AA only, no purchase | Proven | Tests, model |
| 5 | Preview changes nothing; confirm has complete evidence labels | Proven | Tests, browser |
| 6 | Can stop at options | Proven | Tests, model |
| 7 | Unconfirmed quote has no order; confirm reuses it | Proven | Tests, browser, on the stub |
| 8 | SDK and link paths both reach a server check; after opening, Check again | **In part** | Link path: browser, through to the server check. SDK path: the real button renders in the real card, but approval has only run with a fake SDK. **A real popup and approval are not proven**, as your document already says for Cursor. |
| 9 | Return, cancel, close and timeout never guess | Proven | Tests. `/pay/cancel` now needs the service's answer before it says nothing was charged. |
| 10 | Captured with empty output continues; repeats do not double up | Proven | Tests, with fixtures |
| 11 | Drafts only on passed + captured; AI failure falls back | Proven | Tests, with AI failure injected |
| 12 | Two USD 60 orders, none for Maya, reused, no service charge | Proven | Tests, on the stub |
| 13 | One paid loses its entry; all paid has none | Proven | Tests, with fixtures |
| 14 | No claims without a report; no skipping stages | Proven | Tests |
| 15 | Natural language works; cards connect to the conversation | **In part** | Tests and browser prove the mapping, and that a card press tells the model not to ask again. Model: right tool on the phrases tried, and no tool names or codes shown. **One small model only.** |
| 16 | Not connected: no pretending | **In part** | Tests: no token means nothing is read. What a model says before it connects is outside this server, as your document notes. |
| 17 | Only sample import; real orders get an accurate scope | Proven | Tests, model |
| 18 | A stated intent continues without a re-welcome | **In part** | Tests: nothing forces an order of steps. Model: "AA" went straight to the split after import. Real hosts not tried. |
| 19 | No write before agreement; no tool or a failure is reported accurately | **In part** | Tests: results are refused before agreement, and partial failure is reported per reminder. Model: said not set when it had no calendar tool. **No real calendar has been written.** |
| 20 | Lead times, time zone, precision, past reminders, no duplicates | Proven | Tests, smoke |
| 21 | Paid or done stops reminders; only CozyTrip's entries are touched | Proven | Tests |
| 22 | Sample label and a way back in words, no promises | Proven | Tests. Text checked; not seen in a real calendar. |
| 23 | New samples have future dates; old trips and paid records stay | Proven | Tests, smoke |
| 24 | Original palette, necessary actions, no IDs showing | Proven, with one assumption | Tests, and every card state read as screenshots in light and dark. **The palette is the one from `travel-pa`; please confirm it is the demo you mean.** Not seen in a real host. |

## What only a real host can prove

1. **Does the host show the PayPal button?** See the finding below. Cursor did before. Claude and ChatGPT need checking.
2. **Popup and approval.** On a host that shows the button, approve with a dedicated Sandbox buyer. Confirm that the service fee runs `verify_payment` and a share runs `split_status`, without being asked.
3. **Two buttons in a real payment.** Pay Leo's share and then Ava's on one card.
4. **A real calendar write.** You need to choose a host with a writable calendar. Section 6.4 makes this the condition for calling calendars done, so **I count it as not done yet**.
5. **Your model and host.** Run the example conversations from section 6.3 once on the host you will demo.

Before those checks can run on the hosted server, apply `migrations/0003_reminders.sql` remotely. Until then the reminder tools stay hidden.

## Findings you may want to act on

**The PayPal button cannot work in a `srcdoc` card.** The SDK's handshake with its own frame uses `location.origin`, which is `"null"` in a `srcdoc` document, so `createInstance` always ends in `ERR_DEV_POST_MESSAGE_ACK_TIMEOUT`, with or without the CSP. Results in headless Chrome:

| How the host loads the card | PayPal button |
|---|---|
| `document.write` (what the official `basic-host` example does first) | Renders |
| A URL | Renders |
| `srcdoc` | **Never**, after about 22 seconds |
| Each of the above, behind a sandbox proxy on another origin | Same results |

So whether a judge sees the button depends on the host. The card now detects this and goes straight to Open PayPal, with no SDK request and no wait. Your Cursor result suggests Cursor does not use `srcdoc`. I could not find out what Claude or ChatGPT use.

**Eight seconds can be tight.** Through this machine's proxy, a cold SDK load took over eight seconds and the card fell back to the link, while cached loads took about four to six. The fallback is honest, but a judge's first card on a slow network may not show the button. I left your eight seconds unchanged. Raising it would be one number in `ui/paypal.ts`.

**Two buttons do render on one page,** with one shared SDK instance and one session per order. Clicking them is item 3 above.

**Smaller notes:**
- PayPal's button follows the browser's language, so it read in Chinese on this machine, and it keeps its own square corners. The card leaves both alone, as section 6.5 asks.
- The browser reports one CSP notice about `eval` from `zod`. It is caught and harmless.
- `check.yml` only runs on PRs into `main`, so #12 to #15 get no CI until they are retargeted. I ran the same three commands locally on the top of the stack.
- In the first two model runs, the small model said it would "record" a payment after "paid", though the check itself was right. After I narrowed one instruction and added a line saying only the check marks a share as paid, the third run said it would check again instead. One run is not proof, so this is worth watching on your host.
- With no calendar tool, the first model run still confirmed the plan before saying the reminders were not set. Nothing false was said and nothing was written, so I left it.
- The judge path in the README still has six steps and does not mention reminders. That text is yours, so I left it.
