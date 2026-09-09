import { normalizeJid, isGroupJid } from "./jid.js";
import type { AudioRef, MessageRow, MessageType } from "./types.js";

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

/**
 * Base64 for whatever protobuf handed us. mediaKey and the hashes come through as
 * Uint8Array on a live message and as a base64 string on a re-decoded one, and only
 * the string survives the round-trip through media_ref.
 */
function toBase64(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (value instanceof Uint8Array) return value.length ? Buffer.from(value).toString("base64") : null;
  return null;
}

/**
 * The download descriptor for a voice note, or null for everything else.
 *
 * `ptt` is the gate that separates a voice note from a forwarded mp3: classify()
 * maps every audioMessage to type 'audio', and transcribing an hour of music is the
 * worst case this feature has. Without mediaKey or directPath there is nothing to
 * download later, so those are required too.
 *
 * Goes through the same unwrap() as classify, so a voice note inside an
 * ephemeralMessage or a viewOnceMessage counts.
 */
export function toAudioRef(msg: unknown): AudioRef | null {
  const message = (msg as any)?.message;
  if (!message) return null;

  const node = unwrap(message)?.audioMessage;
  if (!node || node.ptt !== true) return null;

  const mediaKey = toBase64(node.mediaKey);
  const directPath = typeof node.directPath === "string" ? node.directPath : null;
  if (!mediaKey || !directPath) return null;

  const seconds = Number(node.seconds);
  return {
    mediaKey,
    directPath,
    mimetype: typeof node.mimetype === "string" ? node.mimetype : "audio/ogg; codecs=opus",
    // The sender writes this field, so it is a hint, not a measurement. It only ever
    // feeds the timeout budget, and a missing one degrades to 0, i.e. the floor.
    seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0,
  };
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
