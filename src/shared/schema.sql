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

  -- Voice note transcribed locally by whisper.cpp. Deliberately NOT folded into
  -- `text`: ingest.ts replays history on every reconnect with `text = excluded.text`,
  -- which is NULL for audio, so a transcript there would be erased about every 30
  -- minutes; and getMessage (daemon/socket.ts) answers a peer's retry request with
  -- `text`, so a transcript there would be sent back to whoever recorded the note as
  -- if we had typed it.
  transcript          TEXT,

  -- NULL means the daemon never considered this row: every non-audio message, and
  -- every voice note older than this feature. "Only from here on" is written as the
  -- absence of a value, so the ~8.8k notes already in the store need no backfill.
  -- No DEFAULT on purpose: SQLite synthesises a column default when it reads a
  -- pre-existing record, so `DEFAULT 'pending'` would queue all 316k rows at once.
  transcript_status   TEXT,   -- pending | running | done | failed
  transcript_at       INTEGER,
  transcript_attempts INTEGER,
  transcript_error    TEXT,

  -- JSON pointer the downloader needs to fetch this note again after a restart:
  -- { mediaKey (base64), directPath, mimetype, seconds }. Deliberately no `url`:
  -- downloadContentFromMessage prefers any url on mmg.whatsapp.net over directPath,
  -- and that url expires — keeping it would mean the directPath, the whole reason
  -- this column exists, is never used.
  media_ref           TEXT,

  UNIQUE (chat_jid, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages (timestamp DESC);

-- Partial, and on `pending` alone: SQLite only uses a partial index when the query's
-- WHERE is syntactically implied by the index's, so widening this to
-- `IN ('pending','running')` would send the queue back to a full scan of 316k rows.
CREATE INDEX IF NOT EXISTS idx_messages_transcript_pending
  ON messages (timestamp) WHERE transcript_status = 'pending';

-- Two columns, both mapped by name to columns of `messages`. A MATCH with no column
-- prefix searches every column, so search_messages starts finding voice notes with
-- no change to its query at all.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  text,
  transcript,
  content='messages',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text, transcript) VALUES (new.id, new.text, new.transcript);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text, transcript)
    VALUES ('delete', old.id, old.text, old.transcript);
END;

-- `UPDATE OF text, transcript`, not a bare UPDATE: the transcription pipeline writes
-- transcript_status three times per note, and a bare trigger would re-index the row
-- on each of those for nothing.
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text, transcript ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text, transcript)
    VALUES ('delete', old.id, old.text, old.transcript);
  INSERT INTO messages_fts (rowid, text, transcript) VALUES (new.id, new.text, new.transcript);
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
