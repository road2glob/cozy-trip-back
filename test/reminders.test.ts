import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServerFactory } from "../src/mcp/server";
import { addDays, displayLocal, isLocalDateTime, localDateIn, localToUtc, shiftLocal, utcToLocal } from "../src/domain/dates";
import { DEFAULT_SETTINGS, buildPlan, reminderTablesExist } from "../src/domain/reminders";
import { SAMPLE_LEAD_DAYS, getTripDetail } from "../src/domain/trips";
import * as status from "../src/tools/getStatus";
import * as imports from "../src/tools/importOrders";
import * as detect from "../src/tools/detectImpact";
import * as quote from "../src/tools/quoteService";
import * as pay from "../src/tools/createServicePayment";
import * as verify from "../src/tools/verifyPayment";
import * as split from "../src/tools/quoteSplit";
import * as createSplit from "../src/tools/createSplitPayments";
import * as splitCheck from "../src/tools/splitStatus";
import * as updateCase from "../src/tools/updateCaseStatus";
import * as plan from "../src/tools/planReminders";
import * as record from "../src/tools/recordReminderResults";
import { getRun, getSettlement } from "../src/paymentService";
import { fixtureWrite } from "../stub/complete";
import { testEnv, toolCtx } from "./helpers/env";

vi.mock("agents/mcp/server", () => ({ getMcpAuthContext: () => ({ props: { userId: "usr_test", tokenId: "tok_test", requestId: "req_test" } }) }));

const sc = (r: any) => r.structuredContent as any;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const LABEL = "CozyTrip Demo / 样本行程";
/** Nov 1 2026, 13:00 in Los Angeles, after that day's clock change: the sample then starts on Nov 8. */
const CLOCK = Date.parse("2026-11-01T21:00:00Z");
const setClock = (at: number | string) => vi.setSystemTime(typeof at === "string" ? Date.parse(at) : at);

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: CLOCK }));
afterEach(() => vi.useRealTimers());

async function imported(ctx: any) {
  return sc(await imports.run(ctx, { mode: "sample" })).trip_id as string;
}
async function agreed(ctx: any, trip_id: string) {
  const preview = sc(await plan.run(ctx, { trip_id }));
  return plan.run(ctx, { trip_id, confirmation_code: preview.confirmation_code });
}
const events = (raw: any) => raw.prepare("SELECT reminder_key,state,external_event_id,detail FROM reminder_events ORDER BY reminder_key").all() as any[];
const created = (key: string, id = `evt_${key}`) => ({ key, outcome: "created" as const, external_event_id: id, calendar_name: "Personal" });

describe("trip-local date helpers", () => {
  it("keeps date precision and rolls over months and years", () => {
    expect(shiftLocal("2026-11-08", 7)).toBe("2026-11-15");
    expect(shiftLocal("2026-11-08T08:00", 54)).toBe("2027-01-01T08:00");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(displayLocal("2026-11-08T08:00")).toBe("Nov 8, 08:00");
    expect(displayLocal("2026-11-08")).toBe("Nov 8");
  });

  it("finds the right instant on both sides of a clock change", () => {
    expect(new Date(localToUtc("2026-03-08T01:30", "America/Los_Angeles")).toISOString()).toBe("2026-03-08T09:30:00.000Z");
    expect(new Date(localToUtc("2026-03-08T03:30", "America/Los_Angeles")).toISOString()).toBe("2026-03-08T10:30:00.000Z");
    expect(new Date(localToUtc("2026-11-05T09:00", "America/Los_Angeles")).toISOString()).toBe("2026-11-05T17:00:00.000Z");
    expect(utcToLocal(Date.parse("2026-11-05T17:00:00Z"), "Asia/Shanghai")).toBe("2026-11-06T01:00");
    expect(localDateIn(Date.parse("2026-11-02T05:00:00Z"), "America/Los_Angeles")).toBe("2026-11-01");
  });

  it("rejects impossible follow-up times", () => {
    expect(isLocalDateTime("2026-11-08T14:00")).toBe(true);
    expect(isLocalDateTime("2026-02-30T14:00")).toBe(false);
    expect(isLocalDateTime("2026-11-08T24:00")).toBe(false);
    expect(isLocalDateTime("2026-11-08")).toBe(false);
  });
});

