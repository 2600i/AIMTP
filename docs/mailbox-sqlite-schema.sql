-- AIMTP mailbox SQLite schema (Phase 4 persistence)

CREATE TABLE IF NOT EXISTS mailbox_recipients (
  recipient TEXT PRIMARY KEY,
  last_activity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(recipient) REFERENCES mailbox_recipients(recipient) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_recipient_id
  ON mailbox_messages(recipient, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_status_available
  ON mailbox_messages(status, available_at, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_lease_until
  ON mailbox_messages(status, lease_until);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_enqueued_at
  ON mailbox_messages(enqueued_at);

CREATE TABLE IF NOT EXISTS mailbox_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  failed_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mailbox_dead_letters_recipient_id
  ON mailbox_dead_letters(recipient, id);
