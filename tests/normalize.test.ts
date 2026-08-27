import { describe, it, expect } from "vitest";
import { normalizeJid, isGroupJid, isUserJid } from "../src/shared/jid.js";
import { toMessageRow } from "../src/shared/normalize.js";

describe("normalizeJid", () => {
  it("remove o sufixo de device", () => {
    expect(normalizeJid("5511999999999:12@s.whatsapp.net")).toBe("5511999999999@s.whatsapp.net");
  });
  it("deixa jid já normalizado intacto", () => {
    expect(normalizeJid("5511999999999@s.whatsapp.net")).toBe("5511999999999@s.whatsapp.net");
  });
  it("reconhece grupo", () => {
    expect(isGroupJid("12345-67890@g.us")).toBe(true);
    expect(isGroupJid("5511999999999@s.whatsapp.net")).toBe(false);
  });
});

const base = {
  key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "ABC123" },
  messageTimestamp: 1754000000,
};

describe("toMessageRow", () => {
  it("extrai texto de conversation", () => {
    const row = toMessageRow({ ...base, message: { conversation: "oi" } })!;
    expect(row.type).toBe("text");
    expect(row.text).toBe("oi");
    expect(row.msg_id).toBe("ABC123");
    expect(row.chat_jid).toBe("5511999999999@s.whatsapp.net");
    expect(row.from_me).toBe(0);
  });

  it("extrai texto de extendedTextMessage e o id citado", () => {
    const row = toMessageRow({
      ...base,
      message: {
        extendedTextMessage: {
          text: "respondendo",
          contextInfo: { stanzaId: "QUOTED1" },
        },
      },
    })!;
    expect(row.text).toBe("respondendo");
    expect(row.quoted_id).toBe("QUOTED1");
  });

  it("guarda imagem como tipo + legenda, sem baixar binário", () => {
    const row = toMessageRow({ ...base, message: { imageMessage: { caption: "a foto" } } })!;
    expect(row.type).toBe("image");
    expect(row.text).toBe("a foto");
  });

  it("em grupo, usa participant como remetente", () => {
    const row = toMessageRow({
      key: { remoteJid: "12345-67890@g.us", fromMe: false, id: "G1", participant: "5511999@s.whatsapp.net" },
      messageTimestamp: 1754000000,
      message: { conversation: "oi grupo" },
    })!;
    expect(row.chat_jid).toBe("12345-67890@g.us");
    expect(row.sender_jid).toBe("5511999@s.whatsapp.net");
  });

  it("aceita messageTimestamp em Long ({low, high})", () => {
    const row = toMessageRow({ ...base, messageTimestamp: { low: 1754000000, high: 0 }, message: { conversation: "x" } })!;
    expect(row.timestamp).toBe(1754000000);
  });

  it("devolve null quando não há id, chat ou message", () => {
    expect(toMessageRow({ key: { remoteJid: null, id: "X" }, message: { conversation: "a" } })).toBeNull();
    expect(toMessageRow({ ...base, message: null })).toBeNull();
  });

  it("classifica protocolo/desconhecido como other, sem texto", () => {
    const row = toMessageRow({ ...base, message: { protocolMessage: { type: 0 } } })!;
    expect(row.type).toBe("other");
    expect(row.text).toBeNull();
  });
});

describe("isUserJid", () => {
  it("aceita pessoa em @s.whatsapp.net e em @lid", () => {
    expect(isUserJid("5511999999999@s.whatsapp.net")).toBe(true);
    expect(isUserJid("42700665520139@lid")).toBe(true);
  });

  it("recusa grupo e os pseudo-jids que carregam pushName mas não são gente", () => {
    expect(isUserJid("12345-67890@g.us")).toBe(false);
    expect(isUserJid("status@broadcast")).toBe(false);
    expect(isUserJid("12345@newsletter")).toBe(false);
    expect(isUserJid("12345@bot")).toBe(false);
  });
});

describe("envelopes que escondem o conteúdo", () => {
  const row = (message: unknown) =>
    toMessageRow({
      key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "W1" },
      messageTimestamp: 1787845000,
      message,
    });

  it("lê mensagem temporária (ephemeralMessage)", () => {
    const r = row({ ephemeralMessage: { message: { conversation: "some em 24h" } } });
    expect(r?.type).toBe("text");
    expect(r?.text).toBe("some em 24h");
  });

  it("lê view once", () => {
    const r = row({ viewOnceMessageV2: { message: { imageMessage: { caption: "olha isso" } } } });
    expect(r?.type).toBe("image");
    expect(r?.text).toBe("olha isso");
  });

  it("lê documento com legenda", () => {
    const r = row({ documentWithCaptionMessage: { message: { documentMessage: { fileName: "contrato.pdf" } } } });
    expect(r?.type).toBe("document");
    expect(r?.text).toBe("contrato.pdf");
  });

  it("desembrulha envelope aninhado", () => {
    const r = row({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: "duplo" } } } } });
    expect(r?.text).toBe("duplo");
  });

  it("envelope vazio continua sendo 'other', sem estourar", () => {
    const r = row({ ephemeralMessage: {} });
    expect(r?.type).toBe("other");
  });
});

describe("timestamp inválido não derruba o lote", () => {
  it("descarta a mensagem em vez de gravar NaN", () => {
    const r = toMessageRow({
      key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "NAN1" },
      messageTimestamp: "lixo",
      message: { conversation: "oi" },
    });
    expect(r).toBeNull();
  });

  it("aceita timestamp como string numérica", () => {
    const r = toMessageRow({
      key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "STR1" },
      messageTimestamp: "1787845000",
      message: { conversation: "oi" },
    });
    expect(r?.timestamp).toBe(1787845000);
  });
});
