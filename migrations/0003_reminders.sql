-- Schema changes only. No sample rows or token data.
-- reminder_plans: the person's choices, and the set of writes they last agreed to.
CREATE TABLE IF NOT EXISTS reminder_plans (trip_id TEXT PRIMARY KEY REFERENCES trips(trip_id), user_id TEXT NOT NULL, settings_json TEXT NOT NULL, confirmed_json TEXT, confirmed_at TEXT, updated_at TEXT NOT NULL);
-- reminder_events: what the host's calendar tool reported. One row per reminder, so retries update instead of duplicating.
CREATE TABLE IF NOT EXISTS reminder_events (trip_id TEXT NOT NULL REFERENCES trips(trip_id), reminder_key TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('written','failed','removed')), external_event_id TEXT, calendar_name TEXT, content_key TEXT, title TEXT NOT NULL, detail TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (trip_id, reminder_key));
