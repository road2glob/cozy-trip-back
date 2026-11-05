import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { localCode, validCode } from "../domain/operations";
import { isLocalDateTime } from "../domain/dates";
import {
  DEFAULT_SETTINGS,
  DEMO_LABEL,
  buildPlan,
  readEvents,
  readSettings,
  reminderFacts,
  saveSettings,
  writesFor,
  type ReminderSettings,
  type ReminderWrite,
} from "../domain/reminders";
import { fail, type ToolContext } from "./common";
import { guided, nextStep, type Guidance } from "./guidance";

export const name = "plan_reminders";
export const description =
  "Preview a clearly labeled Demo reminder plan for the fictional sample, or confirm it. Without confirmation_code nothing is scheduled. CozyTrip cannot write to a calendar: once the person confirms, call this host's own calendar tool for each returned write, then report with record_reminder_results. If this host has no calendar tool, keep the plan and say the reminders are not set.";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  notify_time: z.string().regex(TIME).optional().describe("Trip-local HH:MM for reminders about a date. Default 09:00."),
  leave_home_at: z.string().regex(TIME).nullable().optional().describe("Trip-local HH:MM on departure day. Only a time the person chose; null clears it."),
  follow_up_at: z.string().max(16).nullable().optional().describe("Trip-local YYYY-MM-DDTHH:MM the merchant promised or the person chose; null clears it"),
  exclude: z.array(z.string().max(120)).max(20).optional().describe("Reminder keys the person does not want. Replaces the earlier list."),
  calendar_name: z.string().max(120).nullable().optional().describe("Which calendar the person chose, as this host names it"),
  confirmation_code: z.string().optional().describe("From the preview, once the person agrees to the whole plan"),
});
export const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const stateLabel = (events: Awaited<ReturnType<typeof readEvents>>, key: string, inWrites: boolean) => {
  const e = events.find((x) => x.reminder_key === key);
  if (e?.state === "written") return inWrites ? "needs_update" : "written";
  return e?.state === "failed" ? "failed" : "planned";
};

