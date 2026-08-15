import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, setMeta } from "../src/daemon/ingest.js";
import { listChats, readMessages, searchMessages, getContact, getSyncStatus } from "../src/mcp/queries.js";

const IGOR = "5511999@s.whatsapp.net";
const GRUPO = "12345-67890@g.us";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ingestContacts(db, [{ id: IGOR, name: "Igor", notify: "Igor S." }]);
  ingestChats(db, [
    { id: IGOR, name: "Igor", unreadCount: 2 },
    { id: GRUPO, name: "Grupo da Igreja", unreadCount: 0 },
  ]);
  ingestMessages(db, [
    { key: { remoteJid: IGOR, fromMe: false, id: "M1" }, messageTimestamp: 1000, message: { conversation: "bora marcar a reunião" } },
    { key: { remoteJid: IGOR, fromMe: true, id: "M2" }, messageTimestamp: 2000, message: { conversation: "fechado" } },
    { key: { remoteJid: GRUPO, fromMe: false, id: "G1", participant: IGOR }, messageTimestamp: 3000, message: { conversation: "ensaio às 19h" } },
  ]);
});

describe("listChats", () => {
  it("ordena por atividade mais recente e traz a última mensagem", () => {
    const chats = listChats(db, {});
    expect(chats[0].jid).toBe(GRUPO);
    expect(chats[0].lastText).toBe("ensaio às 19h");
    expect(chats[0].isGroup).toBe(true);
  });

  it("filtra só não-lidas", () => {
    const chats = listChats(db, { onlyUnread: true });
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe(IGOR);
    expect(chats[0].unread).toBe(2);
  });

  it("respeita o limite", () => {
    expect(listChats(db, { limit: 1 })).toHaveLength(1);
  });

  it("cai no push_name quando o chat não tem nome", () => {
    const ZE = "5585777@s.whatsapp.net";
    ingestMessages(db, [
      { key: { remoteJid: ZE, fromMe: false, id: "Z1" }, messageTimestamp: 4000, message: { conversation: "e aí" }, pushName: "Zé" },
    ]);
    expect(listChats(db, {})[0]).toMatchObject({ jid: ZE, name: "Zé" });
  });
});

describe("nome de quem enviou", () => {
  it("read_messages resolve o participante do grupo pelo contato", () => {
    const msgs = readMessages(db, { jid: GRUPO });
    expect(msgs[0]).toMatchObject({ sender: IGOR, senderName: "Igor" });
  });

  it("fica null para mensagem minha, que não tem remetente", () => {
    const minha = readMessages(db, { jid: IGOR }).find((m) => m.fromMe);
    expect(minha?.senderName).toBeNull();
  });

  it("search_messages traz o nome do chat e de quem enviou", () => {
    const [hit] = searchMessages(db, { query: "ensaio" });
    expect(hit).toMatchObject({ chatName: "Grupo da Igreja", senderName: "Igor" });
  });
});

describe("readMessages", () => {
  it("devolve em ordem cronológica", () => {
    const msgs = readMessages(db, { jid: IGOR });
    expect(msgs.map((m) => m.id)).toEqual(["M1", "M2"]);
    expect(msgs[1].fromMe).toBe(true);
  });

  it("filtra por janela de tempo", () => {
    expect(readMessages(db, { jid: IGOR, since: 1500 }).map((m) => m.id)).toEqual(["M2"]);
    expect(readMessages(db, { jid: IGOR, until: 1500 }).map((m) => m.id)).toEqual(["M1"]);
  });

  it("com limite, devolve as mais recentes ainda em ordem cronológica", () => {
    const msgs = readMessages(db, { jid: IGOR, limit: 1 });
    expect(msgs.map((m) => m.id)).toEqual(["M2"]);
  });
});

describe("searchMessages", () => {
  it("encontra ignorando acento e caixa", () => {
    const hits = searchMessages(db, { query: "REUNIAO" });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("M1");
    expect(hits[0].chatName).toBe("Igor");
  });

  it("filtra por chat", () => {
    expect(searchMessages(db, { query: "ensaio", jid: IGOR })).toHaveLength(0);
    expect(searchMessages(db, { query: "ensaio", jid: GRUPO })).toHaveLength(1);
  });

  it("aceita várias palavras sem quebrar na sintaxe do FTS", () => {
    expect(searchMessages(db, { query: "ensaio 19h" })).toHaveLength(1);
  });

  it("não explode com aspas ou operadores soltos vindos do modelo", () => {
    expect(() => searchMessages(db, { query: 'reunião" OR' })).not.toThrow();
  });
});

describe("getContact", () => {
  it("acha por parte do nome, sem acento", () => {
    expect(getContact(db, "igor")).toHaveLength(1);
  });
  it("acha por número", () => {
    expect(getContact(db, "5511999")).toHaveLength(1);
  });
});

describe("getSyncStatus", () => {
  it("reporta sync incompleto enquanto meta não estiver marcada", () => {
    const s = getSyncStatus(db, true);
    expect(s.connected).toBe(true);
    expect(s.initialSyncDone).toBe(false);
    expect(s.messageCount).toBe(3);
    expect(s.chatCount).toBe(2);
  });

  it("reporta completo depois de marcado", () => {
    setMeta(db, "initial_sync_done", "1");
    expect(getSyncStatus(db, false).initialSyncDone).toBe(true);
  });
});
