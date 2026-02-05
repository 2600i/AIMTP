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
  FOREIGN KEY(recipient) REFERENCES mailbox_recipients(recipient) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_recipient_id
  ON mailbox_messages(recipient, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_enqueued_at
  ON mailbox_messages(enqueued_at);
