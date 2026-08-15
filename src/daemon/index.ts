#!/usr/bin/env node
/**
 * whatsapp-daemon — owns the WhatsApp connection, the database, and the drafts.
 * It is the only process that writes anything.
 */
import { resolvePaths, ensureDirs } from "../shared/paths.js";
import { openWritableDb } from "../shared/db.js";
import { createConnection } from "./socket.js";
import { DraftStore } from "./drafts.js";
import { startControlServer } from "./server.js";

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);

  const db = openWritableDb(paths.dbFile);
  const drafts = new DraftStore();

  console.error("[whatsapp-daemon] conectando ao WhatsApp. Se aparecer um QR, leia com o celular.");
  const conn = await createConnection({ authDir: paths.authDir, db });

  const server = await startControlServer({
    socketFile: paths.socketFile,
    deps: { db, drafts, sender: conn, connected: () => conn.isConnected() },
  });

  console.error(`[whatsapp-daemon] ouvindo em ${paths.socketFile}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[whatsapp-daemon] ${signal}, encerrando.`);
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
