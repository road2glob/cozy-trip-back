import { z } from "zod";
import { getTripDetail } from "../domain/trips";
import { serviceOrderByRun, updateServiceOrder } from "../domain/serviceOrders";
import { draftMaterials } from "../domain/materials";
import { operation } from "../domain/operations";
import {
  getRun,
  reconcileCharge,
  submitOutput,
  getReceipt,
  PaymentServiceError,
} from "../paymentService";
import { fail, type ToolContext } from "./common";
import { NO_VERIFIED_CAPTURE, guided, nextStep, reportCaseStep, withGuidance, type Guidance } from "./guidance";

const MATERIAL_TITLE: Record<string, string> = {
  "airline-contact-points": "Airline contact points",
  "hotel-change-request": "Hotel change request",
  "transfer-and-cruise-change-request": "Transfer and cruise change request",
};

/** Titles are added on the way out, so the verified output itself stays exactly as it was submitted */
function titledOutput(output: unknown) {
  const o = output as Record<string, unknown> & { materials?: Array<{ kind: string; text: string }> };
  return { ...o, materials: (o.materials ?? []).map((m) => ({ ...m, title: MATERIAL_TITLE[m.kind] ?? m.kind })) };
}

/** Captured-but-still-delivering must not look like unpaid: only an unpaid order leads back to PayPal */
function pendingGuidance(tripId: string, runId: string, state: string, code: string | null): Guidance {
  switch (state) {
    case "awaiting-payment":
      return {
        fact: `${NO_VERIFIED_CAPTURE} No drafts are available until PayPal Sandbox shows the capture and it passes verification.`,
        next_steps: [
          nextStep.checkFee(tripId, runId, "Check again"),
          ...(code ? [nextStep.continuePayment(tripId, runId, code, "Back to PayPal")] : []),
        ],
        end: null,
      };
    case "running":
    case "verifying":
      return {
        fact: "CozyTrip is still checking this order. No new payment is needed and no drafts are available yet.",
        next_steps: [nextStep.checkFee(tripId, runId, "Check again")],
        end: null,
      };
    case "awaiting-approval":
      return { fact: "This fee is quoted but not confirmed, so no order exists and nothing is paid.", next_steps: [nextStep.reviewQuote(tripId)], end: null };
    default:
      return { fact: "This run is closed without drafts. No order is in progress.", next_steps: [nextStep.quoteDrafts(tripId)], end: null };
  }
}

export const name = "verify_payment";
export const description =
  "Reconcile a Sandbox service payment and deliver drafts ONLY after a passed + captured receipt. Drafts are not sent. Repeated calls do not create another payment or submit a successful output again.";
