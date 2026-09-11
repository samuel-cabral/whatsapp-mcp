/**
 * The backfill contract, shared because both ends of the control socket depend on it:
 * the MCP tool has to refuse a page count the daemon could never serve, and the daemon
 * has to stop before the client gives up on it.
 *
 * It lives here rather than in the daemon so that `mcp/` does not have to import from
 * `daemon/` — `daemon/control.ts` already imports from `mcp/queries.js`, and pointing
 * the second arrow back would make the two directories mutually dependent over four
 * numbers. types.ts was the other candidate and was left alone: it is types-only on
 * purpose, and these are values.
 */

/** WhatsApp's history query returns a page of this size. */
export const PAGE_SIZE = 50;

/**
 * Paced, not greedy: WhatsApp rate-limits history queries, and the answers arrive
 * asynchronously, so the pause is also what lets the cursor advance between asks.
 */
export const PAGE_PAUSE_MS = 1_500;

/**
 * How long one backfill command may spend asking, end to end.
 *
 * The control client hangs up on the daemon after 30s, and a command that cannot answer
 * inside that window is indistinguishable from a hung daemon. At PAGE_PAUSE_MS per page
 * the old declared ceiling of twenty pages cost thirty seconds of sleep alone, so that
 * ceiling could never once have answered: it and the timeout were written against each
 * other.
 *
 * The budget bounds the wall clock rather than the page count because each page also
 * waits on a round trip of unknown length, and counting pages can only bound the
 * sleeping half. Twenty seconds matches REQUEST_WAIT_MS, the same answer the transcribe
 * command already gives to the same problem.
 */
export const BACKFILL_BUDGET_MS = 20_000;

/**
 * The most pages one command may ask for.
 *
 * Derived from the budget rather than picked, so the declared ceiling is reachable
 * instead of merely stated: this many pages fit inside the budget when the round trips
 * are quick, and the budget itself catches the run when they are not.
 */
export const MAX_BACKFILL_PAGES = Math.floor(BACKFILL_BUDGET_MS / PAGE_PAUSE_MS);

export interface BackfillOutcome {
  /** Messages asked for — never messages received: history arrives asynchronously. */
  asked: number;
  /**
   * Why the loop stopped, so the caller can say something true instead of implying the
   * whole request was served. "exhausted" means the chat has no more history behind it;
   * "budget" means there is more and the command ran out of time.
   */
  stopped: "pages" | "exhausted" | "budget";
}
