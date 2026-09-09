import type { InboundAssessment } from "./health.js";
export type MessageType =
  | "text" | "image" | "video" | "audio"
  | "document" | "sticker" | "location" | "contact" | "other";

export interface MessageRow {
  chat_jid: string;
  msg_id: string;
  sender_jid: string | null;
  from_me: 0 | 1;
  timestamp: number;
  type: MessageType;
  text: string | null;
  quoted_id: string | null;
}

/**
 * What downloadContentFromMessage needs to fetch one voice note again.
 *
 * mediaKey is base64 because it arrives as a Uint8Array, and JSON.stringify of a
 * Uint8Array is `{"0":12,...}`, which does not round-trip. getMediaKeys accepts the
 * base64 string directly, so it stays a string the whole way down.
 *
 * No `url`, and no file hashes or length: downloadContentFromMessage prefers any url
 * on mmg.whatsapp.net over directPath, and that url expires — keeping it would mean
 * the directPath, the only reason this record exists, is never used. The hashes are
 * never read, and fileLength arrives as a Long, which would need the same funnel
 * toEpochSeconds already has.
 */
export interface AudioRef {
  mediaKey: string;
  directPath: string;
  mimetype: string;
  seconds: number;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: 0 | 1;
  last_message_at: number | null;
  unread_count: number;
  archived: 0 | 1;
}

export interface ContactRow {
  jid: string;
  name: string | null;
  push_name: string | null;
}

export interface SyncStatus {
  connected: boolean;
  initialSyncDone: boolean;
  messageCount: number;
  chatCount: number;
  lastConnectedAt: number | null;
  /** Newest message we actually received and could read. */
  lastInboundAt: number | null;
  /** Wall clock of the last inbound write — diverges from lastInboundAt when a backlog drains. */
  lastInboundIngestAt: number | null;
  inbound: InboundAssessment;
  transcription: TranscriptionStatus;
}

/** What whatsapp_status can say about the transcription subsystem. */
export interface TranscriptionStatus {
  /** False when the preflight could not find ffmpeg, whisper-cli or the model. */
  engineOk: boolean;
  engineError: string | null;
  pending: number;
  failed: number;
}

/** Commands accepted by the daemon's control socket. */
export type ControlCommand =
  | { cmd: "draft"; jid: string; text: string }
  | { cmd: "confirm"; draftId: string }
  | { cmd: "backfill"; jid: string; pages: number }
  | { cmd: "transcribe"; jid: string; msgId: string; force: boolean }
  | { cmd: "status" };

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };
