import type { DB } from "../shared/migrations.js";
import {
  PAGE_SIZE,
  PAGE_PAUSE_MS,
  BACKFILL_BUDGET_MS,
  type BackfillOutcome,
} from "../shared/backfill-limits.js";

export interface BackfillCursor {
  msgId: string;
  ts: number;
}

/** Injectable so a test does not have to spend twenty real seconds proving the budget. */
export interface BackfillClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: BackfillClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * fetchMessageHistory pages backwards from a message you already have, so the
 * cursor is the oldest known message of the chat. No local history, no cursor —
 * which is exactly why the daemon has to exist.
 */
export function planBackfill(db: DB, jid: string): BackfillCursor | null {
  const row = db
    .prepare("SELECT oldest_msg_id, oldest_ts, complete FROM sync_state WHERE chat_jid = ?")
    .get(jid) as { oldest_msg_id: string | null; oldest_ts: number | null; complete: number } | undefined;

  if (!row || row.complete === 1) return null;
  if (!row.oldest_msg_id || row.oldest_ts === null) return null;
  return { msgId: row.oldest_msg_id, ts: row.oldest_ts };
}

/**
 * Walks the cursor backwards, one page at a time, until the pages run out, the chat
 * runs out, or the budget does.
 *
 * `ask` only asks. Results land later through messaging-history.set, which is what
 * moves the cursor this loop re-reads on every turn — so the pause between pages is
 * load-bearing twice over, and skipping it would just re-ask the same window.
 */
export async function runBackfill(
  db: DB,
  jid: string,
  pages: number,
  ask: (cursor: BackfillCursor) => Promise<void>,
  clock: BackfillClock = realClock,
): Promise<BackfillOutcome> {
  const deadline = clock.now() + BACKFILL_BUDGET_MS;
  let asked = 0;

  for (let i = 0; i < pages; i++) {
    const cursor = planBackfill(db, jid);
    if (!cursor) return { asked, stopped: "exhausted" };

    await ask(cursor);
    asked += PAGE_SIZE;

    if (i + 1 >= pages) break;
    // Checked before the sleep, not after. The sleep is the expensive half, and a
    // deadline noticed on the far side of it has already been blown.
    if (clock.now() + PAGE_PAUSE_MS >= deadline) return { asked, stopped: "budget" };
    await clock.sleep(PAGE_PAUSE_MS);
  }

  return { asked, stopped: "pages" };
}
