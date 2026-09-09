import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import {
  ingestMessages,
  ingestChats,
  ingestChatUpdates,
  recordHistoryProgress,
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
    expect(ingestMessages(db, [msg("A", "um"), msg("B", "dois")])).toMatchObject({ written: 2 });
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
    expect(ingestMessages(db, [msg("A", "um"), { key: {}, message: null }])).toMatchObject({ written: 1 });
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

  it("ignora pseudo-jid: o feed de status não vira contato", () => {
    ingestMessages(db, [
      {
        key: { remoteJid: "status@broadcast", fromMe: false, id: "S1" },
        messageTimestamp: 1754000000,
        message: { conversation: "story" },
        pushName: "Degust",
      },
    ]);
    expect(db.prepare("SELECT 1 FROM contacts WHERE jid = ?").get("status@broadcast")).toBeUndefined();
  });

  it("aprende de jid @lid, que é como o WhatsApp endereça hoje", () => {
    ingestMessages(db, [
      {
        key: { remoteJid: "100000000000000@lid", fromMe: false, id: "L1" },
        messageTimestamp: 1754000000,
        message: { conversation: "oi" },
        pushName: "Glaucia",
      },
    ]);
    const c = db.prepare("SELECT push_name FROM contacts WHERE jid = ?").get("100000000000000@lid") as any;
    expect(c.push_name).toBe("Glaucia");
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

describe("ingestChatUpdates — unread_count", () => {
  const seed = (jid: string, unread: number) =>
    ingestChats(db, [{ id: jid, name: "Fulano", unreadCount: unread }]);

  it("incrementa quando o delta é positivo", () => {
    seed("5511@s.whatsapp.net", 2);
    ingestChatUpdates(db, [{ id: "5511@s.whatsapp.net", unreadCount: 3 }]);
    const r = db.prepare("SELECT unread_count AS u FROM chats WHERE jid = ?").get("5511@s.whatsapp.net") as any;
    expect(r.u).toBe(5);
  });

  it("decrementa quando o delta é negativo, sem passar de zero", () => {
    seed("5522@s.whatsapp.net", 1);
    ingestChatUpdates(db, [{ id: "5522@s.whatsapp.net", unreadCount: -4 }]);
    const r = db.prepare("SELECT unread_count AS u FROM chats WHERE jid = ?").get("5522@s.whatsapp.net") as any;
    expect(r.u).toBe(0);
  });

  it("zera quando unreadCount vem null (chat marcado como lido)", () => {
    seed("5533@s.whatsapp.net", 7);
    ingestChatUpdates(db, [{ id: "5533@s.whatsapp.net", unreadCount: null }]);
    const r = db.prepare("SELECT unread_count AS u FROM chats WHERE jid = ?").get("5533@s.whatsapp.net") as any;
    expect(r.u).toBe(0);
  });

  it("não mexe no contador quando o update não traz unreadCount", () => {
    seed("5544@s.whatsapp.net", 3);
    ingestChatUpdates(db, [{ id: "5544@s.whatsapp.net", archived: true }]);
    const r = db.prepare("SELECT unread_count AS u, archived AS a FROM chats WHERE jid = ?").get("5544@s.whatsapp.net") as any;
    expect(r.u).toBe(3);
    expect(r.a).toBe(1);
  });

  it("ignora unreadCount não numérico sem derrubar o resto do lote", () => {
    seed("5588@s.whatsapp.net", 3);
    seed("5599@s.whatsapp.net", 1);
    ingestChatUpdates(db, [
      { id: "5588@s.whatsapp.net", unreadCount: "lixo" },
      { id: "5599@s.whatsapp.net", unreadCount: 2 },
    ]);
    const a = db.prepare("SELECT unread_count AS u FROM chats WHERE jid = ?").get("5588@s.whatsapp.net") as any;
    const b = db.prepare("SELECT unread_count AS u FROM chats WHERE jid = ?").get("5599@s.whatsapp.net") as any;
    expect(a.u).toBe(3); // preservado, não corrompido
    expect(b.u).toBe(3); // e o vizinho no mesmo lote não foi revertido
  });

  it("não cria chat a partir de um update de chat desconhecido", () => {
    ingestChatUpdates(db, [{ id: "5555@s.whatsapp.net", unreadCount: 2 }]);
    const n = db.prepare("SELECT count(*) AS n FROM chats").get() as any;
    expect(n.n).toBe(0);
  });

  it("preserva o nome já conhecido quando o update o omite", () => {
    seed("5566@s.whatsapp.net", 0);
    ingestChatUpdates(db, [{ id: "5566@s.whatsapp.net", unreadCount: 1 }]);
    const r = db.prepare("SELECT name AS n FROM chats WHERE jid = ?").get("5566@s.whatsapp.net") as any;
    expect(r.n).toBe("Fulano");
  });
});

describe("ingestChats — não zera estado ausente", () => {
  it("um upsert sem unreadCount não apaga o contador existente", () => {
    ingestChats(db, [{ id: "5577@s.whatsapp.net", name: "Fulano", unreadCount: 4 }]);
    ingestChats(db, [{ id: "5577@s.whatsapp.net", name: "Fulano" }]);
    const r = db.prepare("SELECT unread_count AS u FROM chats WHERE jid = ?").get("5577@s.whatsapp.net") as any;
    expect(r.u).toBe(4);
  });
});

describe("recordHistoryProgress", () => {
  it("não marca o sync como completo enquanto progress não chega a 100", () => {
    recordHistoryProgress(db, { progress: 40 });
    recordHistoryProgress(db, { progress: 99 });
    expect(getMeta(db, "initial_sync_done")).toBeNull();
  });

  it("ignora lotes sem progress, que é o caso da maioria deles", () => {
    recordHistoryProgress(db, { progress: null });
    recordHistoryProgress(db, {});
    expect(getMeta(db, "initial_sync_done")).toBeNull();
  });

  it("marca completo quando progress chega a 100", () => {
    expect(recordHistoryProgress(db, { progress: 100 })).toBe(true);
    expect(getMeta(db, "initial_sync_done")).toBe("1");
  });

  it("não desmarca quando um lote atrasado chega depois do 100", () => {
    recordHistoryProgress(db, { progress: 100 });
    recordHistoryProgress(db, { progress: 12 });
    expect(getMeta(db, "initial_sync_done")).toBe("1");
  });

  it("isLatest sozinho não marca nada: no Baileys ele é o primeiro lote, não o último", () => {
    recordHistoryProgress(db, { progress: null, isLatest: true } as any);
    expect(getMeta(db, "initial_sync_done")).toBeNull();
  });
});

describe("enfileiramento de nota de voz", () => {
  const voice = (id: string, ts = 1754000000) => ({
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id },
    messageTimestamp: ts,
    message: {
      audioMessage: {
        ptt: true,
        mediaKey: new Uint8Array([9, 9, 9]),
        directPath: "/v/t62/abc",
        mimetype: "audio/ogg; codecs=opus",
        seconds: 5,
      },
    },
  });

  const row = (id: string) =>
    db.prepare("SELECT transcript_status, media_ref, transcript FROM messages WHERE msg_id = ?").get(id) as any;

  // migrate() stamps transcription_since at "now minus a day", and every fixture in
  // this file is dated 2025. Opening the window is what the cases below are about;
  // the case that asserts the window itself closes it again explicitly.
  beforeEach(() => setMeta(db, "transcription_since", "0"));

  it("enfileira nota de voz nova com o descritor de mídia", () => {
    expect(ingestMessages(db, [voice("V1")])).toMatchObject({ written: 1, enqueued: 1 });
    const r = row("V1");
    expect(r.transcript_status).toBe("pending");
    expect(JSON.parse(r.media_ref).directPath).toBe("/v/t62/abc");
  });

  it("não enfileira o que é anterior a transcription_since", () => {
    setMeta(db, "transcription_since", "9999999999");
    expect(ingestMessages(db, [voice("V2")])).toMatchObject({ written: 1, enqueued: 0 });
    expect(row("V2").transcript_status).toBeNull();
  });

  it("não enfileira áudio que não é nota de voz", () => {
    const music = voice("V3");
    (music.message.audioMessage as any).ptt = false;
    expect(ingestMessages(db, [music])).toMatchObject({ enqueued: 0 });
    expect(row("V3").transcript_status).toBeNull();
  });

  // WhatsApp re-delivers recent messages on every reconnect, and this daemon
  // reconnects about every 30 minutes. Both halves matter: not queueing twice, and
  // not erasing a transcript that already cost GPU time.
  it("o replay do histórico não re-enfileira nem apaga a transcrição", () => {
    ingestMessages(db, [voice("V4")]);
    db.prepare(
      "UPDATE messages SET transcript = 'abacaxi e bicicleta', transcript_status = 'done' WHERE msg_id = 'V4'",
    ).run();

    expect(ingestMessages(db, [voice("V4")])).toMatchObject({ written: 1, enqueued: 0 });

    const r = row("V4");
    expect(r.transcript).toBe("abacaxi e bicicleta");
    expect(r.transcript_status).toBe("done");
  });

  it("a transcrição continua achável no FTS depois do replay", () => {
    ingestMessages(db, [voice("V5")]);
    db.prepare("UPDATE messages SET transcript = 'abacaxi', transcript_status = 'done' WHERE msg_id = 'V5'").run();
    ingestMessages(db, [voice("V5")]);
    const hit = db
      .prepare("SELECT m.msg_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?")
      .all("abacaxi") as any[];
    expect(hit.map((h) => h.msg_id)).toEqual(["V5"]);
  });

  it("uma nota que falhou não é re-enfileirada pelo replay", () => {
    ingestMessages(db, [voice("V6")]);
    db.prepare("UPDATE messages SET transcript_status = 'failed' WHERE msg_id = 'V6'").run();
    expect(ingestMessages(db, [voice("V6")])).toMatchObject({ enqueued: 0 });
    expect(row("V6").transcript_status).toBe("failed");
  });
});
