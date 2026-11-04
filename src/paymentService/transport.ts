import type { Env } from "../env";
import type { ErrorBody } from "./types";
import { stubFetch } from "../../stub";

/** With a Service Binding the URL only carries the path; nothing leaves Cloudflare */
const BINDING_ORIGIN = "https://taskpass.internal";

export class PaymentServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentServiceError";
  }
}

export interface CallOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

function resolveFetcher(env: Env): { origin: string; send: (req: Request) => Promise<Response> } {
  switch (env.TASKPASS_TRANSPORT) {
    case "stub":
      return { origin: BINDING_ORIGIN, send: (req) => stubFetch(req, env) };
    case "binding":
      return { origin: BINDING_ORIGIN, send: (req) => env.TASKPASS.fetch(req) };
    case "https": {
      if (!env.TASKPASS_BASE_URL) throw new Error("TASKPASS_TRANSPORT=https requires TASKPASS_BASE_URL");
      return { origin: env.TASKPASS_BASE_URL.replace(/\/+$/, ""), send: (req) => fetch(req) };
    }
    default:
      throw new Error(`Unknown TASKPASS_TRANSPORT: ${String(env.TASKPASS_TRANSPORT)}`);
  }
}

/** The only outbound call site in this Worker */
export async function call<T>(env: Env, opts: CallOptions): Promise<{ status: number; data: T }> {
  const { origin, send } = resolveFetcher(env);
  const headers = new Headers({
    Authorization: `Bearer ${env.TASKPASS_PRODUCT_TOKEN}`,
    Accept: "application/json",
  });
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  if (opts.idempotencyKey) headers.set("Idempotency-Key", opts.idempotencyKey);

  const res = await send(
    new Request(origin + opts.path, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new PaymentServiceError(res.status, "invalid-json", "Payment & verification service returned non-JSON content");
  }
  if (!res.ok) {
    const err = (parsed as ErrorBody | null)?.error;
    throw new PaymentServiceError(res.status, err?.code ?? `http-${res.status}`, err?.message ?? res.statusText);
  }
  return { status: res.status, data: parsed as T };
}
