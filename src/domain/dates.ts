// Trip-local dates and times. A trip stores wall-clock strings ("2026-11-08", "2026-11-08T08:00") and an
// IANA time zone; everything here keeps that precision, so a date-only booking never gains a time.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function dateFromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateFromDayNumber(dayNumber(date) + days);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Moves a date or date-time by whole days and leaves any time of day alone */
export function shiftLocal(local: string, days: number): string {
  return addDays(local.slice(0, 10), days) + local.slice(10);
}

function zoneParts(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDateIn(at: number, timeZone: string): string {
  const p = zoneParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DDTHH:MM" as it reads in that zone */
export function utcToLocal(at: number, timeZone: string): string {
  const p = zoneParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function offsetMs(at: number, timeZone: string): number {
  const p = zoneParts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time happens in a zone. The second pass settles times next to a clock change. */
export function localToUtc(local: string, timeZone: string): number {
  const [date, time] = local.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

/** "2026-11-08T08:00" -> "Nov 8, 08:00"; "2026-11-08" -> "Nov 8" */
export function displayLocal(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(local);
  if (!m) return local;
  const day = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
  return m[4] ? `${day}, ${m[4]}:${m[5]}` : day;
}

export function isLocalDateTime(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59) return false;
  return dateFromDayNumber(dayNumber(value.slice(0, 10))) === value.slice(0, 10);
}
