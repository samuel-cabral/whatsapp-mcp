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
  it("expõe as nove tools", async () => {
    const client = await connectClient(db);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "backfill_chat", "confirm_send", "draft_message", "get_contact",
      "list_chats", "read_messages", "search_messages", "transcribe_audio", "whatsapp_status",
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

describe("fuso horário", () => {
  // 2026-08-25 11:40:16 em Fortaleza (UTC-3) é 14:40:16 em UTC. Mostrar o horário
  // em UTC faz toda conversa aparecer 3h no futuro para quem lê.
  const TS = 1787668816;
  const tzAround = async (tz: string, fn: () => Promise<string>) => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      return await fn();
    } finally {
      // Assigning undefined back would store the literal string "undefined", and
      // Node then silently falls back to UTC for every later test in this worker.
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  };

  it("read_messages mostra o horário local, não UTC", async () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "TZ1" }, messageTimestamp: TS, message: { conversation: "que horas sao" } },
    ]);
    const client = await connectClient(db);
    const out = await tzAround("America/Fortaleza", async () =>
      textOf(await client.callTool({ name: "read_messages", arguments: { jid: IGOR } })),
    );
    expect(out).toContain("2026-08-25 11:40");
    expect(out).not.toContain("2026-08-25 14:40");
  });

  it("acompanha o fuso da máquina", async () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "TZ2" }, messageTimestamp: TS, message: { conversation: "que horas sao" } },
    ]);
    const client = await connectClient(db);
    const out = await tzAround("UTC", async () =>
      textOf(await client.callTool({ name: "read_messages", arguments: { jid: IGOR } })),
    );
    expect(out).toContain("2026-08-25 14:40");
  });
});

describe("aviso de recebimento quebrado nas leituras", () => {
  // O apagão durou 47h em parte porque nada se oferecia para contar: só quem
  // chamasse whatsapp_status ficava sabendo. "Nada encontrado" e "paramos de
  // receber" são indistinguíveis de fora e levam a conclusões opostas.
  const semRecebidas = (db: DB) => {
    db.prepare("DELETE FROM messages WHERE from_me = 0").run();
    db.prepare("INSERT INTO meta (key,value) VALUES ('initial_sync_done','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  };

  it("read_messages avisa quando o recebimento está quebrado", async () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "OLD" }, messageTimestamp: 1787674849, message: { conversation: "antiga" } },
    ]);
    db.prepare("INSERT INTO meta (key,value) VALUES ('initial_sync_done','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const client = await connectClient(db);
    const out = textOf(await client.callTool({ name: "read_messages", arguments: { jid: IGOR } }));
    expect(out).toMatch(/recebimento está quebrado/);
  });

  it("não avisa nada quando o recebimento está em dia", async () => {
    ingestMessages(db, [
      {
        key: { remoteJid: IGOR, fromMe: false, id: "NOVA" },
        messageTimestamp: Math.floor(Date.now() / 1000) - 60,
        message: { conversation: "agorinha" },
      },
    ]);
    db.prepare("INSERT INTO meta (key,value) VALUES ('initial_sync_done','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const client = await connectClient(db);
    const out = textOf(await client.callTool({ name: "read_messages", arguments: { jid: IGOR } }));
    expect(out).not.toMatch(/quebrado|Pode haver mensagem faltando/);
  });

  it("o aviso também aparece quando a busca não acha nada", async () => {
    semRecebidas(db);
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "OLD2" }, messageTimestamp: 1787674849, message: { conversation: "antiga" } },
    ]);
    const client = await connectClient(db);
    const out = textOf(await client.callTool({ name: "search_messages", arguments: { query: "inexistente" } }));
    expect(out).toMatch(/recebimento está quebrado/);
  });
});