describe("the sample is future-dated once, at first import", () => {
  it("starts seven days after the first import in the trip's own zone, keeping every booking's precision", async () => {
    const { env } = testEnv();
    const r = sc(await imports.run(toolCtx(env), { mode: "sample" }));
    expect(SAMPLE_LEAD_DAYS).toBe(7);
    expect([r.start_date, r.end_date]).toEqual(["2026-11-08", "2026-11-11"]);
    expect(r.bookings.map((b: any) => b.local_start)).toEqual(["2026-11-08T08:00", "2026-11-08", "2026-11-08", "2026-11-10T14:00"]);
  });

  it("uses the local date, not the UTC date, and crosses a year end", async () => {
    setClock("2026-12-29T07:00:00Z"); // still Dec 28 in Los Angeles
    const { env } = testEnv();
    const r = sc(await imports.run(toolCtx(env), { mode: "sample" }));
    expect([r.start_date, r.end_date]).toEqual(["2027-01-04", "2027-01-07"]);
    expect(r.bookings[3].local_start).toBe("2027-01-06T14:00");
  });

  it("never moves: re-reading, re-importing, paying or a later date all keep the stored dates", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const first = sc(await imports.run(ctx, { mode: "sample" }));
    const trip_id = first.trip_id;
    const preview = sc(await detect.run(ctx, { trip_id }));
    await detect.run(ctx, { trip_id, confirmation_code: preview.confirmation_code });
    const q = sc(await quote.run(ctx, { trip_id }));
    await pay.run(ctx, { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code });
    await verify.run(ctx, { trip_id, run_id: q.runId });

    setClock("2026-11-20T00:00:00Z");
    const again = sc(await imports.run(ctx, { mode: "sample" }));
    expect(again.replay).toBe(true);
    expect([again.start_date, again.end_date]).toEqual([first.start_date, first.end_date]);
    expect(again.bookings.map((b: any) => b.local_start)).toEqual(first.bookings.map((b: any) => b.local_start));
    expect(sc(await status.run(ctx, { trip_id })).trips[0].start_date).toBe(first.start_date);
  });

  it("a trip imported before this change keeps its old dates", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    raw.prepare("UPDATE trips SET start_date='2026-11-03',end_date='2026-11-06'").run();
    const again = sc(await imports.run(ctx, { mode: "sample" }));
    expect(again.trip_id).toBe(trip_id);
    expect(again.start_date).toBe("2026-11-03");
  });

  it("two users importing on different days get their own dates", async () => {
    const { env } = testEnv();
    const a = sc(await imports.run(toolCtx(env, "usr_a"), { mode: "sample" }));
    setClock(CLOCK + 3 * 86_400_000);
    const b = sc(await imports.run(toolCtx(env, "usr_b"), { mode: "sample" }));
    expect(a.start_date).toBe("2026-11-08");
    expect(b.start_date).toBe("2026-11-11");
  });
});

