import { describe, it, expect } from "vitest";
import { tallyUpsert, InboundHealthTracker, SessionRepairQueue } from "../src/daemon/health.js";

const inbound = (id: string, text: string, ts = 1787845000) => ({
  key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id },
  messageTimestamp: ts,
  message: { conversation: text },
});

// Exatamente o que o Baileys entrega quando a decifragem falha: a mensagem chega,
// com messageStubType 2 e sem `message` (Utils/decode-wa-message.js:184-188).
const stub = (id: string, participant?: string) => ({
  key: { remoteJid: "120363@g.us", fromMe: false, id, participant },
  messageTimestamp: 1787845000,
  messageStubType: 2,
  messageStubParameters: ["No session found to decrypt message"],
});

describe("tallyUpsert", () => {
  it("separa o que deu para ler do que não deu", () => {
    const t = tallyUpsert([inbound("A", "oi"), stub("B"), stub("C"), inbound("D", "tudo bem")]);
    expect(t.decrypted).toBe(2);
    expect(t.undecryptable).toBe(2);
  });

  it("não conta o eco das nossas próprias mensagens como inbound", () => {
    const t = tallyUpsert([
      { key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "X" }, message: { conversation: "eu" } },
    ]);
    expect(t.decrypted).toBe(0);
    expect(t.undecryptable).toBe(0);
  });

  it("guarda o timestamp mais novo entre as decifradas", () => {
    const t = tallyUpsert([inbound("A", "velha", 100), inbound("B", "nova", 900), stub("C")]);
    expect(t.newestDecryptedTs).toBe(900);
  });

  it("coleta quem falhou, sem repetir, para renegociar sessão", () => {
    const t = tallyUpsert([stub("A", "110999@lid"), stub("B", "110999@lid"), stub("C", "111823@lid")]);
    expect(t.failingJids.sort()).toEqual(["110999@lid", "111823@lid"]);
  });

  it("mensagem sem message também conta como não decifrada, mesmo sem o stub", () => {
    const t = tallyUpsert([{ key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "Z" } }]);
    expect(t.undecryptable).toBe(1);
  });
});

describe("InboundHealthTracker", () => {
  it("conta na janela de uma hora e esquece o que passou dela", () => {
    const t = new InboundHealthTracker();
    const t0 = 1_000_000_000;
    t.recordUpsert({ decrypted: 3, undecryptable: 1, newestDecryptedTs: null, failingJids: [] }, t0);
    expect(t.snapshot(t0).decryptedLastHour).toBe(3);
    // duas horas depois, a janela está limpa
    const depois = t.snapshot(t0 + 2 * 60 * 60_000);
    expect(depois.decryptedLastHour).toBe(0);
    expect(depois.undecryptableLastHour).toBe(0);
  });

  it("mantém o que ainda está dentro da janela e descarta só o prefixo velho", () => {
    const t = new InboundHealthTracker();
    const t0 = 1_000_000_000;
    t.recordUpsert({ decrypted: 2, undecryptable: 0, newestDecryptedTs: null, failingJids: [] }, t0);
    t.recordUpsert({ decrypted: 5, undecryptable: 0, newestDecryptedTs: null, failingJids: [] }, t0 + 50 * 60_000);
    // 70 min depois de t0: os 2 primeiros saíram, os 5 seguintes ficam
    expect(t.snapshot(t0 + 70 * 60_000).decryptedLastHour).toBe(5);
  });

  it("mede há quanto tempo o buffer está travado e zera quando destrava", () => {
    const t = new InboundHealthTracker();
    const t0 = 1_000_000_000;
    t.recordBuffering(true, t0);
    expect(t.snapshot(t0 + 90_000).bufferingSinceMs).toBe(90_000);
    t.recordBuffering(false, t0 + 91_000);
    expect(t.snapshot(t0 + 92_000).bufferingSinceMs).toBeNull();
  });
});

describe("SessionRepairQueue", () => {
  it("entrega em lotes pequenos", () => {
    const q = new SessionRepairQueue(30 * 60_000, 2);
    q.offer(["a", "b", "c", "d"]);
    expect(q.take(1000)).toHaveLength(2);
  });

  it("não pergunta duas vezes pelo mesmo peer dentro do cooldown", () => {
    const q = new SessionRepairQueue(30 * 60_000, 5);
    q.offer(["a"]);
    expect(q.take(1000)).toEqual(["a"]);
    q.offer(["a"]);
    expect(q.take(1000 + 60_000)).toEqual([]); // ainda no cooldown
  });

  it("volta a permitir depois do cooldown", () => {
    const q = new SessionRepairQueue(30 * 60_000, 5);
    q.offer(["a"]);
    q.take(1000);
    q.offer(["a"]);
    expect(q.take(1000 + 31 * 60_000)).toEqual(["a"]);
  });

  it("fica vazia quando ninguém está pendente", () => {
    expect(new SessionRepairQueue().take(1000)).toEqual([]);
  });
});
