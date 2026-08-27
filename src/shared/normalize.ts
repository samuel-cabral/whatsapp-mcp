import { normalizeJid, isGroupJid } from "./jid.js";
import type { MessageRow, MessageType } from "./types.js";

/**
 * Baileys returns timestamps as number, Long, or numeric string depending on the
 * path. Every branch is funnelled through the same finiteness check because
 * `timestamp` is NOT NULL: a NaN binds as NULL, and since ingestMessages runs
 * inside db.transaction, one malformed message would roll back the whole batch.
 */
function toEpochSeconds(value: unknown): number | null {
  const n =
    typeof value === "number" ? value
    : typeof value === "string" && value !== "" ? Number(value)
    : value && typeof value === "object" && "low" in (value as any) ? Number((value as any).low)
    : null;
  return n !== null && Number.isFinite(n) ? n : null;
}

/**
 * Disappearing messages, view-once and captioned documents do not replace the
 * content — they wrap it one level down. Reading only the outer envelope threw the
 * real message away and filed it as type "other" with no text.
 */
const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "protocolMessage",
] as const;

function unwrap(message: Record<string, any>): Record<string, any> {
  let current = message;
  // Bounded because these can legitimately nest (an edited view-once, say), and an
  // unbounded loop over attacker-shaped input is not worth the elegance.
  for (let depth = 0; depth < 5; depth++) {
    const key = WRAPPERS.find((k) => current?.[k]?.message);
    if (!key) break;
    current = current[key].message;
  }
  return current;
}

const MEDIA: Array<[string, MessageType]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "location"],
  ["contactMessage", "contact"],
];

/**
 * Media binaries are deliberately not downloaded: type + caption is enough for
 * summarizing, searching and triage, and it keeps the store small.
 */
function classify(outer: Record<string, any>): { type: MessageType; text: string | null; quotedId: string | null } {
  const message = unwrap(outer);
  if (typeof message.conversation === "string") {
    return { type: "text", text: message.conversation, quotedId: null };
  }
  const ext = message.extendedTextMessage;
  if (ext) {
    return { type: "text", text: ext.text ?? null, quotedId: ext.contextInfo?.stanzaId ?? null };
  }
  for (const [key, type] of MEDIA) {
    const node = message[key];
    if (node) {
      return { type, text: node.caption ?? node.fileName ?? null, quotedId: node.contextInfo?.stanzaId ?? null };
    }
  }
  return { type: "other", text: null, quotedId: null };
}

export function toMessageRow(msg: unknown): MessageRow | null {
  const m = msg as any;
  const remoteJid = m?.key?.remoteJid;
  const msgId = m?.key?.id;
  if (!remoteJid || !msgId || !m?.message) return null;

  const timestamp = toEpochSeconds(m.messageTimestamp);
  if (timestamp === null) return null;

  const chatJid = normalizeJid(remoteJid);
  const fromMe = m.key.fromMe === true;
  const sender = isGroupJid(chatJid)
    ? (m.key.participant ? normalizeJid(m.key.participant) : null)
    : (fromMe ? null : chatJid);

  const { type, text, quotedId } = classify(m.message);

  return {
    chat_jid: chatJid,
    msg_id: String(msgId),
    sender_jid: sender,
    from_me: fromMe ? 1 : 0,
    timestamp,
    type,
    text,
    quoted_id: quotedId,
  };
}
