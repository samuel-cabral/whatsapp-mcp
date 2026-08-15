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
}

/** Commands accepted by the daemon's control socket. */
export type ControlCommand =
  | { cmd: "draft"; jid: string; text: string }
  | { cmd: "confirm"; draftId: string }
  | { cmd: "backfill"; jid: string; pages: number }
  | { cmd: "status" };

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };
