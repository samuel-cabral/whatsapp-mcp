import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, ingestLidMappings } from "../src/daemon/ingest.js";
import { listChats, readMessages, searchMessages, getContact } from "../src/mcp/queries.js";
import { lidPair } from "../src/shared/jid.js";

const PN = "558592902175@s.whatsapp.net";
const LID = "75265074045127@lid";
const OUTRO = "5511999@s.whatsapp.net";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

const lidMap = () => db.prepare("SELECT lid, pn FROM lid_map ORDER BY lid").all();

describe("lidPair", () => {
  it("aceita um lid e um número em qualquer ordem, sem sufixo de dispositivo", () => {
    expect(lidPair("75265074045127:3@lid", PN)).toEqual({ lid: LID, pn: PN });
    expect(lidPair(PN, LID)).toEqual({ lid: LID, pn: PN });
  });

  it("recusa tudo que não for exatamente um lid e um número", () => {
    expect(lidPair(PN, OUTRO)).toBeNull();
    expect(lidPair("123-456@g.us", LID)).toBeNull();
    expect(lidPair(LID, undefined)).toBeNull();
  });
});

describe("aprendendo o vínculo no ingest", () => {
  it("lê sender_pn de uma mensagem recebida numa conversa lid", () => {
    ingestMessages(db, [
      { key: { remoteJid: LID, fromMe: false, id: "A", senderPn: PN }, messageTimestamp: 1, message: { conversation: "oi" } },
    ]);
    expect(lidMap()).toEqual([{ lid: LID, pn: PN }]);
  });

  it("ignora sender_pn de mensagem minha, que descreve a mim e não a outra pessoa", () => {
    ingestMessages(db, [
      { key: { remoteJid: LID, fromMe: true, id: "B", senderPn: OUTRO }, messageTimestamp: 1, message: { conversation: "oi" } },
    ]);
    expect(lidMap()).toEqual([]);
  });

  it("lê participant_pn de mensagem de grupo", () => {
    ingestMessages(db, [
      {
        key: { remoteJid: "123-456@g.us", fromMe: false, id: "G", participant: LID, participantPn: PN },
        messageTimestamp: 1,
        message: { conversation: "oi" },
      },
    ]);
    expect(lidMap()).toEqual([{ lid: LID, pn: PN }]);
  });

  it("lê o lid de contatos e de conversas do history sync", () => {
    ingestContacts(db, [{ id: PN, lid: LID, name: "Thaís Oliveira" }]);
    expect(lidMap()).toEqual([{ lid: LID, pn: PN }]);

    db.exec("DELETE FROM lid_map");
    ingestChats(db, [{ id: LID, pnJid: PN }]);
    expect(lidMap()).toEqual([{ lid: LID, pn: PN }]);
  });

  it("evento phoneNumberShare", () => {
    ingestLidMappings(db, [{ lid: LID, jid: PN }]);
    expect(lidMap()).toEqual([{ lid: LID, pn: PN }]);
  });
});

describe("leitura unificada", () => {
  beforeEach(() => {
    ingestContacts(db, [{ id: PN, name: "Thaís Oliveira" }]);
    ingestChats(db, [
      { id: PN, unreadCount: 0 },
      { id: LID, name: "Thais Leite", unreadCount: 3 },
    ]);
    ingestMessages(db, [
      { key: { remoteJid: PN, fromMe: false, id: "OLD" }, messageTimestamp: 100, message: { conversation: "edital antigo" } },
      // the same message replayed under the lid chat
      { key: { remoteJid: LID, fromMe: false, id: "OLD" }, messageTimestamp: 100, message: { conversation: "edital antigo" } },
      { key: { remoteJid: LID, fromMe: false, id: "NEW", senderPn: PN }, messageTimestamp: 200, message: { conversation: "edital novo" } },
    ]);
  });

  it("read_messages pelo número traz também o que chegou pelo lid, sem duplicar", () => {
    const msgs = readMessages(db, { jid: PN });
    expect(msgs.map((m) => m.id)).toEqual(["OLD", "NEW"]);
  });

  it("read_messages pelo lid traz a mesma conversa", () => {
    expect(readMessages(db, { jid: LID }).map((m) => m.id)).toEqual(["OLD", "NEW"]);
  });

  it("o remetente pelo lid aparece com o nome salvo no número", () => {
    const novo = readMessages(db, { jid: PN }).find((m) => m.id === "NEW")!;
    expect(novo.senderName).toBe("Thaís Oliveira");
  });

  it("list_chats mostra uma conversa só, com o nome da agenda e as não lidas", () => {
    const chats = listChats(db, {});
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ jid: PN, name: "Thaís Oliveira", unread: 3, lastText: "edital novo" });
  });

  it("get_contact acha pelo nome do lid e devolve o número", () => {
    expect(getContact(db, "Leite")).toEqual([{ jid: PN, name: "Thaís Oliveira", push_name: null }]);
    expect(getContact(db, "Thaís")).toHaveLength(1);
  });

  it("search_messages filtra pelo número e reporta a conversa pelo número", () => {
    const hits = searchMessages(db, { query: "edital", jid: PN });
    expect(hits.map((h) => h.id).sort()).toEqual(["NEW", "OLD"]);
    expect(new Set(hits.map((h) => h.chatJid))).toEqual(new Set([PN]));
    expect(hits[0].chatName).toBe("Thaís Oliveira");
  });
});

describe("migração v2 → v3", () => {
  it("religa lids que compartilham mensagem com exatamente um número", () => {
    const old = new Database(":memory:");
    migrate(old);
    old.exec("DROP TABLE lid_map; UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    const ins = old.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type) VALUES (?, ?, 1, 'text')");
    ins.run(PN, "X");
    ins.run(LID, "X");
    // our own lid overlaps two number chats and must stay unmapped
    ins.run("999@lid", "S1");
    ins.run(PN, "S1");
    ins.run("999@lid", "S2");
    ins.run(OUTRO, "S2");

    migrate(old);
    expect(old.prepare("SELECT lid, pn FROM lid_map").all()).toEqual([{ lid: LID, pn: PN }]);
  });
});
