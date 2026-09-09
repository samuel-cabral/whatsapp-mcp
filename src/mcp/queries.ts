import { assessInbound, type InboundHealth } from "../shared/health.js";
import type { DB } from "../shared/migrations.js";
import type { ContactRow, SyncStatus, TranscriptionStatus } from "../shared/types.js";

export interface ChatSummary {
  jid: string;
  name: string | null;
  isGroup: boolean;
  unread: number;
  lastMessageAt: number | null;
  lastText: string | null;
}

export interface MessageView {
  id: string;
  at: number;
  fromMe: boolean;
  sender: string | null;
  senderName: string | null;
  type: string;
  text: string | null;
}

/**
 * Three sources of a name, in descending trustworthiness: the address book name
 * synced from the phone, the same name as WhatsApp echoes it, and the display
 * name the person chose for themselves. Any of them beats showing a raw jid.
 */
const NAME = "COALESCE(ct.name, ct.push_name)";

export type SearchHit = MessageView & { chatJid: string; chatName: string | null };

/**
 * Whether this database has the v2 transcription columns.
 *
 * The MCP process opens the store read-only and never migrates it (db.ts), so it can
 * legitimately be pointed at a v1 file: `npm run build` followed by a not-yet-restarted
 * daemon is exactly that window. Without this probe every read tool would die with
 * `no such column: transcript` — all eight of them, over a feature that is meant to
 * degrade quietly.
 *
 * Cached per handle, not per process: vitest runs one process per test FILE and the
 * read tests build a fresh :memory: database in each beforeEach, so a module-level
 * boolean would freeze the answer for whichever database happened to be first and
 * make those tests pass or fail by ordering.
 */
const transcriptSupport = new WeakMap<DB, boolean>();

export function hasTranscriptColumns(db: DB): boolean {
  const cached = transcriptSupport.get(db);
  if (cached !== undefined) return cached;
  const row = db
    .prepare("SELECT count(*) AS n FROM pragma_table_info('messages') WHERE name = 'transcript'")
    .get() as { n: number };
  const ok = row.n > 0;
  transcriptSupport.set(db, ok);
  return ok;
}

/** Selected in place of the real columns against a v1 store. */
const TRANSCRIPT_COLS = (db: DB): string =>
  hasTranscriptColumns(db)
    ? "m.transcript, m.transcript_status, m.transcript_error"
    : "NULL AS transcript, NULL AS transcript_status, NULL AS transcript_error";

function transcriptionStatus(db: DB): TranscriptionStatus {
  if (!hasTranscriptColumns(db)) {
    return {
      engineOk: false,
      engineError: "o banco ainda está no schema v1; reinicie o daemon para migrar.",
      pending: 0,
      failed: 0,
    };
  }
  const meta = (key: string): string | null => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };
  const count = (status: string): number =>
    (db.prepare("SELECT count(*) AS n FROM messages WHERE transcript_status = ?").get(status) as any).n;

  return {
    engineOk: meta("transcription_engine_ok") === "1",
    engineError: meta("transcription_engine_error"),
    pending: count("pending"),
    failed: count("failed"),
  };
}

