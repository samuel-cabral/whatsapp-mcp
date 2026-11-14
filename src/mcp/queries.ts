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
  /** Machine transcript of a voice note. "" means we listened and heard no speech. */
  transcript: string | null;
  transcriptStatus: string | null;
  transcriptError: string | null;
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

/**
 * Same reasoning as hasTranscriptColumns: the MCP can be rebuilt ahead of the daemon
 * that migrates, and a v2 store has no lid_map. Without it every query below falls
 * back to treating each jid on its own, which is exactly how things behaved before.
 */
const lidMapSupport = new WeakMap<DB, boolean>();

export function hasLidMap(db: DB): boolean {
  const cached = lidMapSupport.get(db);
  if (cached !== undefined) return cached;
  const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lid_map'").get() !== undefined;
  lidMapSupport.set(db, ok);
  return ok;
}

/** The phone-number jid when `jid` is a lid we can resolve, otherwise `jid` itself. */
export function canonicalJid(db: DB, jid: string): string {
  if (!hasLidMap(db)) return jid;
  const row = db.prepare("SELECT pn FROM lid_map WHERE lid = ?").get(jid) as { pn: string } | undefined;
  return row?.pn ?? jid;
}

/**
 * Every jid the store may have filed this person's messages under: the number and
 * all lids known to map to it. The jid asked for comes first, and is always there.
 */
export function aliasesOf(db: DB, jid: string): string[] {
  if (!hasLidMap(db)) return [jid];
  const pn = canonicalJid(db, jid);
  const lids = db.prepare("SELECT lid FROM lid_map WHERE pn = ?").all(pn) as { lid: string }[];
  return [...new Set([jid, pn, ...lids.map((r) => r.lid)])];
}

/**
 * Name of a sender as the address book knows them. A lid sender is looked up under
 * the number first, because that is where the name saved on the phone lives; the
 * lid's own row usually holds no more than the push name.
 */
const SENDER_JOINS = (db: DB): string =>
  hasLidMap(db)
    ? `LEFT JOIN lid_map sl ON sl.lid = m.sender_jid
       LEFT JOIN contacts ct ON ct.jid = COALESCE(sl.pn, m.sender_jid)
       LEFT JOIN contacts lc ON lc.jid = m.sender_jid`
    : "LEFT JOIN contacts ct ON ct.jid = m.sender_jid";

const SENDER_NAME = (db: DB): string =>
  hasLidMap(db) ? "COALESCE(ct.name, ct.push_name, lc.name, lc.push_name)" : NAME;

/** A history replay can file one message under both jids of a person; keep the first. */
function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Selected in place of the real columns against a v1 store. */
const TRANSCRIPT_COLS = (db: DB): string =>
  hasTranscriptColumns(db)
    ? "m.transcript, m.transcript_status, m.transcript_error"
    : "NULL AS transcript, NULL AS transcript_status, NULL AS transcript_error";

/**
 * The chat list's preview line. NULLIF matters: an `empty` outcome stores the empty
 * string, and "" is not caught by the `?? "(sem texto)"` on the render side, so a
 * conversation whose last event was a silent voice note would show a blank line.
 */
const LAST_TEXT = (db: DB): string =>
  hasTranscriptColumns(db) ? "COALESCE(m.text, NULLIF(m.transcript, ''))" : "m.text";

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
  if (hasLidMap(db)) return listChatsMerged(db, opts);
  const rows = db
    .prepare(`
      SELECT c.jid, COALESCE(c.name, ${NAME}) AS name,
             c.is_group, c.unread_count, c.last_message_at,
             (SELECT ${LAST_TEXT(db)} FROM messages m
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

/**
 * The chat list with each person's lid chat folded into their number chat. The
 * name prefers what is attached to the number (the address book), and only then
 * whatever the lid side carries. Unread takes the MAX rather than the sum because a
 * replayed message can be counted unread on both sides.
 */
function listChatsMerged(db: DB, opts: { limit?: number; onlyUnread?: boolean }): ChatSummary[] {
  const rows = db
    .prepare(`
      WITH canon AS (
        SELECT COALESCE(lm.pn, c.jid) AS jid, c.jid AS raw_jid,
               COALESCE(c.name, ct.name, ct.push_name) AS name,
               c.is_group, c.unread_count, c.last_message_at
          FROM chats c
          LEFT JOIN lid_map lm ON lm.lid = c.jid
          LEFT JOIN contacts ct ON ct.jid = c.jid
      ),
      merged AS (
        SELECT g.jid,
               COALESCE(
                 (SELECT p.name FROM canon p WHERE p.raw_jid = g.jid),
                 (SELECT COALESCE(pc.name, pc.push_name) FROM contacts pc WHERE pc.jid = g.jid),
                 MAX(g.name)
               ) AS name,
               MAX(g.is_group) AS is_group,
               MAX(g.unread_count) AS unread_count,
               MAX(g.last_message_at) AS last_message_at
          FROM canon g
         GROUP BY g.jid
      )
      SELECT mg.*,
             (SELECT ${LAST_TEXT(db)} FROM messages m
               WHERE m.chat_jid IN (SELECT raw_jid FROM canon WHERE canon.jid = mg.jid)
               ORDER BY m.timestamp DESC LIMIT 1) AS last_text
        FROM merged mg
       WHERE (@onlyUnread = 0 OR mg.unread_count > 0)
       ORDER BY COALESCE(mg.last_message_at, 0) DESC
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
  // A message filed under both jids of a person is counted once by keeping only
  // its lowest rowid — but only when there is more than one jid. An ordinary chat
  // keeps `chat_jid = ?`: with IN, SQLite can no longer walk idx_messages_chat_ts
  // in order and sorts the whole chat instead (57 ms on a 12k-message group).
  const aliases = aliasesOf(db, opts.jid);
  const inChat =
    aliases.length > 1
      ? `m.chat_jid IN (SELECT value FROM json_each(@aliases))
         AND m.id IN (SELECT MIN(id) FROM messages WHERE chat_jid IN (SELECT value FROM json_each(@aliases)) GROUP BY msg_id)`
      : "m.chat_jid = @jid";
  const rows = db
    .prepare(`
      SELECT m.msg_id, m.timestamp, m.from_me, m.sender_jid, m.type, m.text,
             ${TRANSCRIPT_COLS(db)},
             ${SENDER_NAME(db)} AS sender_name
        FROM messages m
        ${SENDER_JOINS(db)}
       WHERE ${inChat}
         AND (@since IS NULL OR m.timestamp >= @since)
         AND (@until IS NULL OR m.timestamp <= @until)
       ORDER BY m.timestamp DESC
       LIMIT @limit
    `)
    .all({
      jid: opts.jid,
      aliases: JSON.stringify(aliases),
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
      transcript: r.transcript,
      transcriptStatus: r.transcript_status,
      transcriptError: r.transcript_error,
    }))
    .reverse();
}

