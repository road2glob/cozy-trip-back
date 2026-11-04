-- Tables only, zero rows. The PM runs remote migrations.
CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- One static demo access token per person. Only the SHA-256 hex digest is stored, never the token.
CREATE TABLE IF NOT EXISTS demo_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  label      TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_demo_tokens_user ON demo_tokens(user_id);
