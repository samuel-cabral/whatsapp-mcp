import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import type { DB } from "../shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, ingestGroupSubjects, setMeta } from "./ingest.js";
import { planBackfill } from "./backfill.js";
import type { Sender } from "./control.js";

export interface WhatsAppConnection extends Sender {
  isConnected(): boolean;
  close(): Promise<void>;
}

/**
 * Everything WhatsApp-specific is confined to this file. The rest of the system
 * talks to the Sender interface, which is what keeps a future migration to the
 * official Cloud API from touching tools, schema, or queries.
 */
export async function createConnection(opts: {
  authDir: string;
  db: DB;
  onQr?: (qr: string) => void;
}): Promise<WhatsAppConnection> {
  const { db } = opts;
  const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);

  let sock: WASocket;
  let connected = false;
  let closing = false;
  let backoffMs = 1_000;

  /**
   * Group subjects never come down the history sync — only the participant list
   * does — so the only way to learn them is to ask once the socket is up.
   * Failure here is not fatal: it costs names, not messages.
   */
  const syncGroupSubjects = async (): Promise<void> => {
    try {
      const all = await sock.groupFetchAllParticipating();
      const n = ingestGroupSubjects(db, Object.values(all ?? {}));
      console.error(`[whatsapp-daemon] nome de ${n} grupos atualizado.`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[whatsapp-daemon] não deu para buscar o nome dos grupos: ${why}`);
    }
  };

  const start = (): void => {
    sock = makeWASocket({ auth: state, syncFullHistory: true });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (u.qr) {
        (opts.onQr ?? ((qr: string) => qrcode.generate(qr, { small: true })))(u.qr);
      }
      if (u.connection === "open") {
        connected = true;
        backoffMs = 1_000;
        setMeta(db, "last_connected_at", String(Math.floor(Date.now() / 1000)));
        console.error("[whatsapp-daemon] conectado.");
        void syncGroupSubjects();
      }
      if (u.connection === "close") {
        connected = false;
        const status = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          console.error("[whatsapp-daemon] sessão encerrada no celular. Apague ~/.whatsapp-mcp/auth e pareie de novo.");
          return;
        }
        if (closing) return;
        console.error(`[whatsapp-daemon] desconectado (${status}); reconectando em ${backoffMs}ms.`);
        setTimeout(start, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    });

    sock.ev.on("messaging-history.set", ({ messages, chats, contacts, isLatest }) => {
      ingestChats(db, chats ?? []);
      ingestContacts(db, contacts ?? []);
      const n = ingestMessages(db, messages ?? []);
      console.error(`[whatsapp-daemon] history: +${n} mensagens${isLatest ? " (último lote)" : ""}`);
      if (isLatest) setMeta(db, "initial_sync_done", "1");
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      ingestMessages(db, messages ?? []);
    });

    sock.ev.on("chats.upsert", (chats) => ingestChats(db, chats ?? []));
    sock.ev.on("contacts.upsert", (contacts) => ingestContacts(db, contacts ?? []));
    // upsert only fires for contacts we have never seen; update is where the
    // address book actually lands, and it arrives as a partial — which is why
    // ingestContacts coalesces instead of overwriting with null.
    sock.ev.on("contacts.update", (updates) => ingestContacts(db, updates ?? []));
    sock.ev.on("groups.upsert", (groups) => ingestGroupSubjects(db, groups ?? []));
    sock.ev.on("groups.update", (groups) => ingestGroupSubjects(db, groups ?? []));
  };

  start();

  return {
    isConnected: () => connected,

    async sendText(jid: string, text: string): Promise<string> {
      const sent = await sock.sendMessage(jid, { text });
      if (sent) ingestMessages(db, [sent]);
      return sent?.key?.id ?? "";
    },

    async fetchOlder(jid: string, pages: number): Promise<number> {
      // Results arrive asynchronously through messaging-history.set; this only
      // asks. The caller learns the outcome from the growing message count.
      let asked = 0;
      for (let i = 0; i < pages; i++) {
        const cursor = planBackfill(db, jid);
        if (!cursor) break;
        await sock.fetchMessageHistory(50, { remoteJid: jid, id: cursor.msgId, fromMe: false }, cursor.ts);
        asked += 50;
        await new Promise((r) => setTimeout(r, 1_500)); // human-paced, avoids tripping rate limits
      }
      return asked;
    },

    async close(): Promise<void> {
      closing = true;
      connected = false;
      sock.end(undefined);
    },
  };
}