/**
 * The query text is written by a model and may contain quotes or FTS5 operators.
 * Each word becomes its own quoted term, so any input is a valid AND search.
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" ");
}

export function listChats(db: DB, opts: { limit?: number; onlyUnread?: boolean }): ChatSummary[] {
  const rows = db
    .prepare(`
      SELECT c.jid, COALESCE(c.name, ${NAME}) AS name,
             c.is_group, c.unread_count, c.last_message_at,
             (SELECT m.text FROM messages m
               WHERE m.chat_jid = c.jid
               ORDER BY m.timestamp DESC LIMIT 1) AS last_text
        FROM chats c
        LEFT JOIN contacts ct ON ct.jid = c.jid
       WHERE (@onlyUnread = 0 OR c.unread_count > 0)
       ORDER BY COALESCE(c.last_message_at, 0) DESC
       LIMIT @limit
    `)
    .all({ onlyUnread: opts.onlyUnread ? 1 : 0, limit: opts.limit ?? 30 }) as any[];

  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    isGroup: r.is_group === 1,
    unread: r.unread_count,
    lastMessageAt: r.last_message_at,
    lastText: r.last_text,
  }));
}

export function readMessages(
  db: DB,
  opts: { jid: string; since?: number; until?: number; limit?: number },
): MessageView[] {
  // Ordered DESC to take the most recent under the limit, then flipped back to
  // chronological order, which is how a reader expects to see a conversation.
  const rows = db
    .prepare(`
      SELECT m.msg_id, m.timestamp, m.from_me, m.sender_jid, m.type, m.text,
             ${NAME} AS sender_name
        FROM messages m
        LEFT JOIN contacts ct ON ct.jid = m.sender_jid
       WHERE m.chat_jid = @jid
         AND (@since IS NULL OR m.timestamp >= @since)
         AND (@until IS NULL OR m.timestamp <= @until)
       ORDER BY m.timestamp DESC
       LIMIT @limit
    `)
    .all({
      jid: opts.jid,
      since: opts.since ?? null,
      until: opts.until ?? null,
      limit: opts.limit ?? 100,
    }) as any[];

  return rows
    .map((r) => ({
      id: r.msg_id,
      at: r.timestamp,
      fromMe: r.from_me === 1,
      sender: r.sender_jid,
      senderName: r.sender_name,
      type: r.type,
      text: r.text,
    }))
    .reverse();
}

export function searchMessages(
  db: DB,
  opts: { query: string; jid?: string; since?: number; limit?: number },
): SearchHit[] {
  const rows = db
    .prepare(`
      SELECT m.msg_id, m.timestamp, m.from_me, m.sender_jid, m.type, m.text,
             m.chat_jid,
             COALESCE(c.name, cc.name, cc.push_name) AS chat_name,
             COALESCE(sc.name, sc.push_name) AS sender_name
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        LEFT JOIN chats c ON c.jid = m.chat_jid
        LEFT JOIN contacts cc ON cc.jid = m.chat_jid
        LEFT JOIN contacts sc ON sc.jid = m.sender_jid
       WHERE messages_fts MATCH @q
         AND (@jid IS NULL OR m.chat_jid = @jid)
         AND (@since IS NULL OR m.timestamp >= @since)
       ORDER BY m.timestamp DESC
       LIMIT @limit
    `)
    .all({
      q: sanitizeFtsQuery(opts.query),
      jid: opts.jid ?? null,
      since: opts.since ?? null,
      limit: opts.limit ?? 50,
    }) as any[];

  return rows.map((r) => ({
    id: r.msg_id,
    at: r.timestamp,
    fromMe: r.from_me === 1,
    sender: r.sender_jid,
    senderName: r.sender_name,
    type: r.type,
    text: r.text,
    chatJid: r.chat_jid,
    chatName: r.chat_name,
  }));
}

export function getContact(db: DB, query: string): ContactRow[] {
  // Falls back to chats so that groups, which have no contact row, remain
  // findable — but a jid already matched via contacts must not repeat, which a
  // plain UNION would allow since the two sides differ in push_name.
  return db
    .prepare(`
      WITH matched_contacts AS (
        SELECT jid, name, push_name FROM contacts
         WHERE jid LIKE @like OR name LIKE @like OR push_name LIKE @like
      )
      SELECT jid, name, push_name FROM matched_contacts
      UNION ALL
      SELECT jid, name, NULL AS push_name FROM chats
       WHERE (jid LIKE @like OR name LIKE @like)
         AND jid NOT IN (SELECT jid FROM matched_contacts)
       LIMIT 20
    `)
    .all({ like: `%${query}%` }) as ContactRow[];
}

/**
 * `connected` alone was the whole health story here, and it is the field that
 * stayed green through a 47-hour outage. The inbound verdict exists so the status
 * can say no.
 */
export function getSyncStatus(db: DB, connected: boolean, health?: InboundHealth): SyncStatus {
  const m = db.prepare("SELECT count(*) AS n FROM messages").get() as any;
  const c = db.prepare("SELECT count(*) AS n FROM chats").get() as any;
  const done = db.prepare("SELECT value FROM meta WHERE key = 'initial_sync_done'").get() as any;
  const last = db.prepare("SELECT value FROM meta WHERE key = 'last_connected_at'").get() as any;
  const ingest = db.prepare("SELECT value FROM meta WHERE key = 'last_inbound_ingest_at'").get() as any;
  // Uses idx_messages_ts; measured at 0,2 ms against 151.987 rows.
  const inb = db.prepare("SELECT MAX(timestamp) AS t FROM messages WHERE from_me = 0").get() as any;
  const lastInboundAt = inb?.t ? Number(inb.t) : null; // MAX() de conjunto vazio é NULL

  return {
    connected,
    initialSyncDone: done?.value === "1",
    messageCount: m.n,
    chatCount: c.n,
    lastConnectedAt: last?.value ? Number(last.value) : null,
    lastInboundAt,
    lastInboundIngestAt: ingest?.value ? Number(ingest.value) : null,
    transcription: transcriptionStatus(db),
    inbound: assessInbound({
      now: Math.floor(Date.now() / 1000),
      lastInboundMsgTs: lastInboundAt,
      // The MCP process has no live tracker; it still gets the silence verdict.
      health: health ?? {
        decryptedLastHour: 0,
        undecryptableLastHour: 0,
        disconnectsLastHour: 0,
        bufferingSinceMs: null,
      },
    }),
  };
}