describe("what the plan contains", () => {
  it("is labeled Demo, in the trip's zone with Beijing beside it, and merges same-day bookings", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await plan.run(ctx, { trip_id });
    const p = sc(r);
    expect(p.reminders.map((i: any) => i.key)).toEqual([
      "before-departure-3d",
      "day-before:2026-11-08",
      "day-before:2026-11-10",
      expect.stringMatching(/^two-hours:/),
    ]);
    expect(p.reminders.every((i: any) => i.title.startsWith(`${LABEL}: `))).toBe(true);
    expect(p.label).toBe(LABEL);
    expect(p.reality).toBe("fictional_sample");
    expect(p.reminders[0]).toMatchObject({
      start_local: "2026-11-05T09:00",
      start_utc: "2026-11-05T17:00:00.000Z",
      timezone: "America/Los_Angeles",
      display_when: "Nov 5, 09:00",
      display_beijing: "Nov 6, 01:00",
    });
    expect(p.reminders[1].what).toBe("Tomorrow: Sample Air 210 SEA to SFO, Sample Bay Hotel, 3 nights, Sample Transfer Co airport pickup");
    expect(p.reminders[3]).toMatchObject({ what: "Sample Bay Cruise in 2 hours", start_local: "2026-11-10T12:00" });
    expect(text(r)).toContain(LABEL);
    expect(text(r)).toContain("Beijing Nov 6, 01:00");
    expect(p.reminders.every((i: any) => i.description.includes("Fictional") && /AI chat/.test(i.description))).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/one-click|monitor/i);
  });

  it("gives date-only bookings no hour-level countdown, and the flight none without the person's time", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await plan.run(ctx, { trip_id }));
    const hourly = p.reminders.filter((i: any) => i.key.startsWith("two-hours"));
    expect(hourly).toHaveLength(1);
    expect(hourly[0].what).toContain("Cruise");
    expect(p.reminders.some((i: any) => i.key === "leave-home")).toBe(false);
    expect(p.notes).toContain("No leave-home reminder until you choose a time.");
    expect(p.notes).toContain("The sample has no refund or change deadline, so no deadline reminder is planned.");
  });

  it("is only a plan: nothing recorded, no writes returned, and it says so", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await plan.run(ctx, { trip_id });
    expect(events(raw)).toEqual([]);
    expect(sc(r)).not.toHaveProperty("writes");
    expect(sc(r).confirmed).toBe(false);
    expect(sc(r).reminders.every((i: any) => i.state === "planned")).toBe(true);
    expect(sc(r).guidance.fact).toContain("It is only a plan: nothing is in any calendar.");
    const step = sc(r).guidance.next_steps[0];
    expect(step).toMatchObject({ tool: "plan_reminders", needs_confirmation: true, card_action: "Add to my calendar" });
    expect(step.card_message).toContain("I agree to this CozyTrip demo reminder plan");
    expect(step.when).toContain("If it has none, keep the plan and say the reminders are not set");
  });

  it("can be adjusted, and keeps the adjustment", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const changed = sc(await plan.run(ctx, { trip_id, notify_time: "08:00", leave_home_at: "05:30", exclude: ["before-departure-3d"], calendar_name: "Personal" }));
    expect(changed.reminders.map((i: any) => i.key)).not.toContain("before-departure-3d");
    expect(changed.reminders.find((i: any) => i.key === "leave-home")).toMatchObject({ start_local: "2026-11-08T05:30", lead: "At the time you chose" });
    expect(changed.reminders[0].start_local).toBe("2026-11-07T08:00");
    expect(changed.calendar_name).toBe("Personal");
    const later = sc(await plan.run(ctx, { trip_id }));
    expect(later.reminders.map((i: any) => i.start_local)).toEqual(changed.reminders.map((i: any) => i.start_local));
    const cleared = sc(await plan.run(ctx, { trip_id, leave_home_at: null, exclude: [] }));
    expect(cleared.reminders.map((i: any) => i.key)).toContain("before-departure-3d");
    expect(cleared.reminders.map((i: any) => i.key)).not.toContain("leave-home");
  });

  it("refuses an impossible time and changes nothing", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await plan.run(ctx, { trip_id, follow_up_at: "2026-02-30T10:00" });
    expect(sc(r).error.code).toBe("invalid_follow_up");
    expect(plan.inputSchema.safeParse({ trip_id, notify_time: "25:00" }).success).toBe(false);
  });

  it("skips what is already past and says how many", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    setClock("2026-11-06T12:00:00Z");
    const p = sc(await plan.run(ctx, { trip_id }));
    expect(p.reminders.map((i: any) => i.key)).not.toContain("before-departure-3d");
    expect(p.notes).toContain("1 reminder is already in the past and skipped.");
    expect(p.reminders.every((i: any) => Date.parse(i.start_utc) > Date.now())).toBe(true);
  });

  it("an old trip with nothing left says so and asks for nothing", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    setClock("2026-12-20T00:00:00Z");
    const r = await plan.run(ctx, { trip_id });
    expect(sc(r).reminders).toEqual([]);
    expect(sc(r)).not.toHaveProperty("confirmation_code");
    expect(sc(r).guidance.next_steps).toEqual([]);
    expect(sc(r).guidance.fact).toContain("reminder times have passed");
  });

  it("merges reminders within an hour of each other", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const d = (await getTripDetail(env.DB, ctx.userId, trip_id))!;
    const built = buildPlan(d, CLOCK, { ...DEFAULT_SETTINGS, follow_up_at: "2026-11-10T12:30" }, { unpaidShares: [], caseState: "awaiting_merchant" });
    const merged = built.items.find((i) => i.start_local === "2026-11-10T12:00")!;
    expect(merged.what).toBe("Sample Bay Cruise in 2 hours; Check for a merchant reply");
    expect(built.items.find((i) => i.key === "follow-up")).toBeUndefined();
  });

  it("a follow-up reminder needs an open case and the person's chosen time", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const d = (await getTripDetail(env.DB, ctx.userId, trip_id))!;
    const keys = (settings: object, caseState: string | null) => buildPlan(d, CLOCK, { ...DEFAULT_SETTINGS, ...settings }, { unpaidShares: [], caseState }).items.map((i) => i.key);
    expect(keys({}, "awaiting_merchant")).not.toContain("follow-up");
    expect(keys({ follow_up_at: "2026-11-09T18:00" }, "prepared")).not.toContain("follow-up");
    expect(keys({ follow_up_at: "2026-11-09T18:00" }, "awaiting_merchant")).toContain("follow-up");
    expect(keys({ follow_up_at: "2026-11-09T18:00" }, "merchant_responded")).not.toContain("follow-up");
  });
});

