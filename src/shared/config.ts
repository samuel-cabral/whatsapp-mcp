import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Absolute paths, always. The launchd PATH is /usr/bin:/bin:/usr/sbin:/sbin, so a
   *  bare `whisper-cli` resolves in a terminal and fails 100% of the time as a service. */
  whisperBin: string;
  ffmpegBin: string;
  whisperModel: string;
  /** Whisper language code, or "auto". See the measurement in transcribe.ts. */
  whisperLanguage: string;
}

export const defaultConfig = (home: string = homedir()): Config => ({
  whisperBin: "/opt/homebrew/bin/whisper-cli",
  ffmpegBin: "/opt/homebrew/bin/ffmpeg",
  whisperModel: join(home, ".cache/whisper-models/ggml-large-v3-turbo-q5_0.bin"),
  whisperLanguage: "pt",
});

/**
 * Reads ~/.whatsapp-mcp/config.json over the defaults.
 *
 * Missing is the normal case, not the exception — the file has never existed — so it
 * is silent. Malformed is loud but never fatal: a stray comma in a preferences file
 * must not stop the daemon from booting, because the thing it would stop is message
 * reception, and the cost of that is measured in days of lost conversation.
 */
export function loadConfig(file: string, home: string = homedir()): Config {
  const defaults = defaultConfig(home);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[whatsapp-daemon] ${file} está ilegível (${why}); usando os caminhos padrão.`);
    return defaults;
  }

  // Merged field by field: a config that names only the model keeps the default
  // binaries, instead of blanking them.
  const p = (parsed ?? {}) as Partial<Record<keyof Config, unknown>>;
  const pick = (key: keyof Config): string =>
    typeof p[key] === "string" && (p[key] as string).trim() !== "" ? (p[key] as string) : defaults[key];

  return {
    whisperBin: pick("whisperBin"),
    ffmpegBin: pick("ffmpegBin"),
    whisperModel: pick("whisperModel"),
    whisperLanguage: pick("whisperLanguage"),
  };
}
