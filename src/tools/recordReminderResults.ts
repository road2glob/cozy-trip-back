import { z } from "zod";
import { contentKey, DEMO_LABEL, readEvents, type ReminderWrite } from "../domain/reminders";
import { getTripDetail } from "../domain/trips";
import { fail, type ToolContext } from "./common";
import { guided, nextStep } from "./guidance";

export const name = "record_reminder_results";
export const description =
  "Report what this host's calendar tool actually did for each reminder in the plan the person agreed to. Report failures as failed. Never report a write that did not happen. CozyTrip keeps the event IDs, so retries update those entries instead of adding new ones, and it only ever maintains entries reported here.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
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

const OUTCOME_WORD: Record<string, string> = { created: "set", updated: "updated", removed: "removed", failed: "not set" };

export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const { env, userId } = ctx;
  if (!(await getTripDetail(env.DB, userId, args.trip_id))) return fail("not_found", "Import the sample trip first.");
  const plan = await env.DB.prepare("SELECT confirmed_json FROM reminder_plans WHERE trip_id=?1 AND user_id=?2")
    .bind(args.trip_id, userId)
    .first<{ confirmed_json: string | null }>();
  if (!plan?.confirmed_json) {
    return fail("confirmation_required", "No reminder plan has been agreed. Show the plan with plan_reminders and get the person's agreement before any calendar write.");
  }
  const agreed = new Map((JSON.parse(plan.confirmed_json) as ReminderWrite[]).map((w) => [w.key, w]));
  const events = new Map((await readEvents(env.DB, userId, args.trip_id)).map((e) => [e.reminder_key, e]));
  const OUTCOME_FOR = { create: "created", update: "updated", remove: "removed" } as const;

  const now = new Date().toISOString();
  const accepted = [];
  const rejected: Array<{ key: string; reason: string; external_event_id?: string | null }> = [];
  for (const r of args.results) {
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
    // Replacing a recorded ID would leave that calendar entry where CozyTrip can never reach it.
    if (r.outcome === "created" && existing?.state === "written" && existing.external_event_id !== r.external_event_id) {
      rejected.push({ key: r.key, reason: "already_recorded", external_event_id: existing.external_event_id });
      continue;
    }
    const state = r.outcome === "failed" ? "failed" : r.outcome === "removed" ? "removed" : "written";
    // A failed write leaves the entry already in the calendar, and its ID, as they were.
    const keepExisting = r.outcome === "failed" && existing?.state === "written";
    const content = w.op === "remove" ? null : contentKey(w);
    await (keepExisting
      ? env.DB.prepare("UPDATE reminder_events SET detail=?1,updated_at=?2 WHERE trip_id=?3 AND reminder_key=?4 AND user_id=?5").bind(r.detail ?? null, now, args.trip_id, r.key, userId)
      : env.DB.prepare(
          `INSERT INTO reminder_events(trip_id,reminder_key,user_id,state,external_event_id,calendar_name,content_key,title,detail,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
           ON CONFLICT(trip_id,reminder_key) DO UPDATE SET state=excluded.state,external_event_id=excluded.external_event_id,calendar_name=excluded.calendar_name,content_key=excluded.content_key,title=excluded.title,detail=excluded.detail,updated_at=excluded.updated_at WHERE reminder_events.user_id=excluded.user_id`,
        ).bind(args.trip_id, r.key, userId, state, state === "written" ? r.external_event_id ?? null : null, r.calendar_name ?? null, state === "written" ? content : null, w.title, r.detail ?? null, now)
    ).run();
    accepted.push({
      key: r.key,
      outcome: r.outcome,
      title: w.title,
      what: w.title.startsWith(`${DEMO_LABEL}: `) ? w.title.slice(DEMO_LABEL.length + 2) : w.title,
      display_when: w.op === "remove" ? "" : w.display_when,
      display_beijing: w.op === "remove" ? "" : w.display_beijing,
      calendar_name: r.calendar_name ?? null,
      detail: r.detail ?? null,
    });
  }

  const failed = accepted.filter((r) => r.outcome === "failed");
  const set = accepted.filter((r) => r.outcome === "created" || r.outcome === "updated");
  const removed = accepted.filter((r) => r.outcome === "removed");
  const parts = [
    ...(set.length ? [`${set.length} set`] : []),
    ...(removed.length ? [`${removed.length} removed`] : []),
    ...(failed.length ? [`${failed.length} failed and not set`] : []),
    ...(rejected.length ? [`${rejected.length} not accepted`] : []),
  ];
  const retry = failed.length > 0 || rejected.length > 0;
  return guided(
    [
      `As reported by this host's calendar tool: ${parts.join(", ") || "nothing"}.`,
      ...accepted.map((r) => `- ${r.what}: ${OUTCOME_WORD[r.outcome]}${r.detail ? ` (${r.detail})` : ""}.`),
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
      fact: `The host's calendar tool reports: ${parts.join(", ") || "nothing"}. Only what it reported as set is actually set.`,
      next_steps: retry ? [nextStep.seeReminders(args.trip_id, "See reminder plan")] : [],
      end: retry ? null : "CozyTrip does not watch the calendar or send anything itself. To continue later, the person can ask CozyTrip in chat.",
    },
  );
}
