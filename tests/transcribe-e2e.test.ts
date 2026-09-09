import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { transcribeAudio } from "../src/daemon/transcribe.js";
import { defaultConfig } from "../src/shared/config.js";

const cfg = defaultConfig();
const usable =
  existsSync(cfg.whisperModel) && existsSync(cfg.whisperBin) && existsSync(cfg.ffmpegBin);

/**
 * The only test that runs the real binaries, and the only one that can catch an argv
 * mistake. Every other test in this suite mocks the transcriber, so a wrong flag would
 * sail through all of them and turn every voice note into "sem fala reconhecida" in
 * production — which reads exactly like the feature working on a quiet day.
 *
 * Skipped when the toolchain is absent, so CI, which has neither ffmpeg nor a 547 MB
 * model, stays green.
 */
describe.skipIf(!usable)("ponta a ponta com os binários de verdade", () => {
  it("opus do WhatsApp entra, texto sai", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "wa-e2e-"));
    try {
      // Built the way WhatsApp sends one: ogg/opus, mono, 48 kHz.
      const speech = join(scratch, "s.aiff");
      const ogg = join(scratch, "s.ogg");
      execFileSync("/usr/bin/say", ["-v", "Flo", "-o", speech, "abacaxi e bicicleta"]);
      execFileSync(cfg.ffmpegBin, [
        "-v", "error", "-y", "-i", speech,
        "-c:a", "libopus", "-b:a", "24k", "-ar", "48000", "-ac", "1",
        "-f", "ogg", ogg,
      ]);

      const bytes = execFileSync("/bin/cat", [ogg], { maxBuffer: 32 * 1024 * 1024 });
      const out = await transcribeAudio(bytes, { ...cfg, tmpRoot: scratch }, 3);

      // Not asserting the words: speech recognition of a synthetic voice is not a
      // stable contract. Asserting that stdout parsed at all is, and that is exactly
      // what `-f -` silently broke.
      expect(out.status).toBe("ok");
      if (out.status === "ok") expect(out.text.length).toBeGreaterThan(3);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  it("silêncio não vira frase inventada", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "wa-sil-"));
    try {
      const ogg = join(scratch, "sil.ogg");
      execFileSync(cfg.ffmpegBin, [
        "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
        "-t", "4", "-c:a", "libopus", "-f", "ogg", ogg,
      ]);
      const bytes = execFileSync("/bin/cat", [ogg], { maxBuffer: 8 * 1024 * 1024 });
      const out = await transcribeAudio(bytes, { ...cfg, tmpRoot: scratch }, 4);

      // Measured: four seconds of digital silence came back as "Thank you." through
      // this exact argv. -sns suppresses non-speech tokens, not invented speech, so
      // the blocklist is what has to catch it.
      expect(out.status).toBe("empty");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
