-- Schema changes only. No sample rows or token data.
CREATE TABLE IF NOT EXISTS operation_locks (operation_key TEXT PRIMARY KEY, owner TEXT, expires_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS impact_assessments (trip_id TEXT PRIMARY KEY REFERENCES trips(trip_id), user_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trip_id TEXT NOT NULL REFERENCES trips(trip_id), output_json TEXT NOT NULL, drafting_method TEXT NOT NULL, submitted_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS case_progress (run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trip_id TEXT NOT NULL REFERENCES trips(trip_id), state TEXT NOT NULL CHECK(state IN ('prepared','submitted_by_user','awaiting_merchant','merchant_responded')), drafting_method TEXT NOT NULL, report_json TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS split_quotes (trip_id TEXT PRIMARY KEY REFERENCES trips(trip_id), user_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
ALTER TABLE payments ADD COLUMN user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS unique_payment_debtor ON payments(trip_id,participant_id);
