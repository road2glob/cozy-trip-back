import sample from "./seattle-sfo.json";
import { assertCents } from "./money";
import { newId, nowIso } from "./ids";
import { addDays, daysBetween, localDateIn, shiftLocal } from "./dates";

/** A new sample always starts this many days after its first import, so it has future dates to remind about */
export const SAMPLE_LEAD_DAYS = 7;

type Sample = typeof sample;

export interface TripRow {
  trip_id: string;
  user_id: string;
  title: string;
  origin_code: string;
  origin_city: string;
  destination_code: string;
  destination_city: string;
  start_date: string;
  end_date: string;
  timezone: string;
  state: string;
  provenance: string;
  reality: string;
  created_at: string;
}

export interface ParticipantRow {
  participant_id: string;
  name: string;
  role: string;
}

export interface BookingRow {
  booking_id: string;
  kind: string;
  vendor: string;
  title: string;
  local_start: string;
  nights: number | null;
  travelers: number | null;
  amount_minor: number;
  currency: string;
  status: string;
  linked_booking_id: string | null;
  merchant_refund_status: string | null;
}

export interface Balance {
  from_participant_id: string;
  from: string;
  to_participant_id: string;
  to: string;
  amount_minor: number;
  currency: "USD";
  booking_id: string;
}

export interface DemoEventRow {
  event_id: string;
  kind: string;
  booking_id: string;
  state: string;
}

export interface TripDetail {
  trip: TripRow;
  participants: ParticipantRow[];
  bookings: BookingRow[];
  balances: Balance[];
  demoEvent: DemoEventRow | null;
  totalMinor: number;
}

/** Sanity checks on the bundled sample: integer cents, totals and shares add up. */
export function validateSample(s: Sample = sample): void {
  const bookingTotal = s.bookings.reduce((sum, b) => sum + assertCents(b.amountMinor), 0);
  if (bookingTotal !== s.totalMinor) throw new Error(`Sample bookings total ${bookingTotal}, expected ${s.totalMinor}`);
  const expenseTotal = s.expenses.reduce((sum, e) => sum + assertCents(e.amountMinor), 0);
  if (expenseTotal !== s.totalMinor) throw new Error(`Sample expenses total ${expenseTotal}, expected ${s.totalMinor}`);
  for (const e of s.expenses) {
    if (!("shares" in e) || !e.shares) continue;
    const shareTotal = e.shares.reduce((sum, sh) => sum + assertCents(sh.amountMinor), 0);
    if (shareTotal !== e.amountMinor) throw new Error(`Shares for ${e.bookingKey} total ${shareTotal}, expected ${e.amountMinor}`);
  }
}

export async function findSampleTripId(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT trip_id FROM trips WHERE user_id = ?1 AND sample_key = ?2")
    .bind(userId, sample.sampleKey)
    .first<{ trip_id: string }>();
  return row?.trip_id ?? null;
}

/**
 * Writes Trip, Participants, Bookings, Expenses (+ shares) and the armed demo event in one batch.
 * Returns { tripId, created: false } when this user already has the sample trip.
 * Dates are worked out once, here, and stored: re-reading, re-importing or paying never moves them.
 */
