import { describe, it, expect } from "vitest";
import { normalizeJid, isGroupJid, isUserJid } from "../src/shared/jid.js";
import { toAudioRef, toMessageRow } from "../src/shared/normalize.js";

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
    expect(isUserJid("100000000000000@lid")).toBe(true);
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

describe("toAudioRef", () => {
  const ptt = (over: Record<string, unknown> = {}) => ({
    ...base,
    message: {
      audioMessage: {
        ptt: true,
        mediaKey: new Uint8Array([1, 2, 3, 4]),
        directPath: "/v/t62.7117-24/abc123",
        mimetype: "audio/ogg; codecs=opus",
        seconds: 8,
        ...over,
      },
    },
  });

  it("extrai o descritor de uma nota de voz", () => {
    const ref = toAudioRef(ptt())!;
    expect(ref.directPath).toBe("/v/t62.7117-24/abc123");
    expect(ref.seconds).toBe(8);
    expect(ref.mimetype).toBe("audio/ogg; codecs=opus");
  });

  it("guarda a mediaKey em base64, e ela sobrevive ao round-trip do media_ref", () => {
    const ref = toAudioRef(ptt())!;
    expect(ref.mediaKey).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    const back = JSON.parse(JSON.stringify(ref));
    expect(back.mediaKey).toBe(ref.mediaKey);
    expect(back.directPath).toBe(ref.directPath);
  });

  it("aceita mediaKey que já veio como string base64", () => {
    expect(toAudioRef(ptt({ mediaKey: "AQIDBA==" }))?.mediaKey).toBe("AQIDBA==");
  });

  // The whole point of the ptt gate: an hour of forwarded music is the worst case.
  it("recusa áudio que não é nota de voz", () => {
    expect(toAudioRef(ptt({ ptt: false }))).toBeNull();
    expect(toAudioRef(ptt({ ptt: undefined }))).toBeNull();
  });

  it("recusa quando falta mediaKey ou directPath: não haveria como baixar depois", () => {
    expect(toAudioRef(ptt({ mediaKey: undefined }))).toBeNull();
    expect(toAudioRef(ptt({ mediaKey: new Uint8Array([]) }))).toBeNull();
    expect(toAudioRef(ptt({ directPath: undefined }))).toBeNull();
  });

  it("enxerga a nota dentro de envelope efêmero e de view once", () => {
    const inner = ptt().message;
    expect(toAudioRef({ ...base, message: { ephemeralMessage: { message: inner } } })).not.toBeNull();
    expect(toAudioRef({ ...base, message: { viewOnceMessageV2: { message: inner } } })).not.toBeNull();
  });

  it("degrada seconds ausente ou inválido para 0, sem estourar", () => {
    expect(toAudioRef(ptt({ seconds: undefined }))?.seconds).toBe(0);
    expect(toAudioRef(ptt({ seconds: "lixo" }))?.seconds).toBe(0);
  });

  it("não é nota de voz, não é áudio, não é mensagem: null", () => {
    expect(toAudioRef({ ...base, message: { conversation: "oi" } })).toBeNull();
    expect(toAudioRef({ ...base, message: null })).toBeNull();
    expect(toAudioRef(null)).toBeNull();
  });

  it("a mensagem em si continua sem texto: a transcrição não passa por classify", () => {
    const row = toMessageRow(ptt())!;
    expect(row.type).toBe("audio");
    expect(row.text).toBeNull();
  });
});