export function searchMessages(
  db: DB,
  opts: { query: string; jid?: string; since?: number; limit?: number },
): SearchHit[] {
  // A lid chat is reported under the number it maps to, and named after it, so the
  // same person never shows up as two conversations in one result list.
  const lid = hasLidMap(db);
  const limit = opts.limit ?? 50;
  const rows = db
    .prepare(`
      SELECT m.msg_id, m.timestamp, m.from_me, m.sender_jid, m.type, m.text,
             ${TRANSCRIPT_COLS(db)},
             ${lid ? "COALESCE(cl.pn, m.chat_jid)" : "m.chat_jid"} AS chat_jid,
             COALESCE(${lid ? "pc.name, pcc.name, pcc.push_name, " : ""}c.name, cc.name, cc.push_name) AS chat_name,
             ${SENDER_NAME(db)} AS sender_name
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        LEFT JOIN chats c ON c.jid = m.chat_jid
        LEFT JOIN contacts cc ON cc.jid = m.chat_jid
        ${
          lid
            ? `LEFT JOIN lid_map cl ON cl.lid = m.chat_jid
               LEFT JOIN chats pc ON pc.jid = cl.pn
               LEFT JOIN contacts pcc ON pcc.jid = cl.pn`
            : ""
        }
        ${SENDER_JOINS(db)}
       WHERE messages_fts MATCH @q
         AND (@jid IS NULL OR m.chat_jid IN (SELECT value FROM json_each(@jid)))
         AND (@since IS NULL OR m.timestamp >= @since)
       ORDER BY m.timestamp DESC
       LIMIT @limit
    `)
    .all({
      q: sanitizeFtsQuery(opts.query),
      jid: opts.jid ? JSON.stringify(aliasesOf(db, opts.jid)) : null,
      since: opts.since ?? null,
      // Head room for the duplicates uniqueById drops below.
      limit: limit * 2,
    }) as any[];

  return uniqueById(rows.map((r) => ({
    id: r.msg_id,
    at: r.timestamp,
    fromMe: r.from_me === 1,
    sender: r.sender_jid,
    senderName: r.sender_name,
    type: r.type,
    text: r.text,
    transcript: r.transcript,
    transcriptStatus: r.transcript_status,
    transcriptError: r.transcript_error,
    chatJid: r.chat_jid,
    chatName: r.chat_name,
  }))).slice(0, limit);
}

export function getContact(db: DB, query: string): ContactRow[] {
  // Falls back to chats so that groups, which have no contact row, remain
  // findable — but a jid already matched via contacts must not repeat, which a
  // plain UNION would allow since the two sides differ in push_name.
  const rows = db
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

  // A person found under their lid ("Thais Leite", the push name) and under their
  // number ("Thaís Oliveira", the address book) is one answer, reported by number:
  // that is the jid read_messages expands to every alias, and the one to send to.
  const byJid = new Map<string, ContactRow>();
  for (const r of rows) {
    const jid = canonicalJid(db, r.jid);
    const prev = byJid.get(jid);
    if (!prev) {
      byJid.set(jid, { ...r, jid });
    } else if (r.jid === jid) {
      byJid.set(jid, { jid, name: r.name ?? prev.name, push_name: r.push_name ?? prev.push_name });
    } else {
      byJid.set(jid, { jid, name: prev.name ?? r.name, push_name: prev.push_name ?? r.push_name });
    }
  }
  // The number's own row may not have matched the query at all; its saved name
  // still beats whatever the lid side carried.
  for (const [jid, r] of byJid) {
    const own = db.prepare("SELECT name, push_name FROM contacts WHERE jid = ?").get(jid) as
      | { name: string | null; push_name: string | null }
      | undefined;
    if (own?.name) byJid.set(jid, { ...r, name: own.name });
  }
  return [...byJid.values()];
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
  // Só conversas reais. status@broadcast e newsletters continuam chegando quando o resto
  // está surdo, e foi isso que fez este status dizer "recebendo: sim" por 2 horas em
  // 30/10/2026. ORDER BY ... LIMIT 1 anda no idx_messages_ts em vez de varrer a tabela.
  const inb = db
    .prepare(
      `SELECT timestamp AS t FROM messages
       WHERE from_me = 0 AND chat_jid NOT LIKE '%@broadcast' AND chat_jid NOT LIKE '%@newsletter'
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get() as any;
  const lastInboundAt = inb?.t ? Number(inb.t) : null; // sem linhas: undefined, vira null

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
