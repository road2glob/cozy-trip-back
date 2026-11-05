// Structured log lines. Only these fields may be logged: never the Authorization header, a demo token,
// the pepper, TASKPASS_PRODUCT_TOKEN, PayPal secrets, or the PayPal `token` query parameter.
export interface LogFields {
  event: string;
  request_id?: string;
  tool?: string;
  token_id?: string;
  user_id?: string;
  trip_id?: string;
  runId?: string;
  chargeId?: string;
  outcome?: string;
  http_status?: number;
}

export function logEvent(fields: LogFields): void {
  const allowed: LogFields = {
    event: fields.event,
    request_id: fields.request_id,
    tool: fields.tool,
    token_id: fields.token_id,
    user_id: fields.user_id,
    trip_id: fields.trip_id,
    runId: fields.runId,
    chargeId: fields.chargeId,
    outcome: fields.outcome,
    http_status: fields.http_status,
  };
  console.log(JSON.stringify(allowed));
}