describe("agreeing to the plan", () => {
  it("a wrong code, another user's code, or a changed plan writes nothing", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await plan.run(ctx, { trip_id }));
    expect(sc(await plan.run(ctx, { trip_id, confirmation_code: "bad" })).error.code).toBe("invalid_confirmation_code");
    expect(sc(await plan.run(toolCtx(env, "usr_other"), { trip_id, confirmation_code: p.confirmation_code })).error.code).toBe("not_found");
    expect(sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code, notify_time: "07:00" })).error.code).toBe("invalid_confirmation_code");
    await plan.run(ctx, { trip_id, notify_time: "07:00" });
    expect(sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code })).error.code).toBe("invalid_confirmation_code");
    expect(raw.prepare("SELECT confirmed_at FROM reminder_plans").get()).toEqual({ confirmed_at: null });
  });

  it("an agreement expires", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await plan.run(ctx, { trip_id }));
    setClock(CLOCK + 31 * 60_000);
    expect(sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code })).error.code).toBe("invalid_confirmation_code");
  });

  it("returns everything the host needs to write, in text too, without claiming anything is set", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const r = await agreed(ctx, trip_id);
    const a = sc(r);
    expect(a.confirmed).toBe(true);
    expect(a.writes).toHaveLength(4);
    expect(a.writes.every((w: any) => w.op === "create" && w.title.startsWith(LABEL))).toBe(true);
    expect(a.guidance.fact).toContain("Nothing is in a calendar yet.");
    expect(a.guidance.next_steps[0]).toMatchObject({ tool: "record_reminder_results", args: { trip_id } });
    expect(text(r)).toContain(`create "${LABEL}: Sample Bay Cruise in 2 hours" at 2026-11-10T12:00 America/Los_Angeles, 15 min`);
    expect(text(r)).toContain("If this host has no calendar tool, make no report and tell the person the reminders are not set");
    expect(events(raw)).toEqual([]);
  });
});

