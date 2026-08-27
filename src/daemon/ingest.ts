import type { DB } from "../shared/migrations.js";
import { toMessageRow } from "../shared/normalize.js";
import { normalizeJid, isGroupJid, isUserJid } from "../shared/jid.js";

/**
 * Every write goes through ON CONFLICT so that replaying a history batch — which
 * WhatsApp does on every reconnect — converges instead of duplicating.
 */
export function ingestMessages(db: DB, messages: unknown[]): number {
  const insertMsg = db.prepare(`
    INSERT INTO messages (chat_jid, msg_id, sender_jid, from_me, timestamp, type, text, quoted_id)
    VALUES (@chat_jid, @msg_id, @sender_jid, @from_me, @timestamp, @type, @text, @quoted_id)
    ON CONFLICT (chat_jid, msg_id) DO UPDATE SET
      text = excluded.text,
      type = excluded.type,
      quoted_id = excluded.quoted_id
  `);

  const touchChat = db.prepare(`
    INSERT INTO chats (jid, is_group, last_message_at)
    VALUES (@jid, @is_group, @ts)
    ON CONFLICT (jid) DO UPDATE SET
      last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at)
  `);

  const touchSync = db.prepare(`
    INSERT INTO sync_state (chat_jid, oldest_msg_id, oldest_ts, complete)
    VALUES (@jid, @msg_id, @ts, 0)
    ON CONFLICT (chat_jid) DO UPDATE SET
      oldest_msg_id = CASE WHEN excluded.oldest_ts < sync_state.oldest_ts THEN excluded.oldest_msg_id ELSE sync_state.oldest_msg_id END,
      oldest_ts     = MIN(sync_state.oldest_ts, excluded.oldest_ts)
  `);

  // The address book only reaches us through contact events, which WhatsApp is
  // stingy about. Every inbound message, on the other hand, carries the sender's
  // self-chosen display name — including group participants we have no contact
  // row for. Harvesting it here is what keeps the store from being all jids.
  const learnPushName = db.prepare(`
    INSERT INTO contacts (jid, push_name)
    VALUES (@jid, @push_name)
    ON CONFLICT (jid) DO UPDATE SET push_name = excluded.push_name
  `);

  const run = db.transaction((batch: unknown[]) => {
    let written = 0;
    for (const raw of batch) {
      const row = toMessageRow(raw);
      if (!row) continue;
      insertMsg.run(row);
      touchChat.run({ jid: row.chat_jid, is_group: isGroupJid(row.chat_jid) ? 1 : 0, ts: row.timestamp });
      touchSync.run({ jid: row.chat_jid, msg_id: row.msg_id, ts: row.timestamp });

      // isUserJid matters because in a 1:1 the sender IS the chat: without it,
      // status@broadcast learns the name of whoever posted and the status feed
      // starts showing up in the chat list as if it were a person.
      const pushName = (raw as any)?.pushName;
      if (
        row.sender_jid &&
        isUserJid(row.sender_jid) &&
        !row.from_me &&
        typeof pushName === "string" &&
        pushName.trim() !== ""
      ) {
        learnPushName.run({ jid: row.sender_jid, push_name: pushName.trim() });
      }
      written++;
    }
    return written;
  });

  return run(messages);
}

export function ingestChats(db: DB, chats: unknown[]): number {
  // COALESCE keeps a name we already know when a later sync omits it.
  // A null parameter means "this payload says nothing about that column". Writing
  // it back as zero is how a later sync that omits unreadCount silently marked
  // every chat as read.
  const stmt = db.prepare(`
    INSERT INTO chats (jid, name, is_group, unread_count, archived)
    VALUES (@jid, @name, @is_group, COALESCE(@unread_count, 0), COALESCE(@archived, 0))
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      unread_count = COALESCE(@unread_count, chats.unread_count),
      archived = COALESCE(@archived, chats.archived)
  `);

  const run = db.transaction((batch: unknown[]) => {
    let n = 0;
    for (const raw of batch) {
      const c = raw as any;
      if (!c?.id) continue;
      const jid = normalizeJid(c.id);
      stmt.run({
        jid,
        name: c.name ?? c.subject ?? null,
        is_group: isGroupJid(jid) ? 1 : 0,
        unread_count: c.unreadCount == null ? null : Number(c.unreadCount),
        archived: c.archived == null ? null : c.archived ? 1 : 0,
      });
      n++;
    }
    return n;
  });

  return run(chats);
}

