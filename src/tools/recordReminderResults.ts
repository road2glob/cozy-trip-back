import { z } from "zod";
import { contentKey, DEMO_LABEL, readEvents, type ReminderWrite } from "../domain/reminders";
import { operation } from "../domain/operations";
import { getTripDetail } from "../domain/trips";
import { fail, type ToolContext } from "./common";
import { guided, nextStep } from "./guidance";

export const name = "record_reminder_results";
export const description =
  "Report what this host's calendar tool actually did for each reminder in the plan the person agreed to. Report failures as failed. Never report a write that did not happen. CozyTrip keeps the event IDs, so retries update those entries instead of adding new ones, and it only ever maintains entries reported here.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  plan_id: z.string().min(1).max(100).optional().describe("Required for receipts. Copy from the confirmed plan that produced the calendar writes."),
  results: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        outcome: z.enum(["created", "updated", "removed", "failed"]),
        external_event_id: z.string().min(1).max(500).optional().describe("The ID your calendar tool returned. Required for created and updated."),
        calendar_name: z.string().max(120).optional(),
        detail: z.string().max(500).optional().describe("What the calendar tool said, for a failure"),
      }),
    )
    .min(1)
    .max(30),
});
export const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const LABEL = { created: "Set", updated: "Updated", removed: "Removed", failed: "Not set" } as const;

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  return operation(ctx, 'reminders:' + ctx.userId + ':' + args.trip_id, () => recordForTrip(ctx, args));
}