describe("recording what the calendar tool did", () => {
  it("refuses any result before the person agreed", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    await plan.run(ctx, { trip_id });
    const r = await record.run(ctx, { trip_id, results: [created("before-departure-3d")] });
    expect(sc(r).error.code).toBe("confirmation_required");
    expect(events(raw)).toEqual([]);
  });

  it("needs a receipt to count as set, and only accepts reminders that were agreed", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const approved = sc(await agreed(ctx, trip_id));
    const r = await record.run(ctx, { plan_id: approved.plan_id,
      trip_id,
      results: [
        { key: "before-departure-3d", outcome: "created" },
        { key: "not-a-reminder", outcome: "created", external_event_id: "evt_x" },
      ],
    });
    expect(sc(r).rejected).toEqual([
      { key: "before-departure-3d", reason: "receipt_required" },
      { key: "not-a-reminder", reason: "not_in_agreed_plan" },
    ]);
    expect(sc(r).summary.set).toBe(0);
    expect(events(raw)).toEqual([]);
    expect(sc(r).guidance.next_steps[0].tool).toBe("plan_reminders");
  });

  it("reports each result as it was, including a partial failure, and only what is set counts", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const approved = sc(await agreed(ctx, trip_id));
    const keys = approved.writes.map((w: any) => w.key);
    const r = await record.run(ctx, { plan_id: approved.plan_id,
      trip_id,
      results: [created(keys[0]), created(keys[1]), { key: keys[2], outcome: "failed", detail: "Calendar is read-only" }],
    });
    const s = sc(r);
    expect(s.provenance).toBe("host-reported");
    expect(s.summary).toEqual({ set: 2, removed: 0, failed: 1, rejected: 0 });
    expect(text(r)).toContain("2 set, 1 failed and not set");
    expect(text(r)).toContain("Calendar is read-only");
    expect(s.guidance.fact).toContain("Only what it reported as set is actually set.");
    expect(s.guidance.next_steps[0]).toMatchObject({ tool: "plan_reminders", card_action: "See reminder plan" });
    expect(events(raw).map((e) => e.state).sort()).toEqual(["failed", "written", "written"]);

    const again = sc(await plan.run(ctx, { trip_id }));
    expect(again.reminders.map((i: any) => i.state)).toEqual(["written", "written", "failed", "planned"]);
    expect(again.guidance.fact).toContain("2 already in the calendar, 2 not set");
    const second = sc(await plan.run(ctx, { trip_id, confirmation_code: again.confirmation_code }));
    expect(second.writes.map((w: any) => w.key)).toEqual([keys[2], keys[3]]);
    expect(second.writes.every((w: any) => w.op === "create")).toBe(true);
  });

  it("an outcome has to match the write that was agreed", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const approved = sc(await agreed(ctx, trip_id));
    const keys = approved.writes.map((w: any) => w.key);
    const r = await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: [{ key: keys[0], outcome: "removed" }, { key: keys[1], outcome: "updated", external_event_id: "evt_x" }] });
    expect(sc(r).rejected.map((x: any) => x.reason)).toEqual(["outcome_does_not_match_write", "outcome_does_not_match_write"]);
    expect(events(raw)).toEqual([]);
  });

  it("a recorded receipt is never lost: a later failure or a second ID leaves it in place, and the agent is told about the duplicate", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const approved = sc(await agreed(ctx, trip_id));
    const keys = approved.writes.map((w: any) => w.key);
    await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: [created(keys[0], "evt_first")] });

    await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: [{ key: keys[0], outcome: "failed", detail: "Timed out on retry" }] });
    expect(events(raw).find((e) => e.reminder_key === keys[0])).toMatchObject({ state: "written", external_event_id: "evt_first" });

    const second = await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: [created(keys[0], "evt_second")] });
    expect(sc(second).rejected).toEqual([{ key: keys[0], reason: "already_recorded", external_event_id: "evt_first" }]);
    expect(text(second)).toContain("If your calendar tool just made another entry, remove that one.");
    expect(events(raw).find((e) => e.reminder_key === keys[0])).toMatchObject({ external_event_id: "evt_first" });

    expect(sc(await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: [created(keys[0], "evt_first")] })).rejected).toEqual([]);
  });

  it("a retry updates, never duplicates: one row per reminder, and an unchanged entry is left alone", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const approved = sc(await agreed(ctx, trip_id));
    const keys = approved.writes.map((w: any) => w.key);
    await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: keys.map((k: string) => created(k)) });
    await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: keys.map((k: string) => created(k)) });
    expect(events(raw)).toHaveLength(4);

    const nothing = await plan.run(ctx, { trip_id });
    expect(sc(nothing).reminders.every((i: any) => i.state === "written")).toBe(true);
    expect(sc(nothing).writes).toEqual([]);
    expect(sc(nothing)).not.toHaveProperty("confirmation_code");
    expect(sc(nothing).guidance.next_steps).toEqual([]);
    expect(sc(nothing).guidance.end).toBe("No calendar action is needed.");
  });

  it("changing a time updates the existing entry by its recorded ID", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const approved = sc(await agreed(ctx, trip_id));
    const keys = approved.writes.map((w: any) => w.key);
    await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: keys.map((k: string) => created(k)) });

    const moved = sc(await plan.run(ctx, { trip_id, notify_time: "08:00" }));
    expect(moved.reminders.find((i: any) => i.key === keys[0]).state).toBe("needs_update");
    const a = sc(await plan.run(ctx, { trip_id, confirmation_code: moved.confirmation_code }));
    const update = a.writes.find((w: any) => w.key === keys[0]);
    expect(update).toMatchObject({ op: "update", external_event_id: `evt_${keys[0]}`, start_local: "2026-11-05T08:00" });
    expect(a.writes.find((w: any) => w.key.startsWith("two-hours"))).toBeUndefined();

    const failed = await record.run(ctx, { plan_id: a.plan_id, trip_id, results: [{ key: keys[0], outcome: "failed", detail: "Network" }] });
    expect(sc(failed).reminder_results[0].label).toContain("Update failed; original reminder is still scheduled");
    expect(events(raw).find((e) => e.reminder_key === keys[0])).toMatchObject({ state: "written", external_event_id: `evt_${keys[0]}`, detail: "Network" });
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: [{ key: keys[0], outcome: "updated", external_event_id: `evt_${keys[0]}` }] });
    const settled = sc(await plan.run(ctx, { trip_id }));
    expect(settled.reminders.find((i: any) => i.key === keys[0]).state).toBe("written");
  });

  it("only the approved revision can record receipts, even when the old write has the same key", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const old = sc(await agreed(ctx, trip_id));
    const preview = sc(await plan.run(ctx, { trip_id, notify_time: "10:00" }));
    const confirmation = { trip_id, confirmation_code: preview.confirmation_code };
    const current = sc(await plan.run(ctx, confirmation));
    expect(sc(await plan.run(ctx, confirmation)).plan_id).toBe(current.plan_id);
    expect(current.plan_id).not.toBe(old.plan_id);
    const results = [created(old.writes[0].key)];
    for (const plan_id of [old.plan_id, undefined]) {
      expect(sc(await record.run(ctx, { trip_id, plan_id, results })).error.code).toBe("stale_reminder_plan");
    }
    expect(events(raw)).toHaveLength(0);
    expect(sc(await record.run(ctx, { trip_id, plan_id: current.plan_id, results })).summary.set).toBe(1);
  });

  it("moves only acknowledged entries to the destination and keeps an old event when removal fails", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const original = sc(await agreed(ctx, trip_id));
    const keys: string[] = original.writes.map((w: any) => w.key);
    await record.run(ctx, { trip_id, plan_id: original.plan_id, results: keys.map((k) => created(k)) });
    const preview = sc(await plan.run(ctx, { trip_id, calendar_name: "Travel" }));
    expect(preview.removals).toHaveLength(keys.length);
    expect(events(raw).every((e) => e.state === "written")).toBe(true);
    const move = sc(await plan.run(ctx, { trip_id, confirmation_code: preview.confirmation_code }));
    expect(move.writes.every((w: any) => w.op === "remove" && w.calendar_name === "Personal" && w.move_to === "Travel")).toBe(true);
    const receipt = sc(await record.run(ctx, { trip_id, plan_id: move.plan_id, results: keys.map((key, i) => ({ key, outcome: i === 0 ? "failed" : "removed" })) }));
    expect(receipt.guidance.fact).toContain("original reminders remain scheduled");
    expect(receipt.reminder_results[0].label).toContain("Removal failed");
    expect(receipt.guidance.next_steps[0].card_action).toBe("Continue calendar move");
    expect(events(raw).find((r) => r.reminder_key === keys[0])?.external_event_id).toBe("evt_" + keys[0]);
    const retry = sc(await agreed(ctx, trip_id));
    expect(retry.writes[0]).toMatchObject({ key: keys[0], op: "remove", calendar_name: "Personal" });
    expect(retry.writes.slice(1).every((w: any) => w.op === "create" && w.calendar_name === "Travel")).toBe(true);
    await record.run(ctx, { trip_id, plan_id: retry.plan_id, results: keys.map((key, i) => i === 0 ? { key, outcome: "removed" } : { key, outcome: "created", external_event_id: "travel_" + key, calendar_name: "Travel" }) });
    const last = sc(await agreed(ctx, trip_id));
    expect(last.writes).toHaveLength(1);
    expect(last.writes[0]).toMatchObject({ op: "create", calendar_name: "Travel", key: keys[0] });
    await record.run(ctx, { trip_id, plan_id: last.plan_id, results: [{ key: keys[0], outcome: "created", external_event_id: "travel_first" }] });
    expect(sc(await plan.run(ctx, { trip_id })).writes).toEqual([]);
    expect(raw.prepare("SELECT DISTINCT calendar_name FROM reminder_events").all()).toEqual([{ calendar_name: "Travel" }]);
  });

  it("another user cannot record against this trip", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    await agreed(ctx, trip_id);
    expect(sc(await record.run(toolCtx(env, "usr_other"), { trip_id, results: [created("before-departure-3d")] })).error.code).toBe("not_found");
  });

  it("get_status tells the true position, and the plan stays offered", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const before = await status.run(ctx, { trip_id });
    expect(sc(before).reminders).toEqual({ written: 0, failed: 0 });
    expect(sc(before).guidance.fact).not.toMatch(/in the calendar/);
    expect(sc(before).guidance.next_steps[0]).toMatchObject({ tool: "plan_reminders", card_action: "See reminder plan" });

    const approved = sc(await agreed(ctx, trip_id));
    const keys = approved.writes.map((w: any) => w.key);
    await record.run(ctx, { plan_id: approved.plan_id, trip_id, results: [created(keys[0]), { key: keys[1], outcome: "failed" }] });
    const after = await status.run(ctx, { trip_id });
    expect(sc(after).reminders).toEqual({ written: 1, failed: 1 });
    expect(text(after)).toContain("1 Demo reminders are in the calendar");
    expect(text(after)).toContain("1 reminders failed and are not set.");
  });
});