export const inputSchema = z.object({
  trip_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
});
export const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};
export async function run(ctx: ToolContext, args: z.infer<typeof inputSchema>) {
  const d = await getTripDetail(ctx.env.DB, ctx.userId, args.trip_id);
  if (!d)
    return fail(
      "not_found",
      "Import the sample before checking a service payment.",
    );
  const so = args.run_id
    ? await serviceOrderByRun(ctx.env.DB, ctx.userId, args.trip_id, args.run_id)
    : await ctx.env.DB.prepare(
        "SELECT * FROM service_orders WHERE trip_id=?1 AND user_id=?2 AND run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
        .bind(args.trip_id, ctx.userId)
        .first<Awaited<ReturnType<typeof serviceOrderByRun>>>();
  if (!so?.run_id)
    return fail(
      "quote_required",
      "No quoted service run exists for this trip.",
    );
  const runId = so.run_id;
  return operation(ctx, "delivery:" + runId, async () => {
    let r = await getRun(ctx.env, runId);
    if (r.state === "awaiting-payment") {
      await reconcileCharge(ctx.env, runId);
      r = await getRun(ctx.env, runId);
    }
    if (r.state === "running") {
      let cached = await ctx.env.DB.prepare(
        "SELECT output_json,drafting_method,submitted_at FROM deliveries WHERE run_id=?1 AND user_id=?2",
      )
        .bind(runId, ctx.userId)
        .first<{
          output_json: string;
          drafting_method: string;
          submitted_at: string | null;
        }>();
      if (!cached) {
        const drafted = await draftMaterials(ctx.env, d, so.service_order_id);
        await ctx.env.DB.prepare(
          "INSERT OR IGNORE INTO deliveries(run_id,user_id,trip_id,output_json,drafting_method,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        )
          .bind(
            runId,
            ctx.userId,
            args.trip_id,
            JSON.stringify(drafted.output),
            drafted.method,
            new Date().toISOString(),
          )
          .run();
        cached = {
          output_json: JSON.stringify(drafted.output),
          drafting_method: drafted.method,
          submitted_at: null,
        };
      }
      if (!cached.submitted_at) {
        await submitOutput(ctx.env, runId, JSON.parse(cached.output_json));
        await ctx.env.DB.prepare(
          "UPDATE deliveries SET submitted_at=?1 WHERE run_id=?2",
        )
          .bind(new Date().toISOString(), runId)
          .run();
      }
      r = await getRun(ctx.env, runId);
    }
    await updateServiceOrder(ctx.env.DB, so.service_order_id, {
      run_state: r.state,
    });
    let receipt;
    try {
      receipt = await getReceipt(ctx.env, runId);
    } catch (e) {
      if (e instanceof PaymentServiceError && e.status === 409)
        return guided(
          "Payment or verification is still pending. No materials are available yet.",
          {
            trip_id: args.trip_id,
            runId,
            state: r.state,
            paid: false,
            output: null,
          },
          pendingGuidance(args.trip_id, runId, r.state, so.confirmation_code),
        );
      throw e;
    }
    if (
      receipt.verificationState !== "passed" ||
      receipt.chargeOutcome !== "captured" ||
      r.state !== "verified" ||
      !r.output
    ) {
      const failed = fail(
        receipt.chargeOutcome === "refund-required"
          ? "refund_required"
          : "delivery_unavailable",
        "No verified materials can be delivered. A refund-required state is not a completed refund.",
        { runId, receipt, output: null },
      );
      return receipt.chargeOutcome === "refund-required"
        ? withGuidance(failed, {
            fact: "This order did not pass verification, so no drafts are available. Refund-required is not a completed refund.",
            next_steps: [],
            end: "No new payment is needed. Do not say a refund happened.",
          })
        : failed;
    }
    const drafted = await ctx.env.DB.prepare(
      "SELECT drafting_method FROM deliveries WHERE run_id=?1",
    )
      .bind(runId)
      .first<{ drafting_method: string }>();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT OR IGNORE INTO case_progress(run_id,user_id,trip_id,state,drafting_method,updated_at) VALUES(?1,?2,?3,'prepared',?4,?5)",
      ).bind(
        runId,
        ctx.userId,
        args.trip_id,
        drafted?.drafting_method ?? "existing-verified-output",
        new Date().toISOString(),
      ),
      ctx.env.DB.prepare(
        "UPDATE trips SET state='recovering' WHERE trip_id=?1 AND user_id=?2",
      ).bind(args.trip_id, ctx.userId),
    ]);
    const progress = await ctx.env.DB.prepare(
      "SELECT state FROM case_progress WHERE run_id=?1 AND user_id=?2",
    )
      .bind(runId, ctx.userId)
      .first<{ state: string }>();
    const output = titledOutput(r.output);
    const trackingState = progress?.state ?? "prepared";
    const report = reportCaseStep(args.trip_id, runId, trackingState);
    return guided(
      [
        "Payment verified and prepared drafts delivered. Draft. Not sent. The merchants are fictional, so nothing needs sending.",
        ...output.materials.map((m) => `\n${m.title}\n${m.text}`),
      ].join("\n"),
      {
        trip_id: args.trip_id,
        runId,
        state: r.state,
        paid: true,
        output,
        receipt,
        trackingState,
        draftingMethod: drafted?.drafting_method ?? "existing-verified-output",
        available_actions: ["update_case_status"],
      },
      {
        fact: "Payment verified. Three drafts are ready. They are not sent, and nothing needs sending because the merchants are fictional. Do not urge the person to contact anyone.",
        next_steps: report ? [report] : [],
        end: report ? null : "The person's follow-up record is complete. No payment action remains.",
      },
    );
  });
}
