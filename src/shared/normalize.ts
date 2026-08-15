import { normalizeJid, isGroupJid } from "./jid.js";
import type { MessageRow, MessageType } from "./types.js";

/** Baileys returns timestamps as number, Long, or numeric string depending on the path. */
function toEpochSeconds(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  if (value && typeof value === "object" && "low" in (value as any)) {
    return Number((value as any).low);
  }
  return null;
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
function classify(message: Record<string, any>): { type: MessageType; text: string | null; quotedId: string | null } {
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