const writeLine = (w: ReminderWrite) =>
  w.op === "remove" ? `- remove "${w.title}" (event ${w.external_event_id})` : `- ${w.op} "${w.title}" at ${w.start_local} ${w.timezone}, ${w.duration_minutes} min${w.op === "update" ? ` (event ${w.external_event_id})` : ""}. Description: ${w.description}`;

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const { env, userId } = ctx;
  const d = await getTripDetail(env.DB, userId, args.trip_id);
  if (!d) return fail("not_found", "Import the sample trip before planning reminders.");
  if (args.follow_up_at && !isLocalDateTime(args.follow_up_at)) return fail("invalid_follow_up", "follow_up_at must be a trip-local YYYY-MM-DDTHH:MM. Nothing changed.");

  const saved = await readSettings(env.DB, userId, args.trip_id);
  const settings: ReminderSettings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    ...(args.notify_time !== undefined ? { notify_time: args.notify_time } : {}),
    ...(args.leave_home_at !== undefined ? { leave_home_at: args.leave_home_at } : {}),
    ...(args.follow_up_at !== undefined ? { follow_up_at: args.follow_up_at } : {}),
    ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
    ...(args.calendar_name !== undefined ? { calendar_name: args.calendar_name } : {}),
  };
  const changed = JSON.stringify(settings) !== JSON.stringify(saved);
  if (changed && args.confirmation_code) return fail("invalid_confirmation_code", "Confirm the plan with no other changes. Nothing was recorded; show the current plan again.");

  const [events, facts] = await Promise.all([readEvents(env.DB, userId, args.trip_id), reminderFacts(env.DB, userId, args.trip_id)]);
  const now = Date.now();
  const plan = buildPlan(d, now, settings, facts);
  const writes = writesFor(plan, events, now);
  // Bound to exactly what the person saw, so a plan that changes afterwards needs a new agreement.
  const target = JSON.stringify([settings.calendar_name, writes.map((w) => (w.op === "remove" ? [w.op, w.key] : [w.op, w.key, w.title, w.start_utc]))]);
  const writeKeys = new Set(writes.map((w) => w.key));

  const structured = {
    trip_id: args.trip_id,
    reminder_plan: true,
    reality: d.trip.reality,
    label: DEMO_LABEL,
    timezone: d.trip.timezone,
    calendar_name: settings.calendar_name,
    notify_time: settings.notify_time,
    reminders: plan.items.map((i) => ({ ...i, state: stateLabel(events, i.key, writeKeys.has(i.key)) })),
    removals: writes.filter((w) => w.op === "remove").map((w) => ({ key: w.key, title: w.title })),
    notes: plan.notes,
  };
  const planLines = [
    `${DEMO_LABEL}. All times are trip-local (${d.trip.timezone}), with Beijing time beside them.`,
    ...plan.items.map((i) => `- ${i.what}. ${i.lead}. ${i.display_when} (Beijing ${i.display_beijing}).`),
    ...plan.notes,
  ];

  if (args.confirmation_code) {
    if (!(await validCode(ctx, args.confirmation_code, "reminders", args.trip_id, target))) {
      return fail("invalid_confirmation_code", "The plan changed or this agreement expired. Nothing was recorded; show the current plan again.");
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO reminder_plans(trip_id,user_id,settings_json,confirmed_json,confirmed_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)
       ON CONFLICT(trip_id) DO UPDATE SET settings_json=excluded.settings_json,confirmed_json=excluded.confirmed_json,confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at WHERE reminder_plans.user_id=excluded.user_id`,
    )
      .bind(args.trip_id, userId, JSON.stringify(settings), JSON.stringify(writes), now)
      .run();
    const guidance: Guidance = writes.length
      ? {
          fact: "The person agreed to this plan. Nothing is in a calendar yet.",
          next_steps: [
            {
              when: "you have called this host's own calendar tool for each write: add results, with each write's key, the real outcome and the event ID it returned",
              tool: "record_reminder_results",
              args: { trip_id: args.trip_id },
              needs_confirmation: false,
            },
          ],
          end: null,
        }
      : { fact: "Nothing needs writing: every reminder in this plan is already in the calendar.", next_steps: [], end: "No calendar action is needed." };
    return guided(
      [
        ...planLines,
        ...(writes.length
          ? [
              "Calendar writes to make with this host's own calendar tool. Report each real result, including failures. If this host has no calendar tool, make no report and tell the person the reminders are not set:",
              ...writes.map(writeLine),
            ]
          : []),
      ].join("\n"),
      { ...structured, confirmed: true, writes },
      guidance,
    );
  }

  if (changed) await saveSettings(env.DB, userId, args.trip_id, settings);

  if (writes.length === 0) {
    return guided(planLines.join("\n"), { ...structured, confirmed: false, writes: [] }, {
      fact: plan.items.length
        ? "Every reminder in this plan is already in the calendar."
        : "There is nothing left to remind about: this sample trip's reminder times have passed.",
      next_steps: [],
      end: "No calendar action is needed.",
    });
  }

  const code = await localCode(ctx, "reminders", args.trip_id, target);
  const writtenCount = events.filter((e) => e.state === "written").length;
  const ops = new Set(writes.map((w) => w.op));
  const ask =
    ops.size === 1 && ops.has("create")
      ? { card_action: "Add to my calendar", card_message: "I agree to this CozyTrip demo reminder plan. Please add it to my calendar." }
      : ops.size === 1 && ops.has("remove")
        ? { card_action: "Remove from my calendar", card_message: "I agree to remove this CozyTrip demo reminder from my calendar." }
        : { card_action: "Update my calendar", card_message: "I agree to this CozyTrip demo reminder plan. Please update my calendar to match it." };
  const toSet = writes.filter((w) => w.op !== "remove").length;
  return guided(
    planLines.join("\n"),
    { ...structured, confirmed: false, confirmation_code: code, codeKind: "local" },
    {
      fact:
        toSet === 0
          ? "A CozyTrip Demo reminder in the calendar no longer applies. It stays there until the person agrees to remove it."
          : `This is a Demo plan with ${plan.items.length} reminders for a fictional trip. It is only a plan: ${writtenCount ? `${writtenCount} already in the calendar, ${toSet} not set` : "nothing is in any calendar"}.`,
      next_steps: [
        {
          when: "the person agrees to the whole plan and this host has a calendar tool. If it has none, keep the plan and say the reminders are not set, and how to connect a calendar here if you know",
          tool: name,
          args: { trip_id: args.trip_id, confirmation_code: code },
          needs_confirmation: true,
          ...ask,
        },
        nextStep.adjustReminders(args.trip_id),
      ],
      end: null,
    },
  );
}
