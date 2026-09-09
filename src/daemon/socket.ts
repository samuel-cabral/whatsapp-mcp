import makeWASocket, {
  DisconnectReason,
  getBinaryNodeChild,
  S_WHATSAPP_NET,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import type { DB } from "../shared/migrations.js";
import {
  ingestMessages,
  ingestChats,
  ingestChatUpdates,
  ingestContacts,
  ingestGroupSubjects,
  recordHistoryProgress,
  markInboundIngested,
  setMeta,
} from "./ingest.js";
import { planBackfill } from "./backfill.js";
import { normalizeJid } from "../shared/jid.js";
import { makeTtlCache } from "../shared/ttl-cache.js";
import { InboundHealthTracker, SessionRepairQueue, tallyUpsert } from "./health.js";
import type { InboundHealth } from "../shared/health.js";
import type { Sender } from "./control.js";

export interface WhatsAppConnection extends Sender {
  isConnected(): boolean;
  health(): InboundHealth;
  close(): Promise<void>;
}

/** How many pre-keys to upload when the pool needs refilling. */
export const PREKEY_BATCH = 50;

/**
 * Refill below this. Baileys' own threshold is MIN_PREKEY_COUNT (5), and that is
 * the bug: a peer that wants to open a fresh Signal session takes one key from
 * the server's pool, and an account that settles just above 5 never refills. No
 * peer — not even our own phone — can then renegotiate, so every inbound message
 * dies as "Bad MAC" or "No session record".
 */
export const PREKEY_FLOOR = 25;

/** How often to look at the event buffer, and how long it may stay stuck. */
export const FLUSH_CHECK_MS = 5_000;
export const FLUSH_GRACE_MS = 30_000;

/**
 * Why this is a decision and not just an upload: uploadPreKeys mints brand new
 * keypairs on every call (getNextPreKeys advances firstUnuploadedPreKeyId, so
 * nothing is ever reused) and they only leave the disk when a peer consumes one.
 * Refilling unconditionally on each login grew ~/.whatsapp-mcp/auth by 50 files
 * per reconnect, and this daemon reconnects every ~30 minutes.
 *
 * A null count means the server did not tell us. Uploading is the safe answer
 * there: spending 50 keys costs disk, skipping one that was needed costs the
 * whole inbound stream.
 */
export function shouldReplenishPreKeys(onServer: number | null): boolean {
  return onServer === null || onServer < PREKEY_FLOOR;
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
  let flushTimer: NodeJS.Timeout | null = null;
  let bufferingSince: number | null = null;

  // Survives reconnects on purpose — see the note at makeWASocket.
  const msgRetryCounterCache = makeTtlCache(60 * 60_000);
  const healthTracker = new InboundHealthTracker();
  const repairQueue = new SessionRepairQueue();

  const stopFlushWatchdog = (): void => {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    bufferingSince = null;
  };

  /**
   * Answers a peer that asks us to resend. We keep text, not the original proto,
   * so only text can be rebuilt; anything else declines, which is still better
   * than Baileys' default of always returning undefined.
   */
  const getMessage = async (key: { remoteJid?: string | null; id?: string | null }) => {
    if (!key.remoteJid || !key.id) return undefined;
    const row = db
      .prepare("SELECT text FROM messages WHERE chat_jid = ? AND msg_id = ?")
      .get(normalizeJid(key.remoteJid), key.id) as { text: string | null } | undefined;
    return row?.text ? { conversation: row.text } : undefined;
  };

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

  /** Asks the server how many of our pre-keys are still in its pool. */
  const preKeysOnServer = async (): Promise<number | null> => {
    const res = await sock.query({
      tag: "iq",
      attrs: { id: sock.generateMessageTag(), xmlns: "encrypt", type: "get", to: S_WHATSAPP_NET },
      content: [{ tag: "count", attrs: {} }],
    });
    const raw = getBinaryNodeChild(res, "count")?.attrs?.value;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const replenishPreKeys = async (): Promise<void> => {
    try {
      const left = await preKeysOnServer();
      if (!shouldReplenishPreKeys(left)) {
        console.error(`[whatsapp-daemon] ${left} pre-keys no servidor, nada a repor.`);
        return;
      }
      await sock.uploadPreKeys(PREKEY_BATCH);
      console.error(
        `[whatsapp-daemon] ${PREKEY_BATCH} pre-keys enviadas (servidor tinha ${left ?? "?"}).`,
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[whatsapp-daemon] não deu para enviar pre-keys: ${why}`);
    }
  };

  /**
   * A session that fails with "Bad MAC" or "No session found" never heals on its
   * own: Baileys keeps trying the same broken record forever, and for a group the
   * damage compounds, because the sender key only ever arrives inside a 1:1 message
   * we managed to decrypt. assertSessions(force) throws the record away and fetches
   * a fresh bundle, which is the only thing that breaks that deadlock.
   *
   * Kept to small batches on a cooldown: it emits a pkmsg per device, and sweeping
   * every failing peer at once is a traffic pattern worth being throttled for.
   */
  const repairSessions = async (): Promise<void> => {
    if (!connected) return;
    const batch = repairQueue.take();
    if (!batch.length) return;
    try {
      await sock.assertSessions(batch, true);
      console.error(`[whatsapp-daemon] sessão renegociada com ${batch.length} peer(s).`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[whatsapp-daemon] não deu para renegociar sessão: ${why}`);
    }
  };

  /**
   * Baileys starts buffering events on the nextTick after login (Socket/socket.js:541)
   * and the ONLY thing that releases them is the `ib,,offline` node
   * (socket.js:547-556). A message that fails to decrypt gets a retry request but
   * no delivery receipt (messages-recv.js:651-670), so the server never closes the
   * offline batch and `ib,,offline` never comes. The buffer then swallows every
   * inbound event until the process dies — including newsletter channels, which do
   * not go through the same pairwise encryption path. Those going silent too is what
   * ruled out "it is only a key problem".
   *
   * That is how this store lost 47 hours: over that window the log carries 101
   * connections opened, 101 "offline preview received", and zero "handled N offline
   * messages". Draining on a timer costs nothing when the node does arrive, because
   * by then there is nothing buffered.
   */
  const startFlushWatchdog = (): void => {
    stopFlushWatchdog();
    flushTimer = setInterval(() => {
      const buffering = sock.ev.isBuffering();
      healthTracker.recordBuffering(buffering);
      void repairSessions();
      if (!buffering) {
        bufferingSince = null;
        return;
      }
      const now = Date.now();
      bufferingSince ??= now;
      const stuckMs = now - bufferingSince;
      if (stuckMs < FLUSH_GRACE_MS) return; // a healthy offline batch drains well inside this
      sock.ev.flush();
      console.error(
        `[whatsapp-daemon] buffer de eventos travado há ${Math.round(stuckMs / 1000)}s; liberado à força.`,
      );
      bufferingSince = null;
    }, FLUSH_CHECK_MS);
    flushTimer.unref();
  };

  const start = (): void => {
    sock = makeWASocket({
      auth: state,
      syncFullHistory: true,
      // Both caches must outlive the socket. Baileys builds a fresh NodeCache per
      // socket otherwise (messages-recv.js:19-23), so the retry counter resets to 1
      // on every reconnect and never trips the `retryCount > 1` gate that attaches
      // our identity and pre-key bundle (messages-recv.js:135). 2061 of 2232 retry
      // receipts in this log went out at retryCount=1, carrying nothing.
      msgRetryCounterCache,
      // Lets us answer a peer's retry request instead of dropping it: without this
      // Baileys defaults to `async () => undefined` (messages-recv.js:466).
      getMessage,
    });

    startFlushWatchdog();

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
        void replenishPreKeys();
      }
      if (u.connection === "close") {
        connected = false;
        healthTracker.recordDisconnect();
        stopFlushWatchdog();
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

    sock.ev.on("messaging-history.set", ({ messages, chats, contacts, progress }) => {
      ingestChats(db, chats ?? []);
      ingestContacts(db, contacts ?? []);
      const { written: n } = ingestMessages(db, messages ?? []);
      const done = recordHistoryProgress(db, { progress });
      const pct = typeof progress === "number" ? ` ${progress}%` : "";
      console.error(`[whatsapp-daemon] history: +${n} mensagens${pct}${done ? " (sync inicial completo)" : ""}`);
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      const batch = messages ?? [];
      ingestMessages(db, batch);

      // Counting has to happen here, not in ingest: a message that failed to
      // decrypt never becomes a row, so the database can never tell us it arrived.
      const tally = tallyUpsert(batch);
      healthTracker.recordUpsert(tally);
      if (tally.decrypted > 0) markInboundIngested(db);
      if (tally.failingJids.length) repairQueue.offer(tally.failingJids);
    });

    sock.ev.on("chats.upsert", (chats) => ingestChats(db, chats ?? []));
    // upsert carries an absolute unreadCount and only fires for chats we have
    // never seen; every later read/unread arrives here, as a delta.
    sock.ev.on("chats.update", (updates) => ingestChatUpdates(db, updates ?? []));
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
    health: () => healthTracker.snapshot(),

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
