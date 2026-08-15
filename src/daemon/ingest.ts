import type { DB } from "../shared/migrations.js";
import { toMessageRow } from "../shared/normalize.js";
import { normalizeJid, isGroupJid } from "../shared/jid.js";

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

  const run = db.transaction((batch: unknown[]) => {
    let written = 0;
    for (const raw of batch) {
      const row = toMessageRow(raw);
      if (!row) continue;
      insertMsg.run(row);
      touchChat.run({ jid: row.chat_jid, is_group: isGroupJid(row.chat_jid) ? 1 : 0, ts: row.timestamp });
      touchSync.run({ jid: row.chat_jid, msg_id: row.msg_id, ts: row.timestamp });
      written++;
    }
    return written;
  });

  return run(messages);
}

export function ingestChats(db: DB, chats: unknown[]): number {
  // COALESCE keeps a name we already know when a later sync omits it.
  const stmt = db.prepare(`
    INSERT INTO chats (jid, name, is_group, unread_count, archived)
    VALUES (@jid, @name, @is_group, @unread_count, @archived)
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      unread_count = excluded.unread_count,
      archived = excluded.archived
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
        unread_count: Number(c.unreadCount ?? 0),
        archived: c.archived ? 1 : 0,
      });
      n++;
    }
    return n;
  });

  return run(chats);
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
        name: c.name ?? null,
        push_name: c.notify ?? null,
      });
      n++;
    }
    return n;
  });

  return run(contacts);
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
