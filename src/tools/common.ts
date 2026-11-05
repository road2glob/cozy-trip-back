import type { Env } from "../env";
import { PaymentServiceError } from "../paymentService";

export interface ToolContext {
  env: Env;
  userId: string;
  tokenId: string;
  requestId: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export const STUB_NOTICE = "Local contract stub. No PayPal order was created.";
export const REAL_SANDBOX_NOTICE = "Real PayPal Sandbox transaction.";
export const SIMULATED_NOTICE = "Simulated travel data.";
export const NOT_PAID_UNTIL_RECEIPT = "Payment is not successful until a receipt shows chargeOutcome captured and verificationState passed.";

export const SERVICE_WORKFLOW_ID = "cozytrip.aftersales.deliver";

export function isStub(env: Env): boolean {
  return env.TASKPASS_TRANSPORT === "stub";
}

/** How real a payment-service object is. The stub never produces paypal_sandbox. */
export function paymentReality(env: Env): "local_stub" | "paypal_sandbox" {
  return isStub(env) ? "local_stub" : "paypal_sandbox";
}

export function ok(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...extra } },
    isError: true,
  };
}

/** Surfaces a payment-service error without guessing: HTTP status plus the service's own code */
export function failFromService(e: unknown, what: string): ToolResult {
  if (e instanceof PaymentServiceError) {
    return fail("payment_service_error", `${what} failed (HTTP ${e.status}, ${e.code}): ${e.message}`, {
      http_status: e.status,
      service_code: e.code,
    });
  }
  throw e;
}
