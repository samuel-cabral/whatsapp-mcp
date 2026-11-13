import type { InboundHealth } from "../shared/health.js";
import type { DB } from "../shared/migrations.js";
import type { ControlResponse } from "../shared/types.js";
import { aliasesOf, getSyncStatus } from "../mcp/queries.js";
import { setMeta } from "./ingest.js";
import { MAX_BACKFILL_PAGES, type BackfillOutcome } from "../shared/backfill-limits.js";
import type { DraftStore } from "./drafts.js";
import { resolveMsgId, saveDocument, saveImage, type DocumentFetcher, type ImageFetcher } from "./media.js";

export interface Sender {
  sendText(jid: string, text: string): Promise<string>;
  fetchOlder(jid: string, pages: number): Promise<BackfillOutcome>;
  /** Optional so a transport without reactions still satisfies Sender. */
  sendReaction?(chatJid: string, key: ReactionKey, emoji: string): Promise<void>;
}

/** What WhatsApp needs to know to attach a reaction to one specific message. */
export interface ReactionKey {
  id: string;
  fromMe: boolean;
  /** The author inside a group; absent in 1:1 chats. */
  participant?: string;
}

/** A reaction is one emoji (possibly with a skin tone or ZWJ sequence), or empty to remove it. */
export function isSingleEmoji(s: string): boolean {
  if (s === "") return true;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const parts = [...seg.segment(s)];
  return parts.length === 1 && /\p{Extended_Pictographic}/u.test(s);
}

/**
 * The transcription queue, as the control layer sees it. Kept out of Sender on
 * purpose: Sender is the WhatsApp boundary, and transcription is local work that has
 * nothing to do with which transport is underneath.
 */
export interface Transcriber {
  request(chatJid: string, msgId: string, force: boolean): Promise<
    | { state: "done"; text: string }
    | { state: "failed"; error: string }
    | { state: "running" }
    | { state: "rejected"; error: string }
  >;
}

export interface ControlDeps {
  db: DB;
  drafts: DraftStore;
  sender: Sender;
  connected: () => boolean;
  /** Live counters from the daemon. status runs in-process, so these need no disk. */
  health?: () => InboundHealth;
  /** Absent when the preflight found no whisper, no ffmpeg or no model. */
  transcriber?: Transcriber;
  /** Where download_image saves to, and what fetches the bytes. */
  images?: { fetcher: ImageFetcher; dir: string };
  /** Same, for download_document. */
  documents?: { fetcher: DocumentFetcher; dir: string };
}

const fail = (error: string): ControlResponse => ({ ok: false, error });
const done = (result: unknown): ControlResponse => ({ ok: true, result });