export async function importSampleTrip(db: D1Database, userId: string, now = Date.now()): Promise<{ tripId: string; created: boolean }> {
  validateSample();
  const existing = await findSampleTripId(db, userId);
  if (existing) return { tripId: existing, created: false };

  const createdAt = nowIso();
  const shift = daysBetween(sample.startDate, addDays(localDateIn(now, sample.timezone), SAMPLE_LEAD_DAYS));
  const tripId = newId("trip");
  const participantIds = new Map(sample.participants.map((p) => [p.key, newId("ppl")]));
  const bookingIds = new Map(sample.bookings.map((b) => [b.key, newId("bkg")]));
  const { provenance, reality } = sample;

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO trips (trip_id, user_id, sample_key, title, origin_code, origin_city, destination_code, destination_city,
           start_date, end_date, timezone, state, provenance, reality, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'draft', ?12, ?13, ?14)`,
      )
      .bind(
        tripId,
        userId,
        sample.sampleKey,
        sample.title,
        sample.origin.code,
        sample.origin.city,
        sample.destination.code,
        sample.destination.city,
        shiftLocal(sample.startDate, shift),
        shiftLocal(sample.endDate, shift),
        sample.timezone,
        provenance,
        reality,
        createdAt,
      ),
  ];

  sample.participants.forEach((p, i) => {
    stmts.push(
      db
        .prepare(
          "INSERT INTO participants (participant_id, trip_id, name, role, sort_order, provenance, reality) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(participantIds.get(p.key)!, tripId, p.name, p.role, i, provenance, reality),
    );
  });

  sample.bookings.forEach((b, i) => {
    const linked = "linkedBookingKey" in b && b.linkedBookingKey ? bookingIds.get(b.linkedBookingKey)! : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO bookings (booking_id, trip_id, kind, vendor, title, local_start, nights, travelers, amount_minor, currency,
             status, linked_booking_id, merchant_refund_status, sort_order, provenance, reality)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'USD', 'confirmed', ?10, ?11, ?12, ?13, ?14)`,
        )
        .bind(
          bookingIds.get(b.key)!,
          tripId,
          b.kind,
          b.vendor,
          b.title,
          shiftLocal(b.localStart, shift),
          "nights" in b ? b.nights : null,
          "travelers" in b ? b.travelers : null,
          assertCents(b.amountMinor),
          linked,
          "merchantRefundStatus" in b ? b.merchantRefundStatus : null,
          i,
          provenance,
          reality,
        ),
    );
  });

  for (const e of sample.expenses) {
    const expenseId = newId("exp");
    const paidBy = "paidBy" in e && e.paidBy ? participantIds.get(e.paidBy)! : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO expenses (expense_id, trip_id, booking_id, amount_minor, currency, paid_by_participant_id, payment_method, provenance, reality)
           VALUES (?1, ?2, ?3, ?4, 'USD', ?5, ?6, ?7, ?8)`,
        )
        .bind(
          expenseId,
          tripId,
          bookingIds.get(e.bookingKey)!,
          assertCents(e.amountMinor),
          paidBy,
          "paymentMethod" in e ? e.paymentMethod : null,
          provenance,
          reality,
        ),
    );
    if ("shares" in e && e.shares) {
      for (const sh of e.shares) {
        stmts.push(
          db
            .prepare("INSERT INTO expense_shares (expense_id, participant_id, amount_minor) VALUES (?1, ?2, ?3)")
            .bind(expenseId, participantIds.get(sh.participantKey)!, assertCents(sh.amountMinor)),
        );
      }
    }
  }

  stmts.push(
    db
      .prepare("INSERT INTO demo_events (event_id, trip_id, kind, booking_id, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(newId("evt"), tripId, sample.demoEvent.kind, bookingIds.get(sample.demoEvent.bookingKey)!, sample.demoEvent.state, createdAt),
  );

  try {
    await db.batch(stmts);
  } catch (err) {
    // A concurrent import for the same user hit UNIQUE(user_id, sample_key) first: return that trip.
    const raced = await findSampleTripId(db, userId);
    if (raced) return { tripId: raced, created: false };
    throw err;
  }
  return { tripId, created: true };
}

export async function listTripIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT trip_id FROM trips WHERE user_id = ?1 ORDER BY created_at, trip_id")
    .bind(userId)
    .all<{ trip_id: string }>();
  return results.map((r) => r.trip_id);
}

/** Returns null when the trip does not exist or belongs to another user */
export async function getTripDetail(db: D1Database, userId: string, tripId: string): Promise<TripDetail | null> {
  const trip = await db
    .prepare(
      `SELECT trip_id, user_id, title, origin_code, origin_city, destination_code, destination_city, start_date, end_date,
              timezone, state, provenance, reality, created_at
         FROM trips WHERE trip_id = ?1 AND user_id = ?2`,
    )
    .bind(tripId, userId)
    .first<TripRow>();
  if (!trip) return null;

  const [participants, bookings, shares, demoEvent] = await Promise.all([
    db
      .prepare("SELECT participant_id, name, role FROM participants WHERE trip_id = ?1 ORDER BY sort_order")
      .bind(tripId)
      .all<ParticipantRow>(),
    db
      .prepare(
        `SELECT booking_id, kind, vendor, title, local_start, nights, travelers, amount_minor, currency, status,
                linked_booking_id, merchant_refund_status
           FROM bookings WHERE trip_id = ?1 ORDER BY sort_order`,
      )
      .bind(tripId)
      .all<BookingRow>(),
    db
      .prepare(
        `SELECT e.booking_id, e.paid_by_participant_id, payer.name AS payer_name,
                s.participant_id, debtor.name AS debtor_name, s.amount_minor
           FROM expenses e
           JOIN expense_shares s ON s.expense_id = e.expense_id
           JOIN participants payer ON payer.participant_id = e.paid_by_participant_id
           JOIN participants debtor ON debtor.participant_id = s.participant_id
          WHERE e.trip_id = ?1 AND s.participant_id <> e.paid_by_participant_id
          ORDER BY debtor.sort_order`,
      )
      .bind(tripId)
      .all<{
        booking_id: string;
        paid_by_participant_id: string;
        payer_name: string;
        participant_id: string;
        debtor_name: string;
        amount_minor: number;
      }>(),
    db
      .prepare("SELECT event_id, kind, booking_id, state FROM demo_events WHERE trip_id = ?1 ORDER BY created_at LIMIT 1")
      .bind(tripId)
      .first<DemoEventRow>(),
  ]);

  const balances: Balance[] = shares.results.map((s) => ({
    from_participant_id: s.participant_id,
    from: s.debtor_name,
    to_participant_id: s.paid_by_participant_id,
    to: s.payer_name,
    amount_minor: s.amount_minor,
    currency: "USD",
    booking_id: s.booking_id,
  }));

  return {
    trip,
    participants: participants.results,
    bookings: bookings.results,
    balances,
    demoEvent: demoEvent ?? null,
    totalMinor: bookings.results.reduce((sum, b) => sum + b.amount_minor, 0),
  };
}
