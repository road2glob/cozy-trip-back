import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { impactPreview } from "../domain/impact";
import { localCode, validCode, operation } from "../domain/operations";
import { createRun, submitOutput, getReceipt } from "../paymentService";
import { fail, type ToolContext } from "./common";
import { guided, nextStep } from "./guidance";
import type { TripDetail } from "../domain/trips";

interface ImpactEntry {
  bookingId: string;
  status: string;
  rule: string;
  provenance: string;
  evidence: string;
}

const STATUS_WORD: Record<string, string> = { disrupted: "disrupted", at_risk: "at risk", unaffected: "unaffected" };

/** Older stored assessments have no titles, so they are added on the way out instead of when saving */
const withTitles = (d: TripDetail, impacts: ImpactEntry[]) =>
  impacts.map((i) => ({ ...i, title: d.bookings.find((b) => b.booking_id === i.bookingId)?.title ?? "Booking" }));

const impactLines = (impacts: ReturnType<typeof withTitles>) =>
  impacts.map((i) => `- ${i.title}: ${STATUS_WORD[i.status] ?? i.status} (${i.provenance}). ${i.evidence}`);

function confirmedResult(d: TripDetail, tripId: string, issueId: string, runId: string, result: Record<string, unknown> & { impacts: ImpactEntry[] }, replay: boolean) {
  const impacts = withTitles(d, result.impacts);
  return guided(
    ["Simulated impact confirmed. No airline was contacted and no booking was cancelled with a merchant.", ...impactLines(impacts)].join("\n"),
    { trip_id: tripId, issue_id: issueId, runId, ...result, impacts, ...(replay ? { replay: true } : {}) },
    {
      fact: "A simulated cancellation is recorded. No airline was contacted, and nothing has been bought.",
      next_steps: [nextStep.options(tripId), nextStep.quoteDrafts(tripId)],
      end: null,
    },
  );
}

export const name = "detect_impact";
export const description =
  "Preview a fictional flight-cancellation impact without changing anything. Only a returned local confirmation_code confirms the simulation and opens a zero-price assessment.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  confirmation_code: z.string().optional(),
});
export const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const d = await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id);
  if (!d?.demoEvent) return fail("not_found", "Import the sample trip first.");
  const target = d.demoEvent.event_id;
  const existing = await ctx.env.DB.prepare(
    "SELECT run_id,result_json FROM impact_assessments WHERE trip_id=?1 AND user_id=?2",
  )
    .bind(args.trip_id, ctx.userId)
    .first<{ run_id: string; result_json: string }>();
  if (existing)
    return confirmedResult(d, args.trip_id, target, existing.run_id, JSON.parse(existing.result_json), true);
  const impacts = impactPreview(d);
  if (!args.confirmation_code) {
    const code = await localCode(ctx, "impact", args.trip_id, target);
    const titled = withTitles(d, impacts);
    return guided(
      ["Preview only: fictional outbound flight cancellation. Nothing has changed.", ...impactLines(titled)].join("\n"),
      {
        trip_id: args.trip_id,
        preview: true,
        reality: "fictional_sample",
        impacts: titled,
        confirmation_code: code,
        codeKind: "local",
      },
      {
        fact: "This is a preview of a fictional cancellation. Nothing has changed. Confirming records a simulation only: no real flight is cancelled, and it costs nothing.",
        next_steps: [nextStep.confirmIssue(args.trip_id, code)],
        end: null,
      },
    );
  }
  if (
    !(await validCode(
      ctx,
      args.confirmation_code,
      "impact",
      args.trip_id,
      target,
    ))
  )
    return fail(
      "invalid_confirmation_code",
      "Impact confirmation is missing, invalid or expired. Nothing changed.",
    );
  return operation(ctx, "impact:" + args.trip_id, async () => {
    const created = await createRun(ctx.env, "assess:" + target, {
      workflowId: "cozytrip.issue.assess",
      subjectId: ctx.userId,
      input: {
        tripId: args.trip_id,
        bookingIds: d.bookings.map((b) => b.booking_id),
      },
    });
    const affectedBookingIds = impacts
      .filter((b) => b.status !== "unaffected")
      .map((b) => b.bookingId);
    const submitted = await submitOutput(ctx.env, created.runId, {
      affectedBookingIds,
      summary:
        "Confirmed simulated cancellation; linked pickup disrupted and same-day hotel arrival at risk. No airline was contacted.",
    });
    if (submitted.verification.state !== "passed")
      return fail(
        "verification_failed",
        "The free assessment did not pass verification. Nothing was changed.",
      );
    const receipt = await getReceipt(ctx.env, created.runId);
    if (
      receipt.chargeOutcome !== "none" ||
      receipt.verificationState !== "passed"
    )
      return fail(
        "verification_failed",
        "The free assessment receipt is not ready.",
      );
    const result = {
      preview: false,
      reality: "fictional_sample",
      impacts,
      receipt,
    };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "UPDATE demo_events SET state='fired',fired_at=?1 WHERE event_id=?2 AND trip_id=?3",
      ).bind(new Date().toISOString(), target, args.trip_id),
      ctx.env.DB.prepare(
        "UPDATE trips SET state='disrupted' WHERE trip_id=?1 AND user_id=?2",
      ).bind(args.trip_id, ctx.userId),
      ...impacts.map((b) =>
        ctx.env.DB.prepare(
          "UPDATE bookings SET status=?1 WHERE booking_id=?2 AND trip_id=?3",
        ).bind(b.status, b.bookingId, args.trip_id),
      ),
      ctx.env.DB.prepare(
        "INSERT OR IGNORE INTO issues(issue_id,trip_id,demo_event_id,run_id,state,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
      ).bind(
        target,
        args.trip_id,
        target,
        created.runId,
        "open",
        new Date().toISOString(),
      ),
      ctx.env.DB.prepare(
        "INSERT OR IGNORE INTO impact_assessments(trip_id,user_id,run_id,result_json,created_at) VALUES(?1,?2,?3,?4,?5)",
      ).bind(
        args.trip_id,
        ctx.userId,
        created.runId,
        JSON.stringify(result),
        new Date().toISOString(),
      ),
    ]);
    return confirmedResult(d, args.trip_id, target, created.runId, result, false);
  });
}
