import type { TripDetail } from "./trips";
export function impactPreview(d: TripDetail) {
  const flight = d.bookings.find(
    (b) => b.booking_id === d.demoEvent?.booking_id,
  );
  return d.bookings.map((b) => {
    if (b.booking_id === flight?.booking_id)
      return {
        bookingId: b.booking_id,
        status: "disrupted",
        rule: "R-FLIGHT-DEMO",
        provenance: "simulated",
        evidence:
          "Explicitly confirmed fictional outbound flight cancellation; not a live airline feed.",
      };
    if (b.kind === "transfer" && b.linked_booking_id === flight?.booking_id)
      return {
        bookingId: b.booking_id,
        status: "disrupted",
        rule: "R-TRANSFER-FLIGHT-LINKED",
        provenance: "inferred",
        evidence:
          "The source transfer booking references " +
          flight?.title +
          ". Cancellation makes the linked pickup unusable.",
      };
    if (
      b.kind === "hotel" &&
      b.local_start.slice(0, 10) === flight?.local_start.slice(0, 10)
    )
      return {
        bookingId: b.booking_id,
        status: "at_risk",
        rule: "R-HOTEL-SAME-DAY",
        provenance: "inferred",
        evidence:
          "Source check-in date coincides with the affected flight date; arrival is uncertain. Hotel is not cancelled.",
      };
    return {
      bookingId: b.booking_id,
      status: "unaffected",
      rule: "R-ACTIVITY-DATE-MISMATCH",
      provenance: "source",
      evidence:
        "The source activity is on " +
        b.local_start.slice(0, 10) +
        ", a different day. No automatic change is required.",
    };
  });
}
