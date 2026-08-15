import type { DB } from "../shared/migrations.js";
import type { ControlResponse } from "../shared/types.js";
import { getSyncStatus } from "../mcp/queries.js";
import { setMeta } from "./ingest.js";
import type { DraftStore } from "./drafts.js";

export interface Sender {
  sendText(jid: string, text: string): Promise<string>;
  fetchOlder(jid: string, pages: number): Promise<number>;
}

export interface ControlDeps {
  db: DB;
  drafts: DraftStore;
  sender: Sender;
  connected: () => boolean;
}

const fail = (error: string): ControlResponse => ({ ok: false, error });
const done = (result: unknown): ControlResponse => ({ ok: true, result });

function chatName(db: DB, jid: string): string | null | undefined {
  const row = db
    .prepare(`
      SELECT COALESCE(c.name, ct.name, ct.push_name) AS name
        FROM chats c
        LEFT JOIN contacts ct ON ct.jid = c.jid
       WHERE c.jid = ?
    `)
    .get(jid) as { name: string | null } | undefined;
  return row ? row.name : undefined;
}

/**
 * Note what `confirm` does NOT read: any text or jid on the incoming command.
 * Both come from the stored draft. Extra fields are ignored by construction,
 * not by validation — there is no code path that could use them.
 */
export async function handleCommand(cmd: unknown, deps: ControlDeps): Promise<ControlResponse> {
  const c = cmd as any;
  if (!c || typeof c !== "object" || typeof c.cmd !== "string") {
    return fail("comando malformado");
  }

  try {
    switch (c.cmd) {
      case "status":
        return done(getSyncStatus(deps.db, deps.connected()));

      case "draft": {
        if (typeof c.jid !== "string" || typeof c.text !== "string" || c.text.trim() === "") {
          return fail("draft exige jid e text não vazios");
        }
        if (!deps.connected()) {
          return fail("WhatsApp desconectado — o rascunho não pôde ser criado. Verifique o daemon.");
        }
        const name = chatName(deps.db, c.jid);
        if (name === undefined) {
          return fail(`jid desconhecido: ${c.jid}. Use get_contact para achar o destinatário certo.`);
        }
        const draft = deps.drafts.create(c.jid, c.text);
        return done({ draftId: draft.id, jid: draft.jid, to: name ?? c.jid, text: draft.text });
      }

      case "confirm": {
        if (typeof c.draftId !== "string") return fail("confirm exige draftId");
        const draft = deps.drafts.take(c.draftId);
        if (!draft) {
          return fail("rascunho inexistente, já enviado ou vencido (10 min). Redija de novo com draft_message.");
        }
        if (!deps.connected()) return fail("WhatsApp desconectado — nada foi enviado.");
        const msgId = await deps.sender.sendText(draft.jid, draft.text);
        return done({ sent: true, msgId, jid: draft.jid });
      }

      case "backfill": {
        if (typeof c.jid !== "string") return fail("backfill exige jid");
        if (!deps.connected()) return fail("WhatsApp desconectado — backfill indisponível.");
        const pages = Number.isInteger(c.pages) && c.pages > 0 ? Math.min(c.pages, 20) : 1;
        const fetched = await deps.sender.fetchOlder(c.jid, pages);
        setMeta(deps.db, "last_backfill_at", String(Math.floor(Date.now() / 1000)));
        return done({ fetched });
      }

      default:
        return fail(`comando desconhecido: ${c.cmd}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
