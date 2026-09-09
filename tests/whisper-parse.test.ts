import { describe, it, expect } from "vitest";
import { parseWhisperStdout, looksLooped, looksHallucinated } from "../src/daemon/transcribe.js";

/**
 * Captured from a real run of the exact argv this project uses, against a voice note
 * converted the same way. The leading newline and the three spaces before the first
 * word are whisper-cli's, not a typo.
 */
const REAL = "\n[00:00:00.000 --> 00:00:03.440]   Teste de transcrição, abacaxi e bicicleta.\n";

describe("parseWhisperStdout", () => {
  it("lê a saída real do binário", () => {
    expect(parseWhisperStdout(REAL)?.text).toBe("Teste de transcrição, abacaxi e bicicleta.");
  });

  it("junta vários segmentos numa linha só", () => {
    const two =
      "\n[00:00:00.000 --> 00:00:02.000]   Bora marcar amanhã?\n" +
      "[00:00:02.000 --> 00:00:04.500]   De manhã fica melhor pra mim.\n";
    const got = parseWhisperStdout(two)!;
    expect(got.segments).toHaveLength(2);
    expect(got.text).toBe("Bora marcar amanhã? De manhã fica melhor pra mim.");
  });

  // Silence exits 0 with nothing on stdout, so this is the normal quiet path and not
  // an error to report.
  it("stdout vazio devolve null", () => {
    expect(parseWhisperStdout("")).toBeNull();
    expect(parseWhisperStdout("\n\n")).toBeNull();
  });

  it("ignora linha que não é segmento, se o ruído do Metal vazar para o stdout", () => {
    const noisy =
      "ggml_metal_device_init: GPU name:   MTL0 (Apple M1)\n" +
      "load_backend: loaded MTL backend\n" +
      "[00:00:00.000 --> 00:00:01.000]   oi\n";
    expect(parseWhisperStdout(noisy)?.text).toBe("oi");
  });

  it("preserva acento e não quebra em resposta curta", () => {
    expect(parseWhisperStdout("[00:00:00.000 --> 00:00:00.500]   tá bom\n")?.text).toBe("tá bom");
    expect(parseWhisperStdout("[00:00:00.000 --> 00:00:00.400]   ok\n")?.text).toBe("ok");
  });
});

describe("looksLooped", () => {
  it("pega o decoder travado repetindo a mesma frase", () => {
    expect(looksLooped(Array(8).fill("obrigado"))).toBe(true);
    expect(looksLooped(["oi", "obrigado", "obrigado", "obrigado", "obrigado", "tchau"])).toBe(true);
  });

  // A real conversation reuses words but not whole segments, and a false positive
  // here throws away a transcript that cost GPU time.
  it("não confunde fala real com laço", () => {
    expect(looksLooped(["bora marcar", "amanhã de manhã", "às nove", "pode ser?"])).toBe(false);
  });

  it("não julga áudio curto demais para ter padrão", () => {
    expect(looksLooped(["oi", "oi"])).toBe(false);
    expect(looksLooped([])).toBe(false);
  });
});

describe("looksHallucinated", () => {
  // Measured against the real binary: silence with -l pt came back as
  // "Legenda por Sônia Ruberti", and with -l auto as "Thank you.". Neither is speech.
  it("pega o crédito de legenda que o modelo inventa em silêncio", () => {
    expect(looksHallucinated("Legenda por Sônia Ruberti")).toBe(true);
    expect(looksHallucinated("Legendas pela comunidade Amara.org")).toBe(true);
    expect(looksHallucinated("Legendado por qualquer pessoa")).toBe(true);
    expect(looksHallucinated("Tradução de Fulano de Tal")).toBe(true);
    expect(looksHallucinated("Subtitles by the Amara.org community")).toBe(true);
    expect(looksHallucinated("Thank you.")).toBe(true);
    expect(looksHallucinated("thanks for watching")).toBe(true);
  });

  // The expensive mistake would be discarding real speech, so the pattern has to be
  // the whole transcript and carry the credit's "por/de/by".
  it("não descarta fala real que só fala em legenda", () => {
    expect(looksHallucinated("a legenda do vídeo tá errada, dá uma olhada")).toBe(false);
    expect(looksHallucinated("obrigado pela força, viu")).toBe(false);
    expect(looksHallucinated("bora marcar amanhã de manhã")).toBe(false);
    expect(looksHallucinated("legenda")).toBe(false);
  });
});

describe("parseWhisperStdout: fim do último segmento", () => {
  // The independent signal: silence of 2 s, 4 s and 10 s all came back as one segment
  // ending at 29,98 s, because whisper pads its window and then fills it.
  it("informa em que segundo a transcrição termina", () => {
    expect(parseWhisperStdout("[00:00:00.000 --> 00:00:29.980]   Legenda por Alguém\n")?.endsAt).toBeCloseTo(29.98);
    expect(parseWhisperStdout("[00:01:00.000 --> 00:01:04.500]   oi\n")?.endsAt).toBeCloseTo(64.5);
  });
});
