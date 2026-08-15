CREATE TABLE IF NOT EXISTS chats (
  jid             TEXT PRIMARY KEY,
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  jid       TEXT PRIMARY KEY,
  name      TEXT,
  push_name TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  chat_jid   TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  sender_jid TEXT,
  from_me    INTEGER NOT NULL DEFAULT 0,
  timestamp  INTEGER NOT NULL,
  type       TEXT NOT NULL,
  text       TEXT,
  quoted_id  TEXT,
  UNIQUE (chat_jid, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages (timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  text,
  content='messages',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS sync_state (
  chat_jid      TEXT PRIMARY KEY,
  oldest_msg_id TEXT,
  oldest_ts     INTEGER,
  complete      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
