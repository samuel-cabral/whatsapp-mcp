import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../shared/migrations.js";
import type { ImageRef } from "../shared/types.js";

/**
 * Fetches the bytes of one image. Declared here and implemented in socket.ts, like
 * MediaFetcher, so Baileys stays imported in exactly one file.
 */
export interface ImageFetcher {
  fetchImage(ref: ImageRef): Promise<Buffer>;
}

/**
 * Below this, a prefix is too short to trust as a name. Message ids are 20+ hex
 * characters and render.ts shows 12, so 8 leaves room without inviting collisions.
 */
const MIN_PREFIX = 8;

/**
 * Turns what the model has into the full msg_id of one message in that chat.
 *
 * read_messages shows ids cut at 12 characters with a trailing "…", and that cut id is
 * what the model copies into the next tool call. Accepting it here is cheaper than
 * teaching every caller to go find the full one. The match stays inside the chat —
 * the store's uniqueness is (chat_jid, msg_id) — and an ambiguous prefix is refused
 * rather than guessed, because the wrong match hands back somebody else's message.
 */
export function resolveMsgId(
  db: DB,
  chatJid: string,
  given: string,
): { msgId: string } | { error: string } {
  const id = given.trim().replace(/(…|\.\.\.)$/, "");
  const exact = db.prepare("SELECT 1 FROM messages WHERE chat_jid = ? AND msg_id = ?").get(chatJid, id);
  if (exact) return { msgId: id };

  // Ids are alphanumeric; anything else is not a prefix we know how to match safely
  // (a % or _ would turn LIKE into a wildcard).
  if (id.length < MIN_PREFIX || !/^[A-Za-z0-9]+$/.test(id)) {
    return { error: `não achei a mensagem ${given} em ${chatJid}.` };
  }
  const rows = db
    .prepare("SELECT msg_id FROM messages WHERE chat_jid = ? AND msg_id LIKE ? LIMIT 2")
    .all(chatJid, `${id}%`) as Array<{ msg_id: string }>;
  if (rows.length === 1) return { msgId: rows[0].msg_id };
  if (rows.length > 1) return { error: `o id ${given} é ambíguo nessa conversa; passe o id completo.` };
  return { error: `não achei a mensagem ${given} em ${chatJid}.` };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type SavedImage = { path: string; mimetype: string; bytes: number };

/**
 * Downloads one image to mediaDir and returns where it landed.
 *
 * The file is named after the message, so asking twice returns the copy already on
 * disk instead of downloading again — and keeps working after WhatsApp stops serving
 * the original. It is written beside its final name and renamed into place, so a
 * crash mid-write never leaves a truncated image that the cache would then trust.
 */
export async function saveImage(
  db: DB,
  fetcher: ImageFetcher,
  mediaDir: string,
  chatJid: string,
  msgId: string,
): Promise<{ ok: true; image: SavedImage } | { ok: false; error: string }> {
  const row = db
    .prepare("SELECT type, media_ref FROM messages WHERE chat_jid = ? AND msg_id = ?")
    .get(chatJid, msgId) as { type: string; media_ref: string | null } | undefined;

  if (!row) return { ok: false, error: `não achei a mensagem ${msgId} em ${chatJid}.` };
  if (row.type !== "image") return { ok: false, error: `essa mensagem não é uma imagem (é ${row.type}).` };
  if (!row.media_ref) {
    return {
      ok: false,
      error:
        "o daemon não guardou o descritor de mídia dessa imagem: ela chegou antes de ele passar a guardar. " +
          "Só dá para baixar o que chegar daqui para frente; veja no celular.",
    };
  }

  let ref: ImageRef;
  try {
    ref = JSON.parse(row.media_ref) as ImageRef;
  } catch {
    return { ok: false, error: "descritor de mídia ilegível." };
  }

  const mimetype = ref.mimetype.split(";")[0].trim().toLowerCase();
  // msg_id comes from WhatsApp, so it is sanitised before it becomes a file name.
  const name = `${msgId.replace(/[^A-Za-z0-9_-]/g, "_")}.${EXT[mimetype] ?? "bin"}`;
  const path = join(mediaDir, name);

  if (existsSync(path)) {
    return { ok: true, image: { path, mimetype, bytes: statSync(path).size } };
  }

  let bytes: Buffer;
  try {
    bytes = await fetcher.fetchImage(ref);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /\b(404|410)\b/.test(why) ? "o WhatsApp não serve mais essa imagem." : `download falhou: ${why}`,
    };
  }
  if (bytes.length === 0) return { ok: false, error: "download veio vazio." };

  const part = `${path}.part`;
  writeFileSync(part, bytes, { mode: 0o600 });
  renameSync(part, path);
  return { ok: true, image: { path, mimetype, bytes: bytes.length } };
}
