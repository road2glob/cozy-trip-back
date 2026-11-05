import { describe, expect, it } from "vitest";
import { cardFor, formatLocal, minutesLeft, quoteStage } from "../ui/views";
import * as getStatus from "../src/tools/getStatus";
import * as importOrders from "../src/tools/importOrders";
import * as detectImpact from "../src/tools/detectImpact";
import * as planOptions from "../src/tools/planOptions";
import * as quoteService from "../src/tools/quoteService";
import * as createServicePayment from "../src/tools/createServicePayment";
import * as verifyPayment from "../src/tools/verifyPayment";
import { CARD_HTML } from "../src/ui/cardHtml.generated";
// @ts-expect-error plain ESM build script without types
import { buildCardHtml } from "../scripts/build-ui.mjs";
import { testEnv, toolCtx } from "./helpers/env";

describe("card views from real tool results", () => {
  it("walks empty -> trip -> impact -> options -> quote -> payment -> delivery -> status with the right card each time", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);

    expect(cardFor((await getStatus.run(ctx, {})).structuredContent)).toEqual({ kind: "empty" });

    const trip = cardFor((await importOrders.run(ctx, { mode: "sample" })).structuredContent);
    if (trip.kind !== "trip") throw new Error(`expected trip, got ${trip.kind}`);
    expect(trip.title).toBe("Seattle to San Francisco");
    expect(trip.dates).toBe("Nov 8 – Nov 11");
    expect(trip.travelers).toEqual([
      { name: "Maya", organizer: true },
      { name: "Leo", organizer: false },
      { name: "Ava", organizer: false },
    ]);
    expect(trip.bookings.map((b) => b.amount)).toEqual(["USD 645.00", "USD 540.00", "USD 180.00", "USD 126.00"]);
    expect(trip.bookings[2].detail).toBe("Nov 8 · linked to Sample Air 210 SEA to SFO · prepaid by Maya");
    expect(trip.total).toBe("USD 1,491.00");
    expect(trip.balances).toEqual([
      { text: "Leo owes Maya", amount: "USD 60.00" },
      { text: "Ava owes Maya", amount: "USD 60.00" },
    ]);
    expect(trip.simulated).toBe(true);
    expect(trip.demoArmed).toBe(true);

    // Main gates the quote behind a confirmed impact: preview, then confirm with the local code.
    const preview = cardFor((await detectImpact.run(ctx, { trip_id: trip.tripId })).structuredContent);
    if (preview.kind !== "impact") throw new Error(`expected impact, got ${preview.kind}`);
    expect(preview.preview).toBe(true);
    expect(preview.code).not.toBe("");
    expect(preview.rows.map((r) => `${r.label}:${r.statusLabel}`)).toEqual(["Flight:Disrupted", "Hotel:At risk", "Airport pickup:Disrupted", "Activity:Unaffected"]);

    const confirmed = cardFor((await detectImpact.run(ctx, { trip_id: trip.tripId, confirmation_code: preview.code })).structuredContent);
    if (confirmed.kind !== "impact") throw new Error(`expected impact, got ${confirmed.kind}`);
    expect(confirmed.preview).toBe(false);
    expect(confirmed.code).toBe("");
    expect(confirmed.runId).not.toBe("");

    const options = cardFor((await planOptions.run(ctx, { trip_id: trip.tripId })).structuredContent);
    if (options.kind !== "options") throw new Error(`expected options, got ${options.kind}`);
    expect(options.options.map((o) => o.title)).toEqual(["Rebook with the airline", "Coordinate the hotel and pickup", "CozyTrip prepared drafts"]);
    expect(options.options.map((o) => o.cost)).toEqual([null, null, "USD 9.90"]);

    const quote = cardFor((await quoteService.run(ctx, { trip_id: trip.tripId })).structuredContent);
    if (quote.kind !== "quote") throw new Error(`expected quote, got ${quote.kind}`);
    expect(quote.price).toBe("USD 9.90");
    expect(quote.stub).toBe(true);
    expect(quote.code).toMatch(/^apt_/);

    const payment = cardFor(
      (await createServicePayment.run(ctx, { trip_id: trip.tripId, run_id: quote.runId, confirmation_code: quote.code })).structuredContent,
    );
    if (payment.kind !== "payment") throw new Error(`expected payment, got ${payment.kind}`);
    expect(payment.stateLabel).toBe("Awaiting payment");
    expect(payment.stub).toBe(true);
    expect(new URL(payment.approveUrl).hostname).toBe("localhost");

    // The stub never captures: the delivery card must say not confirmed and show no materials.
    const delivery = cardFor((await verifyPayment.run(ctx, { trip_id: trip.tripId, run_id: quote.runId })).structuredContent);
    if (delivery.kind !== "delivery") throw new Error(`expected delivery, got ${delivery.kind}`);
    expect(delivery.paid).toBe(false);
    expect(delivery.materials).toEqual([]);

    const status = cardFor((await getStatus.run(ctx, { trip_id: trip.tripId })).structuredContent);
    if (status.kind !== "status") throw new Error(`expected status, got ${status.kind}`);
    expect(status.runs[0].label).toBe("Awaiting payment");
    expect(status.runs[0].steps.map((s) => `${s.label}:${s.state}`)).toEqual([
      "Approval:done",
      "Payment:current",
      "Execute:todo",
      "Verify:todo",
      "Receipt:todo",
    ]);
    expect(status.runs[0].chargeOutcome).toBeNull();
  });

  it("shows tool errors as an error card", async () => {
    const { env } = testEnv();
    const r = await createServicePayment.run(toolCtx(env), { trip_id: "trip_x", run_id: "run_x" });
    expect(cardFor(r.structuredContent)).toMatchObject({ kind: "error", code: "confirmation_required" });
  });

  it("offers approve, a new quote after expiry, or the existing link once approved", () => {
    const base = { tripId: "t", runId: "r", title: "x", price: "USD 9.90", code: "apt_1", stub: true };
    const now = Date.parse("2026-11-05T10:00:00.000Z");
    expect(quoteStage({ ...base, state: "awaiting-approval", expiresAt: "2026-11-05T10:20:00.000Z" }, now)).toEqual({ stage: "approve", minutesLeft: 20 });
    expect(quoteStage({ ...base, state: "awaiting-approval", expiresAt: "2026-11-05T09:59:00.000Z" }, now)).toEqual({ stage: "expired" });
    expect(quoteStage({ ...base, state: "awaiting-payment", expiresAt: "2026-11-05T09:00:00.000Z" }, now)).toEqual({ stage: "approved" });
  });

  it("formats local trip times without time-zone math", () => {
    expect(formatLocal("2026-11-08")).toBe("Nov 8");
    expect(formatLocal("2026-11-10T14:00")).toBe("Nov 10, 14:00");
    expect(minutesLeft("2026-11-05T10:30:00.000Z", Date.parse("2026-11-05T10:00:00.000Z"))).toBe(30);
    expect(minutesLeft("2026-11-05T09:00:00.000Z", Date.parse("2026-11-05T10:00:00.000Z"))).toBe(0);
  });
});

describe("card HTML", () => {
  it("is self-contained: inline style and script only, no external resources", () => {
    expect(CARD_HTML).toContain('<main id="root"');
    expect(CARD_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(CARD_HTML).not.toMatch(/<link[^>]+href=/i);
    expect(CARD_HTML).not.toMatch(/@import|fonts\.googleapis/i);
    expect(CARD_HTML.match(/<\/script>/gi)).toHaveLength(1);
  });

  it("matches its sources (run npm run build:ui after editing ui/)", async () => {
    expect(await buildCardHtml()).toBe(CARD_HTML);
  });
});