describe("como o áudio chega ao modelo", () => {
  const audio = (msgId: string, over: Record<string, unknown> = {}) => {
    db.prepare(
      "INSERT INTO messages (chat_jid, msg_id, timestamp, type, transcript, transcript_status, transcript_error, media_ref) " +
        "VALUES (@jid, @msgId, @ts, 'audio', @transcript, @status, @error, @ref)",
    ).run({
      jid: IGOR,
      msgId,
      ts: 2000,
      transcript: null,
      status: null,
      error: null,
      ref: null,
      ...over,
    });
  };

  const read = async () =>
    textOf(await (await connectClient(db)).callTool({ name: "read_messages", arguments: { jid: IGOR } }));

  it("transcrito aparece marcado como transcrição, não como texto digitado", async () => {
    audio("A1", { transcript: "bora marcar amanhã de manhã", status: "done", ref: "{}" });
    const out = await read();
    expect(out).toContain("(áudio, transcrito) bora marcar amanhã de manhã");
  });

  it("um áudio transcrito na resposta traz o aviso de que é máquina, uma vez só", async () => {
    audio("A1", { transcript: "primeiro", status: "done", ref: "{}" });
    audio("A2", { transcript: "segundo", status: "done", ref: "{}" });
    const out = await read();
    expect(out.match(/transcrição automática de máquina/g)).toHaveLength(1);
  });

  it("sem transcrição na resposta, não há aviso nenhum", async () => {
    const out = await read();
    expect(out).not.toContain("transcrição automática de máquina");
  });

  it("pendente diz que está transcrevendo e mostra o id para a tool manual", async () => {
    audio("PEND1", { status: "pending", ref: "{}" });
    const out = await read();
    expect(out).toContain("(áudio, transcrevendo, id PEND1)");
  });

  it("falha mostra o motivo, não um silêncio", async () => {
    audio("F1", { status: "failed", error: "o WhatsApp não serve mais esse áudio", ref: "{}" });
    expect(await read()).toContain("(áudio, transcrição falhou: o WhatsApp não serve mais esse áudio");
  });

  it("'ouvimos e não havia fala' não é confundido com 'ninguém tentou'", async () => {
    audio("E1", { transcript: "", status: "done", ref: "{}" });
    expect(await read()).toContain("(áudio, sem fala reconhecida)");
  });

  // The ~8.8k notes already in the store have no media descriptor, so nothing is
  // coming for them and the line must not promise otherwise.
  it("o áudio anterior à feature continua exatamente como era", async () => {
    audio("OLD1");
    const out = await read();
    expect(out).toContain("(audio)");
    expect(out).not.toContain("transcrevendo");
  });

  it("a busca acha palavra que só existe na transcrição", async () => {
    audio("S1", { transcript: "abacaxi e bicicleta", status: "done", ref: "{}" });
    const out = textOf(
      await (await connectClient(db)).callTool({ name: "search_messages", arguments: { query: "abacaxi" } }),
    );
    expect(out).toContain("(áudio, transcrito) abacaxi e bicicleta");
  });

  it("a conversa cujo último evento é voice note transcrito não aparece como (sem texto)", async () => {
    audio("L1", { transcript: "bora marcar", status: "done", ref: "{}" });
    const out = textOf(await (await connectClient(db)).callTool({ name: "list_chats", arguments: {} }));
    expect(out).toContain("bora marcar");
    expect(out).not.toContain("(sem texto)");
  });

  // "" would slip past the `?? "(sem texto)"` and leave the preview line blank.
  it("voice note sem fala cai em (sem texto), não em linha vazia", async () => {
    audio("L2", { transcript: "", status: "done", ref: "{}" });
    const out = textOf(await (await connectClient(db)).callTool({ name: "list_chats", arguments: {} }));
    expect(out).toContain("(sem texto)");
  });
});

/**
 * The MCP process opens the store read-only and never migrates it, so `npm run build`
 * followed by a not-yet-restarted daemon points a v2 reader at a v1 file. That has to
 * degrade quietly rather than take all nine tools down with `no such column`.
 */
describe("banco ainda no schema v1", () => {
  it("as tools de leitura respondem sem estourar", async () => {
    const old = new Database(":memory:");
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, chat_jid TEXT NOT NULL, msg_id TEXT NOT NULL,
        sender_jid TEXT, from_me INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL,
        type TEXT NOT NULL, text TEXT, quoted_id TEXT, UNIQUE (chat_jid, msg_id));
      CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content='messages', content_rowid='id');
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER, unread_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, push_name TEXT);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO chats (jid, name, last_message_at) VALUES ('${IGOR}', 'Igor', 1000);
      INSERT INTO messages (chat_jid, msg_id, timestamp, type, text) VALUES ('${IGOR}', 'V1', 1000, 'text', 'oi');
    `);
    const client = await connectClient(old);
    expect(textOf(await client.callTool({ name: "read_messages", arguments: { jid: IGOR } }))).toContain("oi");
    expect(textOf(await client.callTool({ name: "list_chats", arguments: {} }))).toContain("Igor");
    expect(textOf(await client.callTool({ name: "search_messages", arguments: { query: "oi" } }))).toContain("oi");
  });
});
