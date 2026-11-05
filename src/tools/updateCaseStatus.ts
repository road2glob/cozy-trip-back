import { z } from "zod";
import { getReceipt } from "../paymentService";
import { serviceOrderByRun } from "../domain/serviceOrders";
import { localCode, validCode, operation } from "../domain/operations";
import { fail, type ToolContext } from "./common";
import { guided, reportCaseStep, type Guidance } from "./guidance";

const CASE_LABEL: Record<string, string> = {
  submitted_by_user: "Sent by me",
  awaiting_merchant: "Waiting for the merchant",
  merchant_responded: "Merchant replied",
};

function recordedGuidance(tripId: string, runId: string, state: string): Guidance {
  const report = reportCaseStep(tripId, runId, state);
  return {
    fact: `Recorded from the person's own report: "${CASE_LABEL[state] ?? state}". This covers the whole service order. CozyTrip contacted no one.`,
    next_steps: report ? [report] : [],
    end: report ? null : "This follow-up record is complete. It is still the person's own report.",
  };
}

export const name = "update_case_status";
export const description =
  "Available only after paid verified drafts are delivered. Record user-reported follow-up. A local confirmation code is required to mark that the user personally sent materials; this never contacts a merchant.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.enum([
    "submitted_by_user",
    "awaiting_merchant",
    "merchant_responded",
  ]),
  confirmation_code: z.string().optional(),
  note: z.string().max(1500).optional(),
  evidence: z.string().max(1500).optional(),
});
export const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};
const next: Record<string, string> = {
  prepared: "submitted_by_user",
  submitted_by_user: "awaiting_merchant",
  awaiting_merchant: "merchant_responded",
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const so = await serviceOrderByRun(
    ctx.env.DB,
    ctx.userId,
    args.trip_id,
    args.run_id,
  );
  if (!so)
    return fail(
      "delivery_required",
      "A paid verified delivery is required before case updates.",
    );
  const row = await ctx.env.DB.prepare(
    "SELECT state FROM case_progress WHERE run_id=?1 AND user_id=?2",
  )
    .bind(args.run_id, ctx.userId)
    .first<{ state: string }>();
  if (!row)
    return fail(
      "delivery_required",
      "Run verify_payment and receive prepared materials before updating a case.",
    );
  const receipt = await getReceipt(ctx.env, args.run_id);
  if (
    receipt.verificationState !== "passed" ||
    receipt.chargeOutcome !== "captured"
  )
    return fail(
      "delivery_required",
      "Case tracking is unavailable before a passed + captured receipt.",
    );
  if (row.state === args.status)
    return guided(
      "The user-reported case status is already recorded.",
      {
        trip_id: args.trip_id,
        runId: args.run_id,
        trackingState: row.state,
        provenance: "user-reported",
        replay: true,
      },
      recordedGuidance(args.trip_id, args.run_id, row.state),
    );
  if (next[row.state] !== args.status)
    return fail(
      "invalid_transition",
      "Follow the case stages in order; user submission cannot be skipped.",
    );
  if (args.status === "merchant_responded" && !args.note)
    return fail(
      "report_required",
      "Describe the merchant response as your own report.",
    );
  if (
    args.note &&
    /(refund.{0,15}(received|credited|arrived)|退款.{0,8}到账)/i.test(
      args.note,
    ) &&
    !args.evidence
  )
    return fail(
      "evidence_required",
      "Provide supporting evidence for a user-reported refund arrival; it will remain explicitly user-reported.",
    );
  const target = JSON.stringify([
    args.run_id,
    row.state,
    args.status,
    args.note ?? "",
    args.evidence ?? "",
  ]);
  if (!args.confirmation_code) {
    const code = await localCode(ctx, "case", args.trip_id, target);
    return guided(
      "Preview only. Confirm that you personally performed or observed this step. CozyTrip will not send anything.",
      {
        trip_id: args.trip_id,
        runId: args.run_id,
        currentState: row.state,
        proposedState: args.status,
        confirmation_code: code,
        codeKind: "local",
        preview: true,
        // The code is bound to these exact values, so the card and the agent must send them back unchanged.
        ...(args.note ? { note: args.note } : {}),
        ...(args.evidence ? { evidence: args.evidence } : {}),
      },
      {
        fact: `Nothing is recorded yet. The proposed record is "${CASE_LABEL[args.status]}", for the whole service order rather than each draft.`,
        next_steps: [
          {
            when: "the person confirms they did or saw this themselves",
            tool: name,
            args: {
              trip_id: args.trip_id,
              run_id: args.run_id,
              status: args.status,
              confirmation_code: code,
              ...(args.note ? { note: args.note } : {}),
              ...(args.evidence ? { evidence: args.evidence } : {}),
            },
            needs_confirmation: true,
            card_action: "Confirm my report",
          },
        ],
        end: null,
      },
    );
  }
  if (
    !(await validCode(
      ctx,
      args.confirmation_code,
      "case",
      args.trip_id,
      target,
    ))
  )
    return fail(
      "invalid_confirmation_code",
      "Invalid or expired local case confirmation. Nothing changed.",
    );
  return operation(ctx, "case:" + args.run_id, async () => {
    const changed = await ctx.env.DB.prepare(
      "UPDATE case_progress SET state=?1,report_json=?2,updated_at=?3 WHERE run_id=?4 AND user_id=?5 AND state=?6",
    )
      .bind(
        args.status,
        JSON.stringify({
          note: args.note ?? null,
          evidence: args.evidence ?? null,
          provenance: "user-reported",
        }),
        new Date().toISOString(),
        args.run_id,
        ctx.userId,
        row.state,
      )
      .run();
    if (!changed.meta.changes)
      return fail(
        "state_changed",
        "The case changed while confirming; read its current status again.",
      );
    return guided(
      "User-reported status recorded. No merchant action was performed by CozyTrip.",
      {
        trip_id: args.trip_id,
        runId: args.run_id,
        trackingState: args.status,
        provenance: "user-reported",
        report: args.note ?? null,
        evidence: args.evidence ?? null,
      },
      recordedGuidance(args.trip_id, args.run_id, args.status),
    );
  });
}
