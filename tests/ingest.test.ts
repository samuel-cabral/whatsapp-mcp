import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import {
  ingestMessages,
  ingestChats,
  ingestContacts,
  ingestGroupSubjects,
  setMeta,
  getMeta,
} from "../src/daemon/ingest.js";

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

describe("pushName vindo das mensagens", () => {
  const CONTATO = "5511999999999@s.whatsapp.net";
  const GRUPO = "12345-67890@g.us";

  it("aprende o nome de quem manda mensagem direta", () => {
    ingestMessages(db, [{ ...msg("A", "oi"), pushName: "Igor" }]);
    const c = db.prepare("SELECT push_name FROM contacts WHERE jid = ?").get(CONTATO) as any;
    expect(c.push_name).toBe("Igor");
  });

  it("aprende o nome do participante de grupo, não o do grupo", () => {
    ingestMessages(db, [
      {
        key: { remoteJid: GRUPO, fromMe: false, id: "G1", participant: "5511@s.whatsapp.net" },
        messageTimestamp: 1754000000,
        message: { conversation: "bom dia" },
        pushName: "Rebeka",
      },
    ]);
    const p = db.prepare("SELECT push_name FROM contacts WHERE jid = ?").get("5511@s.whatsapp.net") as any;
    expect(p.push_name).toBe("Rebeka");
    expect(db.prepare("SELECT 1 FROM contacts WHERE jid = ?").get(GRUPO)).toBeUndefined();
  });

  it("ignora pushName das próprias mensagens e o vazio", () => {
    ingestMessages(db, [
      { ...msg("A", "oi"), key: { remoteJid: CONTATO, fromMe: true, id: "A" }, pushName: "Samuel" },
      { ...msg("B", "oi"), pushName: "   " },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM contacts").get()).toEqual({ n: 0 });
  });

  it("não sobrescreve o nome da agenda, que é mais confiável", () => {
    ingestContacts(db, [{ id: CONTATO, name: "Igor Sousa" }]);
    ingestMessages(db, [{ ...msg("A", "oi"), pushName: "igorzin 🔥" }]);
    const c = db.prepare("SELECT name, push_name FROM contacts WHERE jid = ?").get(CONTATO) as any;
    expect(c.name).toBe("Igor Sousa");
    expect(c.push_name).toBe("igorzin 🔥");
  });
});

describe("ingestGroupSubjects", () => {
  it("grava o subject como nome do chat", () => {
    expect(ingestGroupSubjects(db, [{ id: "12345-67890@g.us", subject: "Grupo da Igreja" }])).toBe(1);
    const c = db.prepare("SELECT name, is_group FROM chats WHERE jid = ?").get("12345-67890@g.us") as any;
    expect(c.name).toBe("Grupo da Igreja");
    expect(c.is_group).toBe(1);
  });

  it("preserva unread_count, que o metadata de grupo não carrega", () => {
    ingestChats(db, [{ id: "12345-67890@g.us", unreadCount: 7 }]);
    ingestGroupSubjects(db, [{ id: "12345-67890@g.us", subject: "Grupo da Igreja" }]);
    const c = db.prepare("SELECT name, unread_count FROM chats WHERE jid = ?").get("12345-67890@g.us") as any;
    expect(c.name).toBe("Grupo da Igreja");
    expect(c.unread_count).toBe(7);
  });

  it("ignora update parcial sem subject em vez de apagar o nome", () => {
    ingestGroupSubjects(db, [{ id: "12345-67890@g.us", subject: "Grupo da Igreja" }]);
    expect(ingestGroupSubjects(db, [{ id: "12345-67890@g.us", announce: true }])).toBe(0);
    const c = db.prepare("SELECT name FROM chats WHERE jid = ?").get("12345-67890@g.us") as any;
    expect(c.name).toBe("Grupo da Igreja");
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
