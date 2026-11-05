export type TaskpassTransport = "stub" | "binding" | "https";

export interface Env {
  DB: D1Database;
  /** Draft prose only; optional in offline tests. */
  AI?: Ai;
  /** Service Binding to the payment & verification service; unused in stub mode */
  TASKPASS: Fetcher;
  TASKPASS_TRANSPORT: TaskpassTransport;
  /** Second credential, sent as a Bearer token on every call; a secret when deployed */
  TASKPASS_PRODUCT_TOKEN: string;
  /** Only for the https fallback */
  TASKPASS_BASE_URL?: string;
  /** Public origin of the return pages, no path, e.g. https://mcp.cozytrip.dev */
  PUBLIC_RETURN_ORIGIN: string;
  /** Public Sandbox SDK identity. Never a client secret or access token. */
  PAYPAL_CLIENT_ID_PUBLIC?: string;
  /** HMAC key for demo token hashes; a secret when deployed */
  DEMO_TOKEN_PEPPER: string;
}
