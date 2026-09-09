#!/usr/bin/env node
/**
 * whatsapp-daemon — owns the WhatsApp connection, the database, and the drafts.
 * It is the only process that writes anything.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolvePaths, ensureDirs, sweepTmp } from "../shared/paths.js";
import { openWritableDb } from "../shared/db.js";
import { loadConfig, type Config } from "../shared/config.js";
import { createConnection } from "./socket.js";
import { DraftStore } from "./drafts.js";
import { startControlServer } from "./server.js";
import { createAudioQueue, recoverRunning } from "./audio-queue.js";
import { setMeta } from "./ingest.js";
import type { DB } from "../shared/migrations.js";

/**
 * Checks the transcription toolchain before connecting.
 *
 * Absolute paths are not a style choice: launchd hands this process a PATH of
 * /usr/bin:/bin:/usr/sbin:/sbin, so a bare `whisper-cli` resolves fine in a terminal
 * and fails every single time as a service. Finding that out at boot, and saying so in
 * whatsapp_status, is much cheaper than finding out one voice note at a time.
 *
 * A missing binary disables transcription and nothing else. The daemon's real job is
 * receiving messages, and refusing to start over a missing audio decoder would trade a
 * degraded feature for a total outage.
 */
async function preflight(db: DB, cfg: Config): Promise<boolean> {
  const problems: string[] = [];
  for (const [label, bin] of [["ffmpeg", cfg.ffmpegBin], ["whisper-cli", cfg.whisperBin]] as const) {
    try {
      await access(bin, constants.X_OK);
    } catch {
      problems.push(`${label} não encontrado ou sem permissão de execução em ${bin}`);
    }
  }
  try {
    const st = await stat(cfg.whisperModel);
    if (!st.isFile()) problems.push(`o modelo ${cfg.whisperModel} não é um arquivo`);
  } catch {
    problems.push(`modelo não encontrado em ${cfg.whisperModel}`);
  }

  const ok = problems.length === 0;
  setMeta(db, "transcription_engine_ok", ok ? "1" : "0");
  setMeta(db, "transcription_engine_error", ok ? "" : problems.join("; "));
  console.error(
    ok
      ? `[whatsapp-daemon] transcrição de áudio ativa (${cfg.whisperModel}, idioma ${cfg.whisperLanguage}).`
      : `[whatsapp-daemon] transcrição de áudio DESLIGADA: ${problems.join("; ")}`,
  );
  return ok;
}

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);
  sweepTmp(paths);

  const db = openWritableDb(paths.dbFile);
  const drafts = new DraftStore();
  const cfg = loadConfig(paths.configFile);

  const engineOk = await preflight(db, cfg);

  const orphans = recoverRunning(db);
  if (orphans > 0) console.error(`[whatsapp-daemon] ${orphans} transcrição(ões) órfã(s) devolvida(s) à fila.`);

  console.error("[whatsapp-daemon] conectando ao WhatsApp. Se aparecer um QR, leia com o celular.");
  // Declared before the connection so the upsert handler can close over it, and
  // assigned right after, because the queue needs the connection to fetch media.
  let wake = (): void => {};
  const conn = await createConnection({
    authDir: paths.authDir,
    db,
    onAudioEnqueued: () => wake(),
  });

  const queue = engineOk
    ? createAudioQueue({ db, fetcher: conn, cfg: { ...cfg, tmpRoot: paths.tmpDir } })
    : null;
  if (queue) {
    wake = () => queue.wake();
    void queue.pump(); // drain whatever survived the last shutdown
  }

  const server = await startControlServer({
    socketFile: paths.socketFile,
    deps: {
      db,
      drafts,
      sender: conn,
      connected: () => conn.isConnected(),
      health: () => conn.health(),
      transcriber: queue ?? undefined,
    },
  });

  console.error(`[whatsapp-daemon] ouvindo em ${paths.socketFile}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[whatsapp-daemon] ${signal}, encerrando.`);
    queue?.stop();
    await server.close().catch(() => {});
    await conn.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[whatsapp-daemon] erro fatal:", err);
  process.exit(1);
});
