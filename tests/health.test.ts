import { describe, it, expect } from "vitest";
import {
  assessInbound,
  daytimeMinutesBetween,
  type InboundHealth,
} from "../src/shared/health.js";

const TZ = "America/Fortaleza";
const ok: InboundHealth = {
  decryptedLastHour: 40,
  undecryptableLastHour: 0,
  disconnectsLastHour: 1,
  bufferingSinceMs: null,
};
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("daytimeMinutesBetween", () => {
  it("não conta a madrugada", () => {
    // 23:00 de 26/08 até 07:00 de 27/08, Fortaleza: oito horas, todas fora da janela.
    expect(daytimeMinutesBetween(at("2026-08-27T02:00:00Z"), at("2026-08-27T10:00:00Z"), TZ)).toBe(0);
  });

  it("conta a janela diurna cheia", () => {
    // 07:00 -> 23:00 local = 16h = 960 min.
    expect(daytimeMinutesBetween(at("2026-08-27T10:00:00Z"), at("2026-08-28T02:00:00Z"), TZ)).toBe(960);
  });

  it("atravessa a noite somando só as duas pontas diurnas", () => {
    // 21:00 -> 09:00 local: 2h antes das 23h + 2h depois das 07h = 240 min.
    expect(daytimeMinutesBetween(at("2026-08-27T00:00:00Z"), at("2026-08-27T12:00:00Z"), TZ)).toBe(240);
  });

  it("devolve zero quando a ordem está invertida", () => {
    expect(daytimeMinutesBetween(at("2026-08-27T12:00:00Z"), at("2026-08-27T10:00:00Z"), TZ)).toBe(0);
  });
});

describe("assessInbound — especificidade (não pode gritar à toa)", () => {
  it("silêncio noturno normal continua ok", () => {
    // Última recebida 22:30, agora 06:30 do dia seguinte: zero minuto diurno.
    const v = assessInbound({
      now: at("2026-08-27T09:30:00Z"),
      lastInboundMsgTs: at("2026-08-27T01:30:00Z"),
      health: ok,
      tz: TZ,
    });
    expect(v.verdict).toBe("ok");
  });

  it("o pior silêncio diurno real do histórico (113 min) não dispara nada", () => {
    const v = assessInbound({
      now: at("2026-08-27T17:00:00Z"),
      lastInboundMsgTs: at("2026-08-27T15:07:00Z"), // 113 min antes
      health: ok,
      tz: TZ,
    });
    expect(v.verdict).toBe("ok");
  });
});

describe("assessInbound — sensibilidade (tem que pegar o apagão real)", () => {
  // Estado literal da produção em 27/08/2026 12:42 BRT, medido antes da correção:
  // última recebida 25/08 13:20 BRT, 67 falhas de decifragem na última hora,
  // zero sucessos, e o buffer do Baileys travado desde a conexão.
  const apagao = {
    now: at("2026-08-27T15:42:00Z"),
    lastInboundMsgTs: at("2026-08-25T16:20:49Z"),
    tz: TZ,
  };

  it("marca quebrado no estado exato em que o sistema estava", () => {
    const v = assessInbound({
      ...apagao,
      health: { decryptedLastHour: 0, undecryptableLastHour: 67, disconnectsLastHour: 2, bufferingSinceMs: 50 * 60_000 },
    });
    expect(v.verdict).toBe("quebrado");
  });

  it("pega pela perna rápida em ~40 min, sem esperar as 6h de silêncio", () => {
    const v = assessInbound({
      now: at("2026-08-25T17:00:00Z"),
      lastInboundMsgTs: at("2026-08-25T16:20:49Z"), // só 40 min antes
      health: { decryptedLastHour: 0, undecryptableLastHour: 25, disconnectsLastHour: 1, bufferingSinceMs: null },
      tz: TZ,
    });
    expect(v.verdict).toBe("quebrado");
    expect(v.reason).toMatch(/nenhuma foi decifrada/);
  });

  it("pega o buffer travado mesmo sem nenhuma falha de decifragem", () => {
    // Newsletter é texto puro e não usa Signal: no apagão real ela também sumiu,
    // porque o problema era o buffer, não a criptografia.
    const v = assessInbound({
      now: at("2026-08-27T15:42:00Z"),
      lastInboundMsgTs: at("2026-08-27T15:30:00Z"), // 12 min, silêncio irrelevante
      health: { decryptedLastHour: 0, undecryptableLastHour: 0, disconnectsLastHour: 0, bufferingSinceMs: 5 * 60_000 },
      tz: TZ,
    });
    expect(v.verdict).toBe("quebrado");
    expect(v.reason).toMatch(/buffer de eventos travado/);
  });

  it("os dois apagões anteriores, que se curaram sozinhos, teriam sido vistos", () => {
    // 19/08 15:25 -> 20/08 11:50 (20,4h) e 23/08 14:44 -> 24/08 17:07 (26,4h).
    for (const [de, ate] of [
      ["2026-08-19T18:25:00Z", "2026-08-20T14:50:00Z"],
      ["2026-08-23T17:44:00Z", "2026-08-24T20:07:00Z"],
    ] as const) {
      const v = assessInbound({ now: at(ate), lastInboundMsgTs: at(de), health: ok, tz: TZ });
      expect(v.verdict).toBe("quebrado");
    }
  });

  it("suspeito fica entre 3h e 6h diurnas", () => {
    const v = assessInbound({
      now: at("2026-08-27T17:00:00Z"),
      lastInboundMsgTs: at("2026-08-27T13:00:00Z"), // 4h, tudo diurno
      health: ok,
      tz: TZ,
    });
    expect(v.verdict).toBe("suspeito");
  });
});
