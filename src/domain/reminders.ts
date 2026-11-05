// The Demo reminder plan. CozyTrip works out what is worth a reminder and remembers what was written;
// the host's own calendar tool does the writing, because CozyTrip holds no calendar access. A plan is
// never a reminder: an entry counts as set only when the host reports a receipt for it.
import type { TripDetail } from "./trips";
import { addDays, displayLocal, localToUtc, utcToLocal } from "./dates";

export const DEMO_LABEL = "CozyTrip Demo / 样本行程";
const BEIJING = "Asia/Shanghai";
const MERGE_WITHIN_MS = 60 * 60_000;
const TWO_HOURS_MS = 2 * 60 * 60_000;
export const EVENT_MINUTES = 15;

export const REMINDER_DESCRIPTION =
  "Fictional CozyTrip sample, not a real booking. To continue, ask CozyTrip about this trip in your AI chat.";

export interface ReminderSettings {
  /** Trip-local time of day for reminders that are about a date, not a time */
  notify_time: string;
  /** Only ever set by the person: the leave-home reminder needs their own time */
  leave_home_at: string | null;
  /** The merchant's promised time, or an interval the person chose, as a trip-local date-time */
  follow_up_at: string | null;
  exclude: string[];
  calendar_name: string | null;
}

export const DEFAULT_SETTINGS: ReminderSettings = { notify_time: "09:00", leave_home_at: null, follow_up_at: null, exclude: [], calendar_name: null };

export interface ReminderItem {
  key: string;
  what: string;
  /** What goes on the calendar. Always carries the Demo label. */
  title: string;
  description: string;
  lead: string;
  start_local: string;
  start_utc: string;
  timezone: string;
  duration_minutes: number;
  display_when: string;
  display_beijing: string;
}

/** What else on the trip decides whether a reminder still makes sense */
export interface ReminderFacts {
  /** Names of members whose shares are still waiting for payment */
  unpaidShares: string[];
  /** case_progress state, once there is a delivered service order */
  caseState: string | null;
}

interface Draft {
  key: string;
  what: string;
  lead: string;
  local: string;
}

export interface BuiltPlan {
  items: ReminderItem[];
  /** Keys that fell in the past. An entry already written for one is left alone, not removed. */
  pastKeys: string[];
  notes: string[];
}

/** Rules from section 6.4 of the product handoff. Pure, so every rule can be tested with a fixed clock. */
export function buildPlan(d: TripDetail, now: number, settings: ReminderSettings, facts: ReminderFacts): BuiltPlan {
  const tz = d.trip.timezone;
  const flight = d.bookings.find((b) => b.kind === "flight");
  const departure = (flight?.local_start ?? d.trip.start_date).slice(0, 10);
  const notify = settings.notify_time;
  const drafts: Draft[] = [];

  if (flight) {
    drafts.push({ key: "before-departure-3d", what: `${flight.title} departs in 3 days`, lead: "3 days before departure", local: `${addDays(departure, -3)}T${notify}` });
  }

  // The flight, and every booking, gets the day before. Bookings on the same day share one reminder.
  const byDay = new Map<string, string[]>();
  for (const b of d.bookings) {
    const day = b.local_start.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), b.title]);
  }
  for (const [day, titles] of byDay) {
    drafts.push({ key: `day-before:${day}`, what: `Tomorrow: ${titles.join(", ")}`, lead: "The day before", local: `${addDays(day, -1)}T${notify}` });
  }

  // Hour-level countdowns need an exact time, so a date-only booking never gets one. The flight has the
  // leave-home reminder instead, at a time only the person can choose.
  for (const b of d.bookings) {
    if (b.kind === "flight" || !b.local_start.includes("T")) continue;
    const at = localToUtc(b.local_start, tz) - TWO_HOURS_MS;
    drafts.push({ key: `two-hours:${b.booking_id}`, what: `${b.title} in 2 hours`, lead: "2 hours before", local: utcToLocal(at, tz) });
  }

  if (settings.leave_home_at && flight) {
    drafts.push({ key: "leave-home", what: `Time to leave for ${flight.title}`, lead: "At the time you chose", local: `${departure}T${settings.leave_home_at}` });
  }

  if (facts.unpaidShares.length > 0) {
    drafts.push({
      key: "unpaid-shares",
      what: `Pickup shares still unpaid: ${facts.unpaidShares.join(", ")}`,
      lead: "2 days before departure, until paid",
      local: `${addDays(departure, -2)}T${notify}`,
    });
  }

  const followingUp = facts.caseState === "submitted_by_user" || facts.caseState === "awaiting_merchant";
  if (settings.follow_up_at && followingUp) {
    drafts.push({ key: "follow-up", what: "Check for a merchant reply", lead: "At the time you chose", local: settings.follow_up_at });
  }

  const chosen = drafts.filter((x) => !settings.exclude.includes(x.key));
  const timed = chosen.map((x) => ({ ...x, at: localToUtc(x.local, tz) })).sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const past = timed.filter((x) => x.at <= now);
  const future = timed.filter((x) => x.at > now);

  // Reminders about an hour apart would only nag, so the earlier one carries both.
  const merged: typeof future = [];
  for (const x of future) {
    const last = merged[merged.length - 1];
    if (last && x.at - last.at <= MERGE_WITHIN_MS) {
      last.what = `${last.what}; ${x.what}`;
      last.lead = `${last.lead}; ${x.lead}`;
    } else {
      merged.push({ ...x });
    }
  }

  const items: ReminderItem[] = merged.map((x) => {
    const local = utcToLocal(x.at, tz);
    return {
      key: x.key,
      what: x.what,
      title: `${DEMO_LABEL}: ${x.what}`,
      description: REMINDER_DESCRIPTION,
      lead: x.lead,
      start_local: local,
      start_utc: new Date(x.at).toISOString(),
      timezone: tz,
      duration_minutes: EVENT_MINUTES,
      display_when: displayLocal(local),
      display_beijing: displayLocal(utcToLocal(x.at, BEIJING)),
    };
  });

  const notes = ["The sample has no refund or change deadline, so no deadline reminder is planned."];
  if (!settings.leave_home_at) notes.push("No leave-home reminder until you choose a time.");
  if (facts.unpaidShares.length > 0 && items.some((i) => i.what.includes("Pickup shares"))) {
    notes.push("The unpaid-shares reminder goes only to your own calendar, never to Leo or Ava, and stops once they are paid.");
  }
  if (past.length > 0) notes.push(`${past.length} ${past.length === 1 ? "reminder is" : "reminders are"} already in the past and skipped.`);

  return { items, pastKeys: past.map((x) => x.key), notes };
}