describe("reminders stop when the reason is gone", () => {
  async function splitOrders(ctx: any, trip_id: string) {
    const q = sc(await split.run(ctx, { trip_id }));
    return sc(await createSplit.run(ctx, { trip_id, confirmation_code: q.confirmation_code })).payments as any[];
  }
  async function capture(ctx: any, paymentId: string) {
    const order = await getSettlement(ctx.env, paymentId);
    order.state = "captured";
    order.paypalCaptureId = "FAKE-" + paymentId;
    await fixtureWrite(ctx.env.DB, "settlement:" + paymentId, order);
  }

  it("an unpaid-shares reminder names who is unpaid, goes only to the current user, and goes away once paid", async () => {
    const { env, raw } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const [leo, ava] = await splitOrders(ctx, trip_id);

    const p = sc(await plan.run(ctx, { trip_id }));
    const item = p.reminders.find((i: any) => i.key === "unpaid-shares");
    expect(item).toMatchObject({ what: "Pickup shares still unpaid: Leo, Ava", start_local: "2026-11-06T09:00" });
    expect(p.notes.join(" ")).toContain("only to your own calendar, never to Leo or Ava");

    const a = sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code }));
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: a.writes.map((w: any) => created(w.key)) });

    // One paid: the entry is still right to have, but its text changes, so it is an update.
    await capture(ctx, leo.payment_id);
    const one = await splitCheck.run(ctx, { trip_id });
    expect(sc(one).guidance.next_steps[0].tool).toBe("split_status");
    const changed = sc(await plan.run(ctx, { trip_id }));
    expect(changed.reminders.find((i: any) => i.key === "unpaid-shares")).toMatchObject({ what: "Pickup shares still unpaid: Ava", state: "needs_update" });

    // All paid: split_status says the calendar entry no longer applies.
    await capture(ctx, ava.payment_id);
    const all = await splitCheck.run(ctx, { trip_id });
    expect(sc(all).guidance.next_steps).toEqual([expect.objectContaining({ tool: "plan_reminders", args: { trip_id } })]);
    expect(sc(all).guidance.end).toBeNull();
    expect(sc(all).guidance.fact).toContain("no payment entry remains");

    const stop = sc(await plan.run(ctx, { trip_id }));
    expect(stop.reminders.map((i: any) => i.key)).not.toContain("unpaid-shares");
    expect(stop.removals.map((r: any) => r.key)).toEqual(["unpaid-shares"]);
    const b = sc(await plan.run(ctx, { trip_id, confirmation_code: stop.confirmation_code }));
    expect(b.writes).toEqual([expect.objectContaining({ op: "remove", key: "unpaid-shares", external_event_id: "evt_unpaid-shares" })]);
    const removed = await record.run(ctx, { plan_id: b.plan_id, trip_id, results: [{ key: "unpaid-shares", outcome: "removed" }] });
    expect(sc(removed).summary.removed).toBe(1);
    expect(events(raw).find((e) => e.reminder_key === "unpaid-shares")).toMatchObject({ state: "removed", external_event_id: null });
    expect(sc(await splitCheck.run(ctx, { trip_id })).guidance.next_steps).toEqual([]);
    expect(sc(await plan.run(ctx, { trip_id })).removals).toEqual([]);
  });

  it("no unpaid shares means no reminder about them", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    expect(sc(await plan.run(ctx, { trip_id })).reminders.map((i: any) => i.key)).not.toContain("unpaid-shares");
  });

  it("a merchant reply ends the follow-up reminder", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const preview = sc(await detect.run(ctx, { trip_id }));
    await detect.run(ctx, { trip_id, confirmation_code: preview.confirmation_code });
    const q = sc(await quote.run(ctx, { trip_id }));
    await pay.run(ctx, { trip_id, run_id: q.runId, confirmation_code: q.confirmation_code });
    const run = await getRun(env, q.runId);
    run.state = "running";
    await fixtureWrite(env.DB, q.runId, { run });
    await verify.run(ctx, { trip_id, run_id: q.runId });
    for (const s of ["submitted_by_user", "awaiting_merchant"] as const) {
      const c = sc(await updateCase.run(ctx, { trip_id, run_id: q.runId, status: s }));
      await updateCase.run(ctx, c.guidance.next_steps[0].args);
    }
    const p = sc(await plan.run(ctx, { trip_id, follow_up_at: "2026-11-09T18:00" }));
    expect(p.reminders.map((i: any) => i.key)).toContain("follow-up");
    const a = sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code }));
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: a.writes.map((w: any) => created(w.key)) });

    const c = sc(await updateCase.run(ctx, { trip_id, run_id: q.runId, status: "merchant_responded", note: "They replied" }));
    const done = sc(await updateCase.run(ctx, c.guidance.next_steps[0].args));
    expect(done.guidance.next_steps).toEqual([expect.objectContaining({ tool: "plan_reminders" })]);
    // A retried report, after a lost response, still raises it.
    const retried = sc(await updateCase.run(ctx, { trip_id, run_id: q.runId, status: "merchant_responded", note: "They replied" }));
    expect(retried.replay).toBe(true);
    expect(retried.guidance.next_steps).toEqual([expect.objectContaining({ tool: "plan_reminders" })]);
    expect(sc(await plan.run(ctx, { trip_id })).removals.map((r: any) => r.key)).toEqual(["follow-up"]);
  });

  it("an entry whose time has passed is left alone rather than removed", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const a = sc(await agreed(ctx, trip_id));
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: a.writes.map((w: any) => created(w.key)) });
    setClock("2026-11-06T12:00:00Z");
    const later = sc(await plan.run(ctx, { trip_id }));
    expect(later.removals).toEqual([]);
    expect(later.writes).toEqual([]);
  });
});

