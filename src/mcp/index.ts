#!/usr/bin/env node
/**
 * whatsapp-mcp — read-only view of the WhatsApp store, plus a two-step send.
 *
 * STDIO PROTOCOL RULE: stdout is the JSON-RPC channel. Never console.log here.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePaths } from "../shared/paths.js";
import { openReadonlyDb } from "../shared/db.js";
import { ControlClient } from "./client.js";
import { registerReadTools, type ToolContext } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export const SERVER_NAME = "whatsapp-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}

async function main(): Promise<void> {
  const paths = resolvePaths();

  let db;
  try {
    db = openReadonlyDb(paths.dbFile);
  } catch {
    console.error(
      `[${SERVER_NAME}] banco não encontrado em ${paths.dbFile}.\n` +
        "Suba o daemon primeiro: node build/daemon/index.js (ou carregue o serviço do launchd).",
    );
    process.exit(1);
  }

  const ctx: ToolContext = { db, client: new ControlClient(paths.socketFile) };
  const server = createServer(ctx);

  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} rodando em stdio (leitura somente do banco).`);
}

const isMain = (() => {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] erro fatal:`, err);
    process.exit(1);
  });
}
