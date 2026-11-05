import { newId, nowIso } from "./ids";

export interface ServiceOrderRow {
  service_order_id: string;
  user_id: string;
  trip_id: string;
  workflow_id: string;
  run_idempotency_key: string;
  run_id: string | null;
  run_state: string;
  approval_id: string | null;
  confirmation_code: string | null;
  expires_at: string | null;
  charge_idempotency_key: string | null;
  charge_id: string | null;
  charge_state: string | null;
  approve_url: string | null;
  paypal_order_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `service_order_id, user_id, trip_id, workflow_id, run_idempotency_key, run_id, run_state, approval_id,
  confirmation_code, expires_at, charge_idempotency_key, charge_id, charge_state, approve_url, paypal_order_id, created_at, updated_at`;

/** Most recent order for this trip and workflow, any state */
export async function latestServiceOrder(
  db: D1Database,
  userId: string,
  tripId: string,
  workflowId: string,
): Promise<ServiceOrderRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM service_orders
        WHERE user_id = ?1 AND trip_id = ?2 AND workflow_id = ?3
        ORDER BY created_at DESC, service_order_id DESC LIMIT 1`,
    )
    .bind(userId, tripId, workflowId)
    .first<ServiceOrderRow>();
}

export async function serviceOrderByRun(db: D1Database, userId: string, tripId: string, runId: string): Promise<ServiceOrderRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM service_orders WHERE user_id = ?1 AND trip_id = ?2 AND run_id = ?3`)
    .bind(userId, tripId, runId)
    .first<ServiceOrderRow>();
}

export async function listServiceOrders(db: D1Database, userId: string, tripId?: string): Promise<ServiceOrderRow[]> {
  const stmt = tripId
    ? db
        .prepare(`SELECT ${COLUMNS} FROM service_orders WHERE user_id = ?1 AND trip_id = ?2 AND run_id IS NOT NULL ORDER BY created_at`)
        .bind(userId, tripId)
    : db.prepare(`SELECT ${COLUMNS} FROM service_orders WHERE user_id = ?1 AND run_id IS NOT NULL ORDER BY created_at`).bind(userId);
  return (await stmt.all<ServiceOrderRow>()).results;
}

/** Reserves the Idempotency-Key before the first POST /v1/runs, so a retry after a timeout reuses it */
export async function reserveServiceOrder(db: D1Database, userId: string, tripId: string, workflowId: string): Promise<ServiceOrderRow> {
  const now = nowIso();
  const row: ServiceOrderRow = {
    service_order_id: newId("so"),
    user_id: userId,
    trip_id: tripId,
    workflow_id: workflowId,
    run_idempotency_key: newId("run-key", 18),
    run_id: null,
    run_state: "creating",
    approval_id: null,
    confirmation_code: null,
    expires_at: null,
    charge_idempotency_key: null,
    charge_id: null,
    charge_state: null,
    approve_url: null,
    paypal_order_id: null,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO service_orders (service_order_id, user_id, trip_id, workflow_id, run_idempotency_key, run_state, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(row.service_order_id, userId, tripId, workflowId, row.run_idempotency_key, row.run_state, now, now)
    .run();
  return row;
}

type Updatable = Partial<
  Pick<
    ServiceOrderRow,
    | "run_id"
    | "run_state"
    | "approval_id"
    | "confirmation_code"
    | "expires_at"
    | "charge_idempotency_key"
    | "charge_id"
    | "charge_state"
    | "approve_url"
    | "paypal_order_id"
  >
>;

export async function updateServiceOrder(db: D1Database, serviceOrderId: string, fields: Updatable): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k], i) => `${k} = ?${i + 1}`).join(", ");
  await db
    .prepare(`UPDATE service_orders SET ${sets}, updated_at = ?${entries.length + 1} WHERE service_order_id = ?${entries.length + 2}`)
    .bind(...entries.map(([, v]) => v), nowIso(), serviceOrderId)
    .run();
}
