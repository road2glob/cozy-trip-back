-- CozyTrip's own data only. Tables, zero rows. The PM runs remote migrations.
-- The payment & verification service keeps its own Run/Charge records; this database
-- refers to them by runId / chargeId only.

-- One static demo access token per person. token_hash = hex(hmac_sha256(DEMO_TOKEN_PEPPER, token)).
CREATE TABLE IF NOT EXISTS demo_tokens (
  token_id   TEXT PRIMARY KEY,               -- tok_ + 12 chars, safe to log
  token_hash TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL,
  label      TEXT NOT NULL,
  scopes     TEXT NOT NULL,                  -- space separated; phase 1: mcp:tools
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_tokens_user ON demo_tokens(user_id);

CREATE TABLE IF NOT EXISTS trips (
  trip_id          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  sample_key       TEXT,                     -- set for sample imports; one sample trip per user
  title            TEXT NOT NULL,
  origin_code      TEXT NOT NULL,
  origin_city      TEXT NOT NULL,
  destination_code TEXT NOT NULL,
  destination_city TEXT NOT NULL,
  start_date       TEXT NOT NULL,
  end_date         TEXT NOT NULL,
  timezone         TEXT NOT NULL,
  state            TEXT NOT NULL,            -- draft after import
  provenance       TEXT NOT NULL,            -- source | inferred | simulated
  reality          TEXT NOT NULL,            -- fictional_sample | paypal_sandbox | production_not_enabled
  created_at       TEXT NOT NULL,
  UNIQUE (user_id, sample_key)
);
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);

CREATE TABLE IF NOT EXISTS participants (
  participant_id TEXT PRIMARY KEY,
  trip_id        TEXT NOT NULL REFERENCES trips(trip_id),
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,              -- organizer | member
  sort_order     INTEGER NOT NULL,
  provenance     TEXT NOT NULL,
  reality        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_trip ON participants(trip_id);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id             TEXT PRIMARY KEY,
  trip_id                TEXT NOT NULL REFERENCES trips(trip_id),
  kind                   TEXT NOT NULL,      -- flight | hotel | transfer | activity
  vendor                 TEXT NOT NULL,
  title                  TEXT NOT NULL,
  local_start            TEXT NOT NULL,      -- local date or date-time in the trip timezone
  nights                 INTEGER,
  travelers              INTEGER,
  amount_minor           INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency               TEXT NOT NULL CHECK (currency = 'USD'),
  status                 TEXT NOT NULL,      -- confirmed
  linked_booking_id      TEXT REFERENCES bookings(booking_id),
  merchant_refund_status TEXT,               -- not_requested
  sort_order             INTEGER NOT NULL,
  provenance             TEXT NOT NULL,
  reality                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_id);

CREATE TABLE IF NOT EXISTS expenses (
  expense_id             TEXT PRIMARY KEY,
  trip_id                TEXT NOT NULL REFERENCES trips(trip_id),
  booking_id             TEXT NOT NULL REFERENCES bookings(booking_id),
  amount_minor           INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency               TEXT NOT NULL CHECK (currency = 'USD'),
  paid_by_participant_id TEXT REFERENCES participants(participant_id),  -- null when the sample does not say
  payment_method         TEXT,               -- sample_prepayment (not PayPal)
  provenance             TEXT NOT NULL,
  reality                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);

CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id     TEXT NOT NULL REFERENCES expenses(expense_id),
  participant_id TEXT NOT NULL REFERENCES participants(participant_id),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (expense_id, participant_id)
);

CREATE TABLE IF NOT EXISTS demo_events (
  event_id   TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(trip_id),
  kind       TEXT NOT NULL,                  -- flight_cancellation
  booking_id TEXT NOT NULL REFERENCES bookings(booking_id),
  state      TEXT NOT NULL,                  -- armed | fired
  created_at TEXT NOT NULL,
  fired_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_demo_events_trip ON demo_events(trip_id);

-- One row per payment-service run that CozyTrip opened. The PayPal order id is never a key.
CREATE TABLE IF NOT EXISTS service_orders (
  service_order_id       TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  trip_id                TEXT NOT NULL REFERENCES trips(trip_id),
  workflow_id            TEXT NOT NULL,
  run_idempotency_key    TEXT NOT NULL UNIQUE,
  run_id                 TEXT UNIQUE,
  run_state              TEXT NOT NULL,      -- creating, then the last state read from the service
  approval_id            TEXT,
  confirmation_code      TEXT,               -- = approvalToken for the 9.90 flow
  expires_at             TEXT,               -- = approval.expiresAt from the service
  charge_idempotency_key TEXT UNIQUE,
  charge_id              TEXT UNIQUE,
  charge_state           TEXT,
  approve_url            TEXT,
  paypal_order_id        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_orders_user_trip ON service_orders(user_id, trip_id);

-- Empty in phase 1; used by detect_impact / plan_options later.
CREATE TABLE IF NOT EXISTS issues (
  issue_id      TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL REFERENCES trips(trip_id),
  demo_event_id TEXT REFERENCES demo_events(event_id),
  run_id        TEXT,
  state         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS options (
  option_id    TEXT PRIMARY KEY,
  issue_id     TEXT NOT NULL REFERENCES issues(issue_id),
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  confirmation TEXT NOT NULL,                -- system_suggested | user_confirmed
  created_at   TEXT NOT NULL
);

-- Empty in phase 1; split settlement only. State follows the settlement order's lowercase state.
CREATE TABLE IF NOT EXISTS payments (
  payment_id     TEXT PRIMARY KEY,
  reference_id   TEXT NOT NULL UNIQUE CHECK (reference_id LIKE 'settlement:%'),
  trip_id        TEXT NOT NULL REFERENCES trips(trip_id),
  participant_id TEXT NOT NULL REFERENCES participants(participant_id),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency       TEXT NOT NULL CHECK (currency = 'USD'),
  state          TEXT NOT NULL,
  approve_url    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Empty in phase 1; phase 2.
CREATE TABLE IF NOT EXISTS split_requests (
  split_request_id TEXT PRIMARY KEY,
  trip_id          TEXT NOT NULL REFERENCES trips(trip_id),
  run_id           TEXT,
  total_minor      INTEGER NOT NULL CHECK (total_minor >= 0),
  local_code       TEXT,
  state            TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
