import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, setMeta } from "../src/daemon/ingest.js";
import { createServer } from "../src/mcp/index.js";

const IGOR = "5511999@s.whatsapp.net";

async function connectClient(db: DB) {
  const server = createServer({ db, client: { send: async () => ({ ok: true, result: {} }) } as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ingestChats(db, [{ id: IGOR, name: "Igor", unreadCount: 1 }]);
  ingestMessages(db, [
    { key: { remoteJid: IGOR, fromMe: false, id: "M1" }, messageTimestamp: 1000, message: { conversation: "bora marcar a reunião" } },
  ]);
});

function textOf(res: any): string {
  return res.content.map((c: any) => c.text).join("\n");
}

describe("tools de leitura", () => {
  it("expõe as oito tools", async () => {
    const client = await connectClient(db);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "backfill_chat", "confirm_send", "draft_message", "get_contact",
      "list_chats", "read_messages", "search_messages", "whatsapp_status",
    ]);
  });

  it("list_chats traz o chat com não-lidas", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "list_chats", arguments: { onlyUnread: true } });
    expect(textOf(res)).toContain("Igor");
  });

  it("search_messages encontra sem acento", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "search_messages", arguments: { query: "reuniao" } });
    expect(textOf(res)).toContain("reunião");
  });

  it("avisa que o sync está incompleto", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "search_messages", arguments: { query: "reuniao" } });
    expect(textOf(res)).toMatch(/sincroniza/i);
  });

  it("não avisa quando o sync terminou", async () => {
    setMeta(db, "initial_sync_done", "1");
    const client = await connectClient(db);
    const res = await client.callTool({ name: "search_messages", arguments: { query: "reuniao" } });
    expect(textOf(res)).not.toMatch(/sincroniza/i);
  });

  it("read_messages com jid inexistente devolve vazio explícito, não erro mudo", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "read_messages", arguments: { jid: "nada@s.whatsapp.net" } });
    expect(textOf(res)).toMatch(/nenhuma mensagem/i);
  });
});
