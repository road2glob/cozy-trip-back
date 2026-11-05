// Fake service state for the local stub. Tables are created on demand and only in stub mode;
// they are not part of migrations/ and never exist in the remote database.

export interface StubRunRow {
  run_id: string;
  idempotency_key: string;
  body_digest: string;
  workflow_id: string;
  subject_id: string;
  input_json: string;
  input_digest: string;
  state: string;
  approval_id: string;
  approval_token: string;
  approval_state: string;
  approval_expires_at: string;
  approval_decided_at: string | null;
  actor_ref: string | null;
  charge_id: string | null;
  created_response: string;
  created_at: string;
  updated_at: string;
}

export interface StubChargeRow {
  charge_id: string;
  run_id: string;
  idempotency_key: string;
  created_status: number;
  created_response: string;
  approve_url: string;
  paypal_request_id: string;
  created_at: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stub_runs (
     run_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, body_digest TEXT NOT NULL,
     workflow_id TEXT NOT NULL, subject_id TEXT NOT NULL, input_json TEXT NOT NULL, input_digest TEXT NOT NULL,
     state TEXT NOT NULL, approval_id TEXT NOT NULL, approval_token TEXT NOT NULL, approval_state TEXT NOT NULL,
     approval_expires_at TEXT NOT NULL, approval_decided_at TEXT, actor_ref TEXT, charge_id TEXT,
     created_response TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stub_charges (
     charge_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL,
     created_status INTEGER NOT NULL, created_response TEXT NOT NULL, approve_url TEXT NOT NULL,
     paypal_request_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
];

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

export async function runByKey(db: D1Database, key: string): Promise<StubRunRow | null> {
  return db.prepare("SELECT * FROM stub_runs WHERE idempotency_key = ?1").bind(key).first<StubRunRow>();
}

export async function runById(db: D1Database, runId: string): Promise<StubRunRow | null> {
  return db.prepare("SELECT * FROM stub_runs WHERE run_id = ?1").bind(runId).first<StubRunRow>();
}

export async function insertRun(db: D1Database, r: StubRunRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stub_runs (run_id, idempotency_key, body_digest, workflow_id, subject_id, input_json, input_digest, state,
         approval_id, approval_token, approval_state, approval_expires_at, approval_decided_at, actor_ref, charge_id,
         created_response, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    )
    .bind(
      r.run_id,
      r.idempotency_key,
      r.body_digest,
      r.workflow_id,
      r.subject_id,
      r.input_json,
      r.input_digest,
      r.state,
      r.approval_id,
      r.approval_token,
      r.approval_state,
      r.approval_expires_at,
      r.approval_decided_at,
      r.actor_ref,
      r.charge_id,
      r.created_response,
      r.created_at,
      r.updated_at,
    )
    .run();
}

export async function updateRun(
  db: D1Database,
  runId: string,
  f: Pick<StubRunRow, "state" | "approval_state" | "approval_decided_at" | "actor_ref" | "charge_id" | "updated_at">,
): Promise<void> {
  await db
    .prepare(
      `UPDATE stub_runs SET state = ?1, approval_state = ?2, approval_decided_at = ?3, actor_ref = ?4, charge_id = ?5, updated_at = ?6
        WHERE run_id = ?7`,
    )
    .bind(f.state, f.approval_state, f.approval_decided_at, f.actor_ref, f.charge_id, f.updated_at, runId)
    .run();
}

export async function chargeByRun(db: D1Database, runId: string): Promise<StubChargeRow | null> {
  return db.prepare("SELECT * FROM stub_charges WHERE run_id = ?1").bind(runId).first<StubChargeRow>();
}

export async function chargeById(db: D1Database, chargeId: string): Promise<StubChargeRow | null> {
  return db.prepare("SELECT * FROM stub_charges WHERE charge_id = ?1").bind(chargeId).first<StubChargeRow>();
}

export async function insertCharge(db: D1Database, c: StubChargeRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stub_charges (charge_id, run_id, idempotency_key, created_status, created_response, approve_url, paypal_request_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(c.charge_id, c.run_id, c.idempotency_key, c.created_status, c.created_response, c.approve_url, c.paypal_request_id, c.created_at)
    .run();
}