// ---- what was written -----------------------------------------------------------------------

export interface ReminderEventRow {
  reminder_key: string;
  state: "written" | "failed" | "removed";
  external_event_id: string | null;
  calendar_name: string | null;
  content_key: string | null;
  title: string;
  detail: string | null;
}

/** Same text and time means the existing entry is still right, so a retry leaves it alone */
export const contentKey = (item: Pick<ReminderItem, "title" | "start_utc">) => JSON.stringify([item.title, item.start_utc]);

export type ReminderWrite =
  | ({ op: "create" } & ReminderItem)
  | ({ op: "update"; external_event_id: string } & ReminderItem)
  | { op: "remove"; key: string; title: string; external_event_id: string };

/** Only touches entries CozyTrip's own plan created: every update and removal names a recorded receipt. */
export function writesFor(plan: BuiltPlan, events: ReminderEventRow[]): ReminderWrite[] {
  const byKey = new Map(events.map((e) => [e.reminder_key, e]));
  const writes: ReminderWrite[] = [];
  for (const item of plan.items) {
    const e = byKey.get(item.key);
    if (e?.state === "written" && e.external_event_id) {
      if (e.content_key !== contentKey(item)) writes.push({ op: "update", external_event_id: e.external_event_id, ...item });
    } else {
      writes.push({ op: "create", ...item });
    }
  }
  const current = new Set(plan.items.map((i) => i.key));
  for (const e of events) {
    if (e.state !== "written" || !e.external_event_id || current.has(e.reminder_key) || plan.pastKeys.includes(e.reminder_key)) continue;
    writes.push({ op: "remove", key: e.reminder_key, title: e.title, external_event_id: e.external_event_id });
  }
  return writes;
}

// ---- storage --------------------------------------------------------------------------------

/** Tools stay hidden until the schema-only migration has been applied to this database */
export async function reminderTablesExist(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('reminder_plans','reminder_events')")
    .first<{ n: number }>();
  return row?.n === 2;
}

export async function readSettings(db: D1Database, userId: string, tripId: string): Promise<ReminderSettings> {
  const row = await db
    .prepare("SELECT settings_json FROM reminder_plans WHERE trip_id=?1 AND user_id=?2")
    .bind(tripId, userId)
    .first<{ settings_json: string }>();
  return row ? { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings_json) as Partial<ReminderSettings>) } : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(db: D1Database, userId: string, tripId: string, settings: ReminderSettings): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reminder_plans(trip_id,user_id,settings_json,updated_at) VALUES(?1,?2,?3,?4)
       ON CONFLICT(trip_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at WHERE reminder_plans.user_id=excluded.user_id`,
    )
    .bind(tripId, userId, JSON.stringify(settings), new Date().toISOString())
    .run();
}

export async function readEvents(db: D1Database, userId: string, tripId: string): Promise<ReminderEventRow[]> {
  const { results } = await db
    .prepare("SELECT reminder_key,state,external_event_id,calendar_name,content_key,title,detail FROM reminder_events WHERE trip_id=?1 AND user_id=?2 ORDER BY reminder_key")
    .bind(tripId, userId)
    .all<ReminderEventRow>();
  return results;
}

export async function reminderFacts(db: D1Database, userId: string, tripId: string): Promise<ReminderFacts> {
  const [shares, progress] = await Promise.all([
    db
      .prepare(
        "SELECT m.name AS name FROM payments p JOIN participants m ON m.participant_id=p.participant_id WHERE p.user_id=?1 AND p.trip_id=?2 AND p.state='awaiting-payment' ORDER BY m.sort_order",
      )
      .bind(userId, tripId)
      .all<{ name: string }>(),
    db.prepare("SELECT state FROM case_progress WHERE user_id=?1 AND trip_id=?2 ORDER BY updated_at DESC LIMIT 1").bind(userId, tripId).first<{ state: string }>(),
  ]);
  return { unpaidShares: shares.results.map((s) => s.name), caseState: progress?.state ?? null };
}

/** True when something CozyTrip wrote no longer belongs, for example once a share is paid */
export async function hasStaleReminder(d: TripDetail, db: D1Database, userId: string, now = Date.now()): Promise<boolean> {
  if (!(await reminderTablesExist(db))) return false;
  const [settings, events, facts] = await Promise.all([
    readSettings(db, userId, d.trip.trip_id),
    readEvents(db, userId, d.trip.trip_id),
    reminderFacts(db, userId, d.trip.trip_id),
  ]);
  return writesFor(buildPlan(d, now, settings, facts), events).some((w) => w.op === "remove");
}

export interface ReminderSummary {
  written: number;
  failed: number;
}

export function summarize(events: ReminderEventRow[]): ReminderSummary {
  return { written: events.filter((e) => e.state === "written").length, failed: events.filter((e) => e.state === "failed").length };
}
