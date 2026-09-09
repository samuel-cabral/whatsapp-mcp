import type { DB } from "../shared/migrations.js";
import type { AudioRef } from "../shared/types.js";
import type { Config } from "../shared/config.js";
import { transcribeAudio, type TranscribeOutcome } from "./transcribe.js";
import { setMeta } from "./ingest.js";

/**
 * Fetches the bytes of one voice note. Declared here and implemented in socket.ts for
 * the same reason Sender exists: Baileys stays imported in exactly one file, so a
 * future move to the official Cloud API does not reach into the queue.
 */
export interface MediaFetcher {
  fetchAudio(ref: AudioRef): Promise<Buffer>;
}

/**
 * One at a time, and this is not a placeholder.
 *
 * Measured on this M1: two whisper processes took 8,2 s each against 3,5 s for one
 * alone — they serialise on the GPU rather than sharing it — while doubling a peak of
 * roughly 800 MB of RSS on a machine with 8 GB that is also running the daemon and a
 * browser. At ~17 notes a day, a serial worker spends under two minutes of GPU per
 * day. The headroom is more than an order of magnitude.
 */
export const MAX_CONCURRENCY = 1;

/** The safety net's cadence. Also the clock that expires the breaker and the pause. */
export const TICK_MS = 15_000;

/** How long the worker stays down after the environment turns out to be broken. */
export const HALT_MS = 10 * 60_000;

/** A failure that is not permanent gets this many shots before it sticks. */
export const MAX_ATTEMPTS = 3;

export const PAUSE_AFTER_FAILURE_MS = 5_000;

interface PendingRow {
  id: number;
  chat_jid: string;
  msg_id: string;
  media_ref: string;
}

export type RequestResult =
  | { state: "done"; text: string }
  | { state: "failed"; error: string }
  | { state: "running" }
  | { state: "rejected"; error: string };

export interface AudioQueue {
  /** Fast path: called right after an ingest queued something. */
  wake(): void;
  stop(): void;
  /** Drains until nothing is pending. Exposed for tests and for the boot drain. */
  pump(): Promise<void>;
  /** The manual tool: transcribe one specific note, and wait a while for the answer. */
  request(chatJid: string, msgId: string, force: boolean, waitMs?: number): Promise<RequestResult>;
}

/** How long the manual tool waits for a verdict before answering "still going". */
export const REQUEST_WAIT_MS = 20_000;

export interface QueueDeps {
  db: DB;
  fetcher: MediaFetcher;
  cfg: Config & { tmpRoot: string };
  /** Injected so tests can drive the pipeline without a 547 MB model. */
  transcribe?: typeof transcribeAudio;
  log?: (msg: string) => void;
  /** Cooldown after a failed job, so a bad note cannot spin the worker against the
   *  network or the GPU at full speed. Injectable because the real five seconds are
   *  longer than a test has patience for. */
  pauseAfterFailureMs?: number;
}

/**
 * Hands `running` rows back to `pending`.
 *
 * A single instance owns this database, so a row still marked `running` at boot is by
 * definition an orphan of a process that died mid-job. No attempt is charged for it:
 * SIGTERM in the middle of a transcription is what every `launchctl kickstart` does,
 * and billing the message for the restart would burn a note's three attempts over
 * three deploys.
 */
export function recoverRunning(db: DB): number {
  return db.prepare("UPDATE messages SET transcript_status = 'pending' WHERE transcript_status = 'running'")
    .run().changes;
}