async function recordForTrip(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const { env, userId } = ctx;
  if (!(await getTripDetail(env.DB, userId, args.trip_id))) return fail("not_found", "Import the sample trip first.");
  const plan = await env.DB.prepare("SELECT confirmed_json FROM reminder_plans WHERE trip_id=?1 AND user_id=?2")
    .bind(args.trip_id, userId)
    .first<{ confirmed_json: string | null }>();
  if (!plan?.confirmed_json) {
    return fail("confirmation_required", "No reminder plan has been agreed. Show the plan with plan_reminders and get the person's agreement before any calendar write.");
  }
  const snapshot = JSON.parse(plan.confirmed_json) as { plan_id: string; writes: ReminderWrite[] } | ReminderWrite[];
  if (!args.plan_id || Array.isArray(snapshot) || args.plan_id !== snapshot.plan_id) {
    return fail("stale_reminder_plan", "This receipt belongs to an older or unidentified plan. Check the actual events with the calendar tool before retrying. If the old action created an extra event, show it to the person and ask before removing it.");
  }
  const agreed = new Map(snapshot.writes.map((w) => [w.key, w]));
  const events = new Map((await readEvents(env.DB, userId, args.trip_id)).map((e) => [e.reminder_key, e]));
  const OUTCOME_FOR = { create: "created", update: "updated", remove: "removed" } as const;

  const now = new Date().toISOString();
  const accepted = [];
  const rejected: Array<{ key: string; reason: string; external_event_id?: string | null }> = [];
  const seen = new Set<string>();
  for (const r of args.results) {
    if (seen.has(r.key)) {
      rejected.push({ key: r.key, reason: "duplicate_key" });
      continue;
    }
    seen.add(r.key);
    const w = agreed.get(r.key);
    if (!w) {
      rejected.push({ key: r.key, reason: "not_in_agreed_plan" });
      continue;
    }
    if (r.outcome !== "failed" && r.outcome !== OUTCOME_FOR[w.op]) {
      rejected.push({ key: r.key, reason: "outcome_does_not_match_write" });
      continue;
    }
    // A receipt is what separates "set" from "said to be set".
    if ((r.outcome === "created" || r.outcome === "updated") && !r.external_event_id) {
      rejected.push({ key: r.key, reason: "receipt_required" });
      continue;
    }
    const existing = events.get(r.key);
    if (r.outcome !== "failed" && r.calendar_name && w.calendar_name && r.calendar_name !== w.calendar_name) {
      rejected.push({ key: r.key, reason: "calendar_mismatch" });
      continue;
    }
    if (w.op !== "create" && r.external_event_id && w.external_event_id !== r.external_event_id) {
      rejected.push({ key: r.key, reason: "event_id_mismatch" });
      continue;
    }
    const calendar = w.calendar_name ?? r.calendar_name ?? existing?.calendar_name ?? null;
    // Replacing a recorded ID would leave that calendar entry where CozyTrip can never reach it.
    if (r.outcome === "created" && existing?.state === "written" && (existing.external_event_id !== r.external_event_id || existing.calendar_name !== calendar)) {
      rejected.push({ key: r.key, reason: "already_recorded", external_event_id: existing.external_event_id });
      continue;
    }
    const state = r.outcome === "failed" ? "failed" : r.outcome === "removed" ? "removed" : "written";
    // A failed write leaves the entry already in the calendar, and its ID, as they were.
    const keepExisting = r.outcome === "failed" && existing?.state === "written";
    let label: string = LABEL[r.outcome];
    if (keepExisting) {
      if (w.op === "remove") label = "Removal failed; original reminder is still scheduled";
      else if (w.op === "update") label = "Update failed; original reminder is still scheduled";
      else label = "Retry failed; original reminder is still scheduled";
    }
    const content = w.op === "remove" ? null : contentKey(w);
    await (keepExisting
      ? env.DB.prepare("UPDATE reminder_events SET detail=?1,updated_at=?2 WHERE trip_id=?3 AND reminder_key=?4 AND user_id=?5").bind(r.detail ?? null, now, args.trip_id, r.key, userId)
      : env.DB.prepare(
          `INSERT INTO reminder_events(trip_id,reminder_key,user_id,state,external_event_id,calendar_name,content_key,title,detail,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
           ON CONFLICT(trip_id,reminder_key) DO UPDATE SET state=excluded.state,external_event_id=excluded.external_event_id,calendar_name=excluded.calendar_name,content_key=excluded.content_key,title=excluded.title,detail=excluded.detail,updated_at=excluded.updated_at WHERE reminder_events.user_id=excluded.user_id`,
        ).bind(args.trip_id, r.key, userId, state, state === "written" ? r.external_event_id ?? null : null, calendar, state === "written" ? content : null, w.title, r.detail ?? null, now)
    ).run();
    accepted.push({
      key: r.key,
      outcome: r.outcome,
      title: w.title,
      what: w.title.startsWith(`${DEMO_LABEL}: `) ? w.title.slice(DEMO_LABEL.length + 2) : w.title,
      display_when: w.op === "remove" ? "" : w.display_when,
      display_beijing: w.op === "remove" ? "" : w.display_beijing,
      calendar_name: calendar,
      label,
      kept_existing: keepExisting,
      move_to: w.op === "remove" ? w.move_to : undefined,
      detail: r.detail ?? null,
    });
  }

  const failed = accepted.filter((r) => r.outcome === "failed");
  const kept = failed.filter((r) => r.kept_existing).length;
  const unset = failed.length - kept;
  const set = accepted.filter((r) => r.outcome === "created" || r.outcome === "updated");
  const removed = accepted.filter((r) => r.outcome === "removed");
  const parts = [
    ...(set.length ? [`${set.length} set`] : []),
    ...(removed.length ? [`${removed.length} removed`] : []),
    ...(unset ? [`${unset} failed and not set`] : []),
    ...(kept ? [`${kept} changes failed; original reminders remain scheduled`] : []),
    ...(rejected.length ? [`${rejected.length} not accepted`] : []),
  ];
  const retry = failed.length > 0 || rejected.length > 0;
  const continueMove = removed.some((r) => r.move_to);
  const next = retry || continueMove ? [nextStep.seeReminders(args.trip_id, continueMove ? "Continue calendar move" : "See reminder plan")] : [];
  return guided(
    [
      `As reported by this host's calendar tool: ${parts.join(", ") || "nothing"}.`,
      ...accepted.map((r) => `- ${r.what}: ${r.label.toLowerCase()}${r.detail ? ` (${r.detail})` : ""}.`),
      ...rejected.map((r) =>
        r.reason === "already_recorded"
          ? `- ${r.key}: already recorded as event ${r.external_event_id}. If your calendar tool just made another entry, remove that one.`
          : `- ${r.key}: not accepted (${r.reason}).`,
      ),
    ].join("\n"),
    {
      trip_id: args.trip_id,
      reminder_results: accepted,
      rejected,
      provenance: "host-reported",
      summary: { set: set.length, removed: removed.length, failed: failed.length, rejected: rejected.length },
    },
    {
      fact: `The host's calendar tool reports: ${parts.join(", ") || "nothing"}. ${kept ? "Check the original entries before retrying." : "Only what it reported as set is actually set."}`,
      next_steps: next,
      end: next.length ? null : "CozyTrip does not watch the calendar or send anything itself. To continue later, the person can ask CozyTrip in chat.",
    },
  );
}
