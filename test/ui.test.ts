import { describe, expect, it } from "vitest";
import { cardFor, formatLocal, minutesLeft, quoteStage, type CardAction } from "../ui/views";
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
  it("walks empty -> trip -> impact -> options -> quote -> payment -> delivery -> status, pressing the server's own buttons", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);

    const empty = cardFor((await getStatus.run(ctx, {})).structuredContent);
    if (empty.kind !== "empty") throw new Error(`expected empty, got ${empty.kind}`);
    expect(empty.actions).toEqual([{ label: "Import sample trip", tool: "import_orders", args: { mode: "sample" } }]);

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
    expect(trip.simulated).toBe(true);

    // The card only knows buttons the server sent, and pressing one is exactly this call.
    const press = async <A>(mod: { run(c: typeof ctx, a: A): Promise<{ structuredContent: Record<string, unknown> }> }, action: CardAction) =>
      cardFor((await mod.run(ctx, action.args as A)).structuredContent);

    const preview = await press(detectImpact, trip.actions[0]);
    if (preview.kind !== "impact") throw new Error(`expected impact, got ${preview.kind}`);
    expect(preview.preview).toBe(true);
    expect(preview.rows.map((r) => `${r.label}:${r.statusLabel}`)).toEqual([
      "Sample Air 210 SEA to SFO:Disrupted",
      "Sample Bay Hotel, 3 nights:At risk",
      "Sample Transfer Co airport pickup:Disrupted",
      "Sample Bay Cruise:Unaffected",
    ]);
    expect(preview.rows.map((r) => r.provenance)).toEqual(["Simulated", "Inferred", "Inferred", "From the booking"]);
    expect(preview.actions.map((a) => a.label)).toEqual(["Confirm simulation"]);

    const confirmed = await press(detectImpact, preview.actions[0]);
    if (confirmed.kind !== "impact") throw new Error(`expected impact, got ${confirmed.kind}`);
    expect(confirmed.preview).toBe(false);
    // The impact card has no way to a payment.
    expect(confirmed.actions.map((a) => a.tool)).toEqual(["plan_options"]);

    const options = await press(planOptions, confirmed.actions[0]);
    if (options.kind !== "options") throw new Error(`expected options, got ${options.kind}`);
    expect(options.options.map((o) => o.title)).toEqual(["Rebook with the airline", "Coordinate the hotel and pickup", "CozyTrip prepared drafts"]);
    expect(options.options.map((o) => o.cost)).toEqual([null, null, "USD 9.90"]);
    expect(options.actions.map((a) => a.label)).toEqual(["Get a quote for the drafts"]);

    const quote = await press(quoteService, options.actions[0]);
    if (quote.kind !== "quote") throw new Error(`expected quote, got ${quote.kind}`);
    expect(quote.price).toBe("USD 9.90");
    expect(quote.stub).toBe(true);
    expect(quote.scope).toHaveLength(4);
    expect(quote.actions.map((a) => a.label)).toEqual(["Confirm USD 9.90"]);

    const payment = await press(createServicePayment, quote.actions[0]);
    if (payment.kind !== "payment") throw new Error(`expected payment, got ${payment.kind}`);
    expect(payment.stub).toBe(true);
    expect(new URL(payment.approveUrl).hostname).toBe("localhost");

    // The stub never captures: the delivery card must say not confirmed and show no materials.
    const delivery = cardFor((await verifyPayment.run(ctx, { trip_id: trip.tripId, run_id: payment.runId })).structuredContent);
    if (delivery.kind !== "delivery") throw new Error(`expected delivery, got ${delivery.kind}`);
    expect(delivery.paid).toBe(false);
    expect(delivery.pending).toBe("unconfirmed");
    expect(delivery.materials).toEqual([]);
    expect(delivery.actions.map((a) => a.label)).toEqual(["Check again", "Back to PayPal"]);

    const status = cardFor((await getStatus.run(ctx, { trip_id: trip.tripId })).structuredContent);
    if (status.kind !== "status") throw new Error(`expected status, got ${status.kind}`);
    expect(status.runs[0].sentence).toBe("Order created. Not paid.");
    expect(status.runs[0].steps.map((s) => `${s.label}:${s.state}`)).toEqual([
      "Approval:done",
      "Payment:current",
      "Execute:todo",
      "Verify:todo",
      "Receipt:todo",
    ]);
    expect(status.runs[0].chargeOutcome).toBeNull();
    expect(status.actions[0]).toMatchObject({ label: "Check again", tool: "verify_payment" });
  });

  it("shows tool errors as an error card", async () => {
    const { env } = testEnv();
    const r = await createServicePayment.run(toolCtx(env), { trip_id: "trip_x", run_id: "run_x" });
    expect(cardFor(r.structuredContent)).toMatchObject({ kind: "error", code: "confirmation_required" });
  });

  it("offers approve, a new quote after expiry, or the existing link once approved", () => {
    const now = Date.parse("2026-11-05T10:00:00.000Z");
    expect(quoteStage({ state: "awaiting-approval", expiresAt: "2026-11-05T10:20:00.000Z" }, now)).toEqual({ stage: "approve", minutesLeft: 20 });
    expect(quoteStage({ state: "awaiting-approval", expiresAt: "2026-11-05T09:59:00.000Z" }, now)).toEqual({ stage: "expired" });
    expect(quoteStage({ state: "awaiting-payment", expiresAt: "2026-11-05T09:00:00.000Z" }, now)).toEqual({ stage: "approved" });
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