describe("reminders follow the trip", () => {
  it("a recorded cancellation drops reminders for the affected bookings and raises what is already in the calendar", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const first = sc(await agreed(ctx, trip_id));
    await record.run(ctx, { plan_id: first.plan_id, trip_id, results: first.writes.map((w: any) => created(w.key)) });

    const preview = sc(await detect.run(ctx, { trip_id }));
    const confirmed = sc(await detect.run(ctx, { trip_id, confirmation_code: preview.confirmation_code }));
    expect(confirmed.guidance.next_steps.map((s: any) => s.tool)).toContain("plan_reminders");

    const after = sc(await plan.run(ctx, { trip_id }));
    const whats = after.reminders.map((i: any) => i.what).join(" | ");
    expect(whats).not.toContain("Sample Air 210");
    expect(whats).not.toContain("Sample Transfer Co");
    expect(whats).toContain("Sample Bay Hotel");
    expect(whats).toContain("Sample Bay Cruise");
    expect(after.notes).toContain("A simulated cancellation is recorded, so nothing is planned for the affected bookings.");
    expect(after.removals.map((r: any) => r.key)).toContain("before-departure-3d");
    expect(after.guidance.next_steps[0].card_action).toBe("Update my calendar");
  });

  it("a leave-home time moved into the past removes the entry still waiting to fire", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await plan.run(ctx, { trip_id, leave_home_at: "05:30" }));
    const a = sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code }));
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: a.writes.map((w: any) => created(w.key)) });
    setClock("2026-11-08T14:00:00Z"); // 06:00 on departure morning in Los Angeles
    expect(sc(await plan.run(ctx, { trip_id })).removals).toEqual([]);
    setClock("2026-11-08T12:00:00Z"); // 04:00: the 05:30 entry is still ahead
    const moved = sc(await plan.run(ctx, { trip_id, leave_home_at: "03:00" }));
    expect(moved.removals.map((r: any) => r.key)).toEqual(["leave-home"]);
  });

  it("when only a removal is left, the button and the message say removal", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const p = sc(await plan.run(ctx, { trip_id, leave_home_at: "05:30" }));
    const a = sc(await plan.run(ctx, { trip_id, confirmation_code: p.confirmation_code }));
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: a.writes.map((w: any) => created(w.key)) });
    const r = sc(await plan.run(ctx, { trip_id, leave_home_at: null }));
    expect(r.guidance.next_steps[0]).toMatchObject({ card_action: "Remove from my calendar" });
    expect(r.guidance.next_steps[0].card_message).toContain("remove this CozyTrip demo reminder");
    expect(r.guidance.fact).toContain("no longer applies");
  });

  it("a text that changes in the calendar is raised while shares are still unpaid", async () => {
    const { env } = testEnv();
    const ctx = toolCtx(env);
    const trip_id = await imported(ctx);
    const q = sc(await split.run(ctx, { trip_id }));
    const [leo] = sc(await createSplit.run(ctx, { trip_id, confirmation_code: q.confirmation_code })).payments;
    const a = sc(await agreed(ctx, trip_id));
    await record.run(ctx, { plan_id: a.plan_id, trip_id, results: a.writes.map((w: any) => created(w.key)) });
    const order = await getSettlement(env, leo.payment_id);
    order.state = "captured";
    order.paypalCaptureId = "FAKE";
    await fixtureWrite(env.DB, "settlement:" + leo.payment_id, order);
    const r = sc(await splitCheck.run(ctx, { trip_id }));
    expect(r.guidance.next_steps.map((s: any) => s.tool)).toEqual(["split_status", "plan_reminders"]);
  });
});

