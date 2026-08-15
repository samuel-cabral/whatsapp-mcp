import type { DB } from "../shared/migrations.js";

/**
 * fetchMessageHistory pages backwards from a message you already have, so the
 * cursor is the oldest known message of the chat. No local history, no cursor —
 * which is exactly why the daemon has to exist.
 */
export function planBackfill(db: DB, jid: string): { msgId: string; ts: number } | null {
  const row = db
    .prepare("SELECT oldest_msg_id, oldest_ts, complete FROM sync_state WHERE chat_jid = ?")
    .get(jid) as { oldest_msg_id: string | null; oldest_ts: number | null; complete: number } | undefined;

  if (!row || row.complete === 1) return null;
  if (!row.oldest_msg_id || row.oldest_ts === null) return null;
  return { msgId: row.oldest_msg_id, ts: row.oldest_ts };
}