function chatName(db: DB, jid: string): string | null | undefined {
  // get_contact hands out the phone-number jid, but the chat may be filed under the
  // person's lid. Accept any alias, and prefer the row that actually has a name.
  const aliases = JSON.stringify(aliasesOf(db, jid));
  const row = db
    .prepare(`
      SELECT COALESCE(c.name, ct.name, ct.push_name) AS name
        FROM chats c
        LEFT JOIN contacts ct ON ct.jid = c.jid
       WHERE c.jid IN (SELECT value FROM json_each(?))
       ORDER BY (COALESCE(c.name, ct.name, ct.push_name) IS NOT NULL) DESC
       LIMIT 1
    `)
    .get(aliases) as { name: string | null } | undefined;
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
        return done(getSyncStatus(deps.db, deps.connected(), deps.health?.()));

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
        // Check the connection BEFORE consuming the draft. take() is destructive, so
        // failing after it would burn the draft and make the retry answer "already
        // sent" — the one answer you must not give about a message to a real person.
        if (!deps.connected()) return fail("WhatsApp desconectado — nada foi enviado.");
        const draft = deps.drafts.take(c.draftId);
        if (!draft) {
          return fail("rascunho inexistente, já enviado ou vencido (10 min). Redija de novo com draft_message.");
        }
        const msgId = await deps.sender.sendText(draft.jid, draft.text);
        return done({ sent: true, msgId, jid: draft.jid });
      }

      case "react": {
        if (typeof c.jid !== "string" || typeof c.msgId !== "string" || typeof c.emoji !== "string") {
          return fail("react exige jid, msgId e emoji");
        }
        if (!isSingleEmoji(c.emoji)) return fail("emoji inválido: passe um único emoji (ou vazio para remover).");
        if (!deps.sender.sendReaction) return fail("reação indisponível neste daemon.");
        if (!deps.connected()) return fail("WhatsApp desconectado — a reação não foi enviada.");
        // Same rule as the media tools: resolve through every alias of the chat, and
        // read from_me/sender from the stored row so the caller cannot forge the key.
        const id = resolveMsgId(deps.db, c.jid, c.msgId);
        if ("error" in id) return fail(id.error);
        const row = deps.db
          .prepare("SELECT from_me, sender_jid FROM messages WHERE chat_jid = ? AND msg_id = ? LIMIT 1")
          .get(id.chatJid, id.msgId) as { from_me: number; sender_jid: string | null } | undefined;
        if (!row) return fail(`não achei a mensagem ${c.msgId} em ${c.jid}.`);
        const fromMe = row.from_me === 1;
        const isGroup = id.chatJid.endsWith("@g.us");
        if (isGroup && !fromMe && !row.sender_jid) {
          return fail("não sei quem enviou essa mensagem do grupo; sem isso a reação iria para a mensagem errada.");
        }
        await deps.sender.sendReaction(
          id.chatJid,
          { id: id.msgId, fromMe, participant: isGroup && !fromMe ? row.sender_jid! : undefined },
          c.emoji,
        );
        return done({ reacted: true, jid: id.chatJid, msgId: id.msgId, emoji: c.emoji });
      }

      case "backfill": {
        if (typeof c.jid !== "string") return fail("backfill exige jid");
        if (!deps.connected()) return fail("WhatsApp desconectado — backfill indisponível.");
        const pages = Number.isInteger(c.pages) && c.pages > 0 ? Math.min(c.pages, MAX_BACKFILL_PAGES) : 1;
        const outcome = await deps.sender.fetchOlder(c.jid, pages);
        setMeta(deps.db, "last_backfill_at", String(Math.floor(Date.now() / 1000)));
        return done({ fetched: outcome.asked, stopped: outcome.stopped });
      }

      case "transcribe": {
        if (typeof c.jid !== "string" || typeof c.msgId !== "string") {
          return fail("transcribe exige jid e msgId");
        }
        // msgId alone identifies nothing: the uniqueness constraint is
        // (chat_jid, msg_id), so without the jid this could transcribe the wrong
        // person's message and hand back their words.
        if (!deps.transcriber) {
          return fail(
            "transcrição indisponível: o daemon subiu sem o motor de transcrição. Veja whatsapp_status.",
          );
        }
        const id = resolveMsgId(deps.db, c.jid, c.msgId);
        if ("error" in id) return fail(id.error);
        const res = await deps.transcriber.request(id.chatJid, id.msgId, c.force === true);
        if (res.state === "rejected") return fail(res.error);
        return done(res);
      }

      case "download_image": {
        if (typeof c.jid !== "string" || typeof c.msgId !== "string") {
          return fail("download_image exige jid e msgId");
        }
        if (!deps.images) return fail("download de imagem indisponível neste daemon.");
        const id = resolveMsgId(deps.db, c.jid, c.msgId);
        if ("error" in id) return fail(id.error);
        const res = await saveImage(deps.db, deps.images.fetcher, deps.images.dir, id.chatJid, id.msgId);
        return res.ok ? done(res.image) : fail(res.error);
      }

      case "download_document": {
        if (typeof c.jid !== "string" || typeof c.msgId !== "string") {
          return fail("download_document exige jid e msgId");
        }
        if (!deps.documents) return fail("download de documento indisponível neste daemon.");
        const id = resolveMsgId(deps.db, c.jid, c.msgId);
        if ("error" in id) return fail(id.error);
        const res = await saveDocument(deps.db, deps.documents.fetcher, deps.documents.dir, id.chatJid, id.msgId);
        return res.ok ? done(res.document) : fail(res.error);
      }

      default:
        return fail(`comando desconhecido: ${c.cmd}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