export function createAudioQueue(deps: QueueDeps): AudioQueue {
  const { db, fetcher, cfg } = deps;
  const transcribe = deps.transcribe ?? transcribeAudio;
  const pauseMs = deps.pauseAfterFailureMs ?? PAUSE_AFTER_FAILURE_MS;
  const log = deps.log ?? ((m: string) => console.error(`[whatsapp-daemon] ${m}`));

  let running = false;
  let stopped = false;
  let haltedUntil = 0;
  let haltLogged = false;
  let timer: NodeJS.Timeout | null = null;

  const takeNext = db.prepare(`
    SELECT id, chat_jid, msg_id, media_ref
      FROM messages
     WHERE transcript_status = 'pending'
     ORDER BY timestamp
     LIMIT 1
  `);
  const markRunning = db.prepare("UPDATE messages SET transcript_status = 'running' WHERE id = ?");
  const markDone = db.prepare(`
    UPDATE messages
       SET transcript = @text, transcript_status = 'done', transcript_at = @at, transcript_error = NULL
     WHERE id = @id
  `);
  const markFailed = db.prepare(`
    UPDATE messages
       SET transcript_status = @status,
           transcript_attempts = COALESCE(transcript_attempts, 0) + 1,
           transcript_error = @error,
           transcript_at = @at
     WHERE id = @id
  `);
  const requeue = db.prepare("UPDATE messages SET transcript_status = 'pending' WHERE id = ?");
  const attemptsOf = db.prepare("SELECT COALESCE(transcript_attempts, 0) AS n FROM messages WHERE id = ?");

  const now = (): number => Math.floor(Date.now() / 1000);

  const record = (row: PendingRow, outcome: TranscribeOutcome, startedAt: number): void => {
    if (outcome.status === "environment") {
      // Not the message's fault. The job goes back to the queue without spending an
      // attempt — charging thousands of messages for a binary Homebrew moved would
      // turn an install problem into a wall of permanent failures — and the worker
      // stands down so the log does not fill with the same line.
      requeue.run(row.id);
      haltedUntil = Date.now() + HALT_MS;
      setMeta(db, "transcription_engine_ok", "0");
      setMeta(db, "transcription_engine_error", outcome.reason);
      if (!haltLogged) {
        log(`transcrição parada por ${Math.round(HALT_MS / 60_000)} min: ${outcome.reason}`);
        haltLogged = true;
      }
      return;
    }

    // Any successful round trip proves the environment works, whatever the verdict.
    haltLogged = false;
    setMeta(db, "transcription_engine_ok", "1");
    setMeta(db, "transcription_engine_error", "");

    if (outcome.status === "ok" || outcome.status === "empty") {
      // `empty` is stored as the empty string on purpose: it says "we listened and
      // there was no speech", which NULL — "nobody has tried" — cannot say.
      // media_ref is kept in both cases, because it is what lets transcribe_audio
      // reprocess a note later with force.
      markDone.run({ id: row.id, text: outcome.status === "ok" ? outcome.text : "", at: now() });
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(
        outcome.status === "ok"
          ? `transcrito em ${secs}s (${outcome.text.length} caracteres).`
          : `áudio sem fala reconhecida em ${secs}s: ${outcome.reason}`,
      );
      return;
    }

    const attempts = (attemptsOf.get(row.id) as { n: number }).n;
    const stick = outcome.permanent || attempts + 1 >= MAX_ATTEMPTS;
    markFailed.run({
      id: row.id,
      status: stick ? "failed" : "pending",
      error: outcome.reason,
      at: now(),
    });
    log(
      stick
        ? `transcrição falhou de vez (${row.msg_id}): ${outcome.reason}`
        : `transcrição falhou (${row.msg_id}), tentativa ${attempts + 1}/${MAX_ATTEMPTS}: ${outcome.reason}`,
    );
  };

  const step = async (row: PendingRow): Promise<boolean> => {
    const startedAt = Date.now();
    markRunning.run(row.id);

    let ref: AudioRef;
    try {
      ref = JSON.parse(row.media_ref) as AudioRef;
    } catch {
      record(row, { status: "failed", reason: "descritor de mídia ilegível", permanent: true }, startedAt);
      return false;
    }

    let bytes: Buffer;
    try {
      bytes = await fetcher.fetchAudio(ref);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // 404/410 means WhatsApp no longer serves this media, and without the reupload
      // path there is no second chance — retrying only burns attempts.
      const gone = /\b(404|410)\b/.test(why);
      record(
        row,
        { status: "failed", reason: gone ? "o WhatsApp não serve mais esse áudio" : `download falhou: ${why}`, permanent: gone },
        startedAt,
      );
      return false;
    }

    if (bytes.length === 0) {
      record(row, { status: "failed", reason: "download veio vazio", permanent: false }, startedAt);
      return false;
    }

    let outcome: TranscribeOutcome;
    try {
      outcome = await transcribe(bytes, cfg, ref.seconds);
    } catch (err) {
      outcome = { status: "failed", reason: err instanceof Error ? err.message : String(err), permanent: false };
    }
    record(row, outcome, startedAt);
    return outcome.status === "ok" || outcome.status === "empty";
  };

  /**
   * Drains the queue one note at a time. Re-entrant by the `running` flag rather than
   * by a lock, which is what keeps MAX_CONCURRENCY honest across wake() and the timer
   * firing at once.
   */
  const pump = async (): Promise<void> => {
    if (running || stopped) return;
    if (Date.now() < haltedUntil) return;
    running = true;
    try {
      for (;;) {
        if (stopped) return;
        const row = takeNext.get() as PendingRow | undefined;
        if (!row) return;
        const ok = await step(row);
        if (Date.now() < haltedUntil) return; // the environment broke mid-drain
        // A pause after a failure, so a bad job cannot spin the worker against the
        // network or the GPU at full speed.
        if (!ok) await new Promise((r) => setTimeout(r, pauseMs));
      }
    } finally {
      running = false;
    }
  };

  // The timer is the safety net, not the mechanism: wake() covers the normal path, but
  // without a clock a note that arrives through any future write path would sit as
  // `pending` until the next restart — which under launchd's KeepAlive means a reboot.
  // It is also what re-checks haltedUntil after the breaker trips.
  timer = setInterval(() => void pump(), TICK_MS);
  timer.unref();

  const findRow = db.prepare(`
    SELECT id, type, transcript, transcript_status, transcript_error, media_ref
      FROM messages WHERE chat_jid = ? AND msg_id = ?
  `);

  /**
   * Queues one note by name and waits for it.
   *
   * There is no priority column: the store takes about seventeen notes a day, so the
   * queue is essentially always empty and a priority field would be machinery with
   * nothing to order. What this does is make sure the row is `pending`, kick the
   * worker, and poll the row until it settles or the caller's patience runs out —
   * twenty seconds by default, comfortably under the control client's 30 s timeout.
   */
  const request = async (
    chatJid: string,
    msgId: string,
    force: boolean,
    waitMs = REQUEST_WAIT_MS,
  ): Promise<RequestResult> => {
    const row = findRow.get(chatJid, msgId) as
      | { id: number; type: string; transcript: string | null; transcript_status: string | null; transcript_error: string | null; media_ref: string | null }
      | undefined;

    if (!row) return { state: "rejected", error: `não achei a mensagem ${msgId} em ${chatJid}.` };
    if (row.type !== "audio") return { state: "rejected", error: "essa mensagem não é um áudio." };
    if (row.transcript_status === null || !row.media_ref) {
      return {
        state: "rejected",
        error:
          "esse áudio é anterior à transcrição automática, então o daemon não guardou a mídia dele. " +
          "Só dá para transcrever áudio recebido depois que a transcrição entrou.",
      };
    }
    if (row.transcript_status === "done" && !force) {
      return { state: "done", text: row.transcript ?? "" };
    }

    // force resets the attempt counter too: the point of asking again by hand is that
    // the previous verdict is not trusted, and inheriting two spent attempts would
    // give the retry one shot instead of three.
    db.prepare(
      "UPDATE messages SET transcript_status = 'pending', transcript_attempts = 0 WHERE id = ?",
    ).run(row.id);
    void pump();

    const deadline = Date.now() + waitMs;
    for (;;) {
      const cur = findRow.get(chatJid, msgId) as { transcript: string | null; transcript_status: string | null; transcript_error: string | null };
      if (cur.transcript_status === "done") return { state: "done", text: cur.transcript ?? "" };
      if (cur.transcript_status === "failed") return { state: "failed", error: cur.transcript_error ?? "motivo desconhecido" };
      if (Date.now() >= deadline) return { state: "running" };
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  return {
    wake: () => void pump(),
    pump,
    request,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