/**
 * chats.update is the only event that reports reading and unreading after the
 * initial sync, and its unreadCount is a *delta*, not a total: Baileys sums
 * consecutive updates and decrements by one per message we had already read
 * (see concatChats / decrementChatReadCounterIfMsgDidUnread in its event buffer).
 * A literal null is its "counter neutralized" signal, i.e. the chat was opened.
 *
 * Updates never create a chat. A partial for a jid we have no row for carries no
 * jid type, name or timestamp, so inserting it would put a nameless ghost at the
 * top of the chat list.
 */
export function ingestChatUpdates(db: DB, updates: unknown[]): number {
  const stmt = db.prepare(`
    UPDATE chats SET
      name         = COALESCE(@name, name),
      archived     = COALESCE(@archived, archived),
      unread_count = CASE @unread_mode
                       WHEN 'reset' THEN 0
                       WHEN 'delta' THEN MAX(0, unread_count + @unread_delta)
                       ELSE unread_count
                     END
     WHERE jid = @jid
  `);

  const run = db.transaction((batch: unknown[]) => {
    let n = 0;
    for (const raw of batch) {
      const c = raw as any;
      if (!c?.id) continue;

      // A non-finite delta would bind as NULL against a NOT NULL column, and the
      // throw would roll back every other update in the same transaction. One bad
      // payload is not worth losing the batch, so it degrades to "keep".
      const raw_unread = c.unreadCount;
      const delta = Number(raw_unread);
      const mode =
        raw_unread === undefined ? "keep"
        : raw_unread === null ? "reset"
        : Number.isFinite(delta) ? "delta"
        : "keep";

      const info = stmt.run({
        jid: normalizeJid(c.id),
        name: c.name ?? c.subject ?? null,
        archived: c.archived == null ? null : c.archived ? 1 : 0,
        unread_mode: mode,
        unread_delta: mode === "delta" ? delta : 0,
      });
      n += info.changes;
    }
    return n;
  });

  return run(updates);
}

/**
 * Group subjects arrive from groupFetchAllParticipating and groups.update, whose
 * payloads carry no unread or archived state. Routing them through ingestChats
 * would write those columns back as zero, so this stays deliberately narrower.
 */
export function ingestGroupSubjects(db: DB, groups: unknown[]): number {
  const stmt = db.prepare(`
    INSERT INTO chats (jid, name, is_group)
    VALUES (@jid, @name, 1)
    ON CONFLICT (jid) DO UPDATE SET name = COALESCE(excluded.name, chats.name)
  `);

  const run = db.transaction((batch: unknown[]) => {
    let n = 0;
    for (const raw of batch) {
      const g = raw as any;
      if (!g?.id || typeof g.subject !== "string" || g.subject === "") continue;
      stmt.run({ jid: normalizeJid(g.id), name: g.subject });
      n++;
    }
    return n;
  });

  return run(groups);
}

export function ingestContacts(db: DB, contacts: unknown[]): number {
  const stmt = db.prepare(`
    INSERT INTO contacts (jid, name, push_name)
    VALUES (@jid, @name, @push_name)
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      push_name = COALESCE(excluded.push_name, contacts.push_name)
  `);

  const run = db.transaction((batch: unknown[]) => {
    let n = 0;
    for (const raw of batch) {
      const c = raw as any;
      if (!c?.id) continue;
      stmt.run({
        jid: normalizeJid(c.id),
        name: c.name ?? c.verifiedName ?? null,
        push_name: c.notify ?? null,
      });
      n++;
    }
    return n;
  });

  return run(contacts);
}

/**
 * Marks the initial history sync complete. The obvious-looking flag on the event,
 * isLatest, does not mean what its name suggests: Baileys computes it as
 * !creds.processedHistoryMessages?.length, so it is true on the FIRST batch after
 * a login and false forever after — this store went 32 batches and 151k messages
 * with it false the whole way. progress is the field that actually counts up, and
 * it reaches 100 on exactly one batch. Batches arrive out of order, so once the
 * flag is set a later batch must not clear it.
 */
export function recordHistoryProgress(db: DB, batch: { progress?: number | null }): boolean {
  if (typeof batch.progress !== "number" || batch.progress < 100) return false;
  if (getMeta(db, "initial_sync_done") === "1") return true;
  setMeta(db, "initial_sync_done", "1");
  return true;
}

/**
 * Wall clock of the last time we actually wrote an inbound message. Deliberately
 * NOT the message's own timestamp: those two diverge exactly when an offline
 * backlog drains, arriving with old timestamps but written right now, and telling
 * those apart is the difference between "the world is quiet" and "we are deaf".
 *
 * The newest inbound timestamp needs no key of its own — it is
 * MAX(timestamp) WHERE from_me = 0, which cannot drift from the rows themselves.
 */
export function markInboundIngested(db: DB, now = Math.floor(Date.now() / 1000)): void {
  setMeta(db, "last_inbound_ingest_at", String(now));
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
