import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, setMeta, getMeta } from "../src/daemon/ingest.js";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

const msg = (id: string, text: string, ts = 1754000000) => ({
  key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id },
  messageTimestamp: ts,
  message: { conversation: text },
});

describe("ingestMessages", () => {
  it("grava mensagens novas", () => {
    expect(ingestMessages(db, [msg("A", "um"), msg("B", "dois")])).toBe(2);
    const n = db.prepare("SELECT count(*) AS n FROM messages").get() as any;
    expect(n.n).toBe(2);
  });

  it("é idempotente: o mesmo lote duas vezes não duplica", () => {
    const batch = [msg("A", "um"), msg("B", "dois")];
    ingestMessages(db, batch);
    ingestMessages(db, batch);
    const n = db.prepare("SELECT count(*) AS n FROM messages").get() as any;
    expect(n.n).toBe(2);
    const f = db.prepare("SELECT count(*) AS n FROM messages_fts").get() as any;
    expect(f.n).toBe(2);
  });

  it("ignora entradas que não normalizam, sem abortar o lote", () => {
    expect(ingestMessages(db, [msg("A", "um"), { key: {}, message: null }])).toBe(1);
  });

  it("cria o chat implicitamente e atualiza last_message_at", () => {
    ingestMessages(db, [msg("A", "um", 1000), msg("B", "dois", 2000)]);
    const chat = db.prepare("SELECT * FROM chats WHERE jid = ?").get("5511999999999@s.whatsapp.net") as any;
    expect(chat).toBeTruthy();
    expect(chat.last_message_at).toBe(2000);
  });

  it("mantém sync_state apontando para a mensagem mais antiga do chat", () => {
    ingestMessages(db, [msg("B", "dois", 2000), msg("A", "um", 1000)]);
    const s = db.prepare("SELECT * FROM sync_state WHERE chat_jid = ?").get("5511999999999@s.whatsapp.net") as any;
    expect(s.oldest_msg_id).toBe("A");
    expect(s.oldest_ts).toBe(1000);
  });
});

describe("ingestChats e ingestContacts", () => {
  it("grava chat com nome e marca grupo", () => {
    ingestChats(db, [{ id: "12345-67890@g.us", name: "Grupo da Igreja", unreadCount: 3 }]);
    const c = db.prepare("SELECT * FROM chats WHERE jid = ?").get("12345-67890@g.us") as any;
    expect(c.name).toBe("Grupo da Igreja");
    expect(c.is_group).toBe(1);
    expect(c.unread_count).toBe(3);
  });

  it("não apaga o nome já conhecido quando o novo vem vazio", () => {
    ingestChats(db, [{ id: "5511@s.whatsapp.net", name: "Igor" }]);
    ingestChats(db, [{ id: "5511@s.whatsapp.net" }]);
    const c = db.prepare("SELECT name FROM chats WHERE jid = ?").get("5511@s.whatsapp.net") as any;
    expect(c.name).toBe("Igor");
  });

  it("grava contato com push_name", () => {
    ingestContacts(db, [{ id: "5511@s.whatsapp.net", name: "Igor", notify: "Igor S." }]);
    const c = db.prepare("SELECT * FROM contacts WHERE jid = ?").get("5511@s.whatsapp.net") as any;
    expect(c.name).toBe("Igor");
    expect(c.push_name).toBe("Igor S.");
  });
});

describe("meta", () => {
  it("grava e lê, com null para chave ausente", () => {
    expect(getMeta(db, "initial_sync_done")).toBeNull();
    setMeta(db, "initial_sync_done", "1");
    expect(getMeta(db, "initial_sync_done")).toBe("1");
  });
});