describe("before the migration is applied", () => {
  it("the tools are hidden and everything else still works", async () => {
    const { env, raw } = testEnv();
    raw.exec("DROP TABLE reminder_events; DROP TABLE reminder_plans;");
    expect(await reminderTablesExist(env.DB)).toBe(false);
    const server = createServerFactory(env, false, await reminderTablesExist(env.DB))();
    const client = new Client({ name: "before-migration", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("plan_reminders");
      expect(names).not.toContain("record_reminder_results");
    } finally {
      await client.close();
      await server.close();
    }
    const ctx = toolCtx(env);
    const imp = await imports.run(ctx, { mode: "sample" });
    expect(JSON.stringify(sc(imp).guidance)).not.toContain("plan_reminders");
    expect(sc(imp).guidance.next_steps[0].card_action).toBe("Preview a simulated issue");
    const s = await status.run(ctx, { trip_id: sc(imp).trip_id });
    expect(s.isError).toBeUndefined();
    expect(sc(s)).not.toHaveProperty("reminders");
    expect(JSON.stringify(sc(s).guidance)).not.toContain("plan_reminders");
  });

  it("once applied, a server lists both tools with the card", async () => {
    const { env } = testEnv();
    const server = createServerFactory(env, false, await reminderTablesExist(env.DB))();
    const client = new Client({ name: "after-migration", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const { tools } = await client.listTools();
      for (const name of ["plan_reminders", "record_reminder_results"]) expect(tools.find((t) => t.name === name)?._meta?.ui).toBeDefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
