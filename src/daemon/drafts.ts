import { randomUUID } from "node:crypto";

export const DRAFT_TTL_MS = 600_000; // 10 minutes

export interface Draft {
  id: string;
  jid: string;
  text: string;
  createdAt: number;
}

/**
 * Drafts live in the daemon, never in the MCP process. That is what makes the
 * two-step send a real control rather than a convention: the confirm command
 * carries only an id, so the model never supplies the text at send time.
 *
 * In-memory on purpose — a daemon restart drops pending drafts, which fails closed.
 */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly now: () => number = Date.now) {}

  create(jid: string, text: string): Draft {
    const draft: Draft = { id: randomUUID(), jid, text, createdAt: this.now() };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  /** Consumes the draft: a given draft can be sent at most once. */
  take(id: string): Draft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    this.drafts.delete(id);
    if (this.now() - draft.createdAt > DRAFT_TTL_MS) return null;
    return draft;
  }

  size(): number {
    return this.drafts.size;
  }
}
