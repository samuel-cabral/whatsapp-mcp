import type { InboundHealth } from "../shared/health.js";

/** proto.WebMessageInfo.StubType.CIPHERTEXT — the stub Baileys leaves behind when
 * decryption throws (Utils/decode-wa-message.js:184-188). The message still arrives
 * in messages.upsert; only its content is missing. */
const STUB_CIPHERTEXT = 2;

const HOUR_MS = 60 * 60_000;

export interface UpsertTally {
  decrypted: number;
  undecryptable: number;
  /** Newest timestamp among the messages we could actually read, in epoch seconds. */
  newestDecryptedTs: number | null;
  /** Who we failed to decrypt from, for targeted session renegotiation. */
  failingJids: string[];
}

/**
 * Splits an inbound batch into what we could read and what we could not. This is
 * the signal the daemon used to throw away: a message that fails to decrypt is not
 * missing, it is right there with `message` unset, and counting it is the whole
 * difference between "the world is quiet" and "we are deaf".
 */
export function tallyUpsert(messages: unknown[]): UpsertTally {
  const tally: UpsertTally = {
    decrypted: 0,
    undecryptable: 0,
    newestDecryptedTs: null,
    failingJids: [],
  };
  const failing = new Set<string>();

  for (const raw of messages) {
    const m = raw as any;
    if (m?.key?.fromMe) continue; // our own echo is not inbound

    if (m?.messageStubType === STUB_CIPHERTEXT || !m?.message) {
      tally.undecryptable++;
      const who = m?.key?.participant ?? m?.participant ?? m?.key?.remoteJid;
      if (typeof who === "string" && who) failing.add(who);
      continue;
    }

    tally.decrypted++;
    const ts = Number(m?.messageTimestamp);
    if (Number.isFinite(ts) && (tally.newestDecryptedTs === null || ts > tally.newestDecryptedTs)) {
      tally.newestDecryptedTs = ts;
    }
  }

  tally.failingJids = [...failing];
  return tally;
}

/**
 * A one-hour sliding window kept in memory. It lives in the daemon rather than in
 * SQLite because the control socket answers `status` from inside the daemon, so the
 * MCP process reaches these numbers without any of them touching disk.
 */
export class InboundHealthTracker {
  private decrypted: number[] = [];
  private undecryptable: number[] = [];
  private disconnects: number[] = [];
  private bufferingSince: number | null = null;

  recordUpsert(tally: UpsertTally, now = Date.now()): void {
    for (let i = 0; i < tally.decrypted; i++) this.decrypted.push(now);
    for (let i = 0; i < tally.undecryptable; i++) this.undecryptable.push(now);
  }

  recordDisconnect(now = Date.now()): void {
    this.disconnects.push(now);
  }

  /** Called by the flush watchdog on every tick, with what it observed. */
  recordBuffering(isBuffering: boolean, now = Date.now()): void {
    if (!isBuffering) this.bufferingSince = null;
    else this.bufferingSince ??= now;
  }

  snapshot(now = Date.now()): InboundHealth {
    const cutoff = now - HOUR_MS;
    // Entries are pushed in time order, so everything older than the cutoff is a
    // prefix: drop that prefix, keep the rest.
    const trim = (xs: number[]): number[] => {
      let i = 0;
      while (i < xs.length && xs[i] < cutoff) i++;
      if (i > 0) xs.splice(0, i);
      return xs;
    };
    this.decrypted = trim(this.decrypted);
    this.undecryptable = trim(this.undecryptable);
    this.disconnects = trim(this.disconnects);

    return {
      decryptedLastHour: this.decrypted.length,
      undecryptableLastHour: this.undecryptable.length,
      disconnectsLastHour: this.disconnects.length,
      bufferingSinceMs: this.bufferingSince === null ? null : now - this.bufferingSince,
    };
  }
}

/**
 * Decides who to force a fresh Signal session with, and refuses to ask about the
 * same peer twice in a row. assertSessions sends a pkmsg per device, so sweeping
 * every failing jid on every tick would be a traffic pattern worth throttling us for.
 */
export class SessionRepairQueue {
  private lastAsked = new Map<string, number>();
  private pending = new Set<string>();

  constructor(
    private readonly cooldownMs = 30 * 60_000,
    private readonly batchSize = 5,
  ) {}

  offer(jids: string[]): void {
    for (const jid of jids) this.pending.add(jid);
  }

  /** Next batch worth asking about, marking them asked. Empty when nothing is due. */
  take(now = Date.now()): string[] {
    const due: string[] = [];
    for (const jid of this.pending) {
      if (due.length >= this.batchSize) break;
      const last = this.lastAsked.get(jid);
      if (last !== undefined && now - last < this.cooldownMs) continue;
      due.push(jid);
    }
    for (const jid of due) {
      this.pending.delete(jid);
      this.lastAsked.set(jid, now);
    }
    return due;
  }
}
