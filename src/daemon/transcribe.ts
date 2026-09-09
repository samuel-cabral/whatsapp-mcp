import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.js";

/** How long a process that ignored SIGTERM gets before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * spawn with an argv array, never a shell. The jid, the message id and the chat name
 * all reach this module from outside, and a shell here would let a group named with a
 * backtick become a command.
 *
 * The kill is two-stage because SIGTERM is a request, not an order: whisper-cli in the
 * middle of a Metal kernel does not always answer it, and a job that outlives its own
 * timeout would pin the single worker for good.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; stdin?: Buffer },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"] });

    // Buffers concatenated at close, not chunk.toString() as they arrive: a multi-byte
    // character split across the chunk boundary decodes to U+FFFD, and Portuguese puts
    // an accent in about every other word.
    const out: Buffer[] = [];
    let err: Buffer[] = [];
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let hardKill: NodeJS.Timeout | null = null;

    const soft = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      hardKill.unref();
    }, opts.timeoutMs);
    soft.unref();

    child.stdout?.on("data", (c: Buffer) => out.push(c));

    // Every ggml/Metal/BLAS banner lands here, plus whisper's auto-detected language
    // line. Only the tail is ever useful, so it is capped where stdout is not.
    child.stderr?.on("data", (c: Buffer) => {
      err.push(c);
      errBytes += c.length;
      if (errBytes > 128 * 1024) {
        err = [Buffer.concat(err).subarray(-64 * 1024)];
        errBytes = err[0].length;
      }
    });

    // ffmpeg rejecting a corrupt input closes the pipe while we are still pushing opus
    // into it. The EPIPE that follows is the symptom; the real reason is in stderr and
    // in the exit code, so it must not surface as an unhandled error and hide them.
    if (opts.stdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(soft);
      if (hardKill) clearTimeout(hardKill);
      fn();
    };

    // ENOENT lands here rather than on 'close': it means the binary itself is missing,
    // which is an environment problem and not this job's fault.
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code, signal) =>
      finish(() =>
        resolve({
          code,
          signal,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          timedOut,
        }),
      ),
    );
  });
}

export interface WhisperSegment {
  text: string;
}

/**
 * whisper-cli prints one line per segment, `[00:00:00.000 --> 00:00:04.360]   texto`,
 * with a leading newline and three spaces before the first word. Everything else it
 * emits — the Metal banner, the model load, the timings — goes to stderr.
 *
 * A pure function, exported on its own so the format can be tested against captured
 * output without running the binary, the same way shouldReplenishPreKeys is tested
 * without a socket.
 */
export function parseWhisperStdout(
  stdout: string,
): { text: string; segments: string[]; endsAt: number } | null {
  const segments: string[] = [];
  let endsAt = 0;
  for (const line of stdout.split("\n")) {
    const m = /^\s*\[[0-9:.]+\s*-->\s*([0-9]+):([0-9]+):([0-9.]+)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const piece = m[4].replace(/\s+/g, " ").trim();
    if (!piece) continue;
    segments.push(piece);
    endsAt = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  if (segments.length === 0) return null;
  return { text: segments.join(" ").replace(/\s+/g, " ").trim(), segments, endsAt };
}

/**
 * Whisper does not fail on silence, it invents. Trained on scraped subtitles, it fills
 * an empty window with the credit line those subtitles end on.
 *
 * Matched against the WHOLE transcript, never as a substring: "obrigado por assistir"
 * inside a real sentence is a real sentence.
 */
const HALLUCINATED_WHOLE = new Set([
  "legendas pela comunidade amara.org",
  "legendado pela comunidade amara.org",
  "subtitles by the amara.org community",
  "amara.org",
  "obrigado por assistir",
  "obrigado por assistir!",
  "thanks for watching",
  "thanks for watching!",
  // Measured: four seconds of digital silence through this exact argv came back as
  // "Thank you." — -sns suppresses non-speech tokens, not invented speech. Listed at
  // the cost of dropping a genuine one-word "thank you", which is recoverable with
  // transcribe_audio and far cheaper than attributing a sentence to someone who was
  // silent.
  "thank you",
  "thank you.",
  "thank you!",
  "muito obrigado pela atenção",
  "[blank_audio]",
  "[música]",
  "[music]",
  "you",
  ".",
]);

/**
 * The same hallucination in Portuguese is a whole family, not a phrase: silence came
 * back as "Legenda por Sônia Ruberti" — a real subtitler's credit, one of dozens of
 * names the model saw in its scraped training subtitles. Listing the names would be
 * whack-a-mole, so this matches the shape of a credit line instead.
 */
const CREDIT_LINE =
  /^(legenda[s]?|legendado|legendagem|tradu(ç|c)(ã|a)o|revis(ã|a)o|sincroniza(ç|c)(ã|a)o|subtitle[s]?|subtitled)\b.{0,60}$/i;

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The other failure mode is a loop: the decoder latches onto one phrase and emits it
 * until the audio ends.
 *
 * Detected by segment repetition, deliberately not by type/token ratio: vocabulary
 * richness falls with length (Zipf), so a TTR threshold would put a legitimate
 * forty-minute note one step from the cut and throw its transcript away in silence.
 */
/** True when the transcript is a subtitle credit rather than something anyone said. */
export function looksHallucinated(text: string): boolean {
  const t = normalize(text);
  if (HALLUCINATED_WHOLE.has(t)) return true;
  // The credit shape only counts when it IS the transcript: "a legenda do vídeo tá
  // errada" is a real thing to say.
  return CREDIT_LINE.test(t) && /\b(por|pela|de|by)\b/.test(t);
}

export function looksLooped(segments: string[]): boolean {
  if (segments.length < 4) return false;
  const counts = new Map<string, number>();
  for (const s of segments) {
    const k = normalize(s);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const worst = Math.max(...counts.values());
  return worst > segments.length / 2;
}

export type TranscribeOutcome =
  | { status: "ok"; text: string }
  /** We listened and there was nothing to hear. Distinct from "nobody tried". */
  | { status: "empty"; reason: string }
  | { status: "failed"; reason: string; permanent: boolean }
  /** A binary or the model is missing. Not this job's fault, and charging 8.8k
   *  messages for it would turn an install problem into a wall of permanent failures. */
  | { status: "environment"; reason: string };

/** 16 kHz mono s16le is what whisper.cpp feeds the model without resampling. */
const SAMPLE_RATE = 16_000;
const FFMPEG_TIMEOUT_MS = 120_000;

/**
 * Measured on this machine (M1, ggml-large-v3-turbo-q5_0): 3,2 s of wall clock for
 * 4,4 s of audio with the model warm, and 107 s for a six-second clip with the 547 MB
 * model cold, which is why the fixed part is 60 s and not 5.
 *
 * Deliberately uncapped. A ceiling of ten minutes would silently kill any note longer
 * than about thirteen — and WhatsApp allows far longer ones — while ffmpeg's own -t
 * already bounds the input at an hour.
 */
const whisperBudgetMs = (seconds: number): number => 60_000 + Math.max(0, seconds) * 3_000;

const tail = (stderr: string): string =>
  stderr.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "sem detalhe";

const isMissingBinary = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException)?.code === "ENOENT" || (err as NodeJS.ErrnoException)?.code === "EACCES";

/**
 * Opus bytes in, transcript out.
 *
 * This function owns the whole scratch lifecycle — mkdtemp, ffmpeg, whisper, delete —
 * in a try/finally. The finally is what makes "no audio is persisted" true for every
 * failure short of SIGKILL, which sweepTmp covers on the next boot. The queue only
 * ever hands over bytes.
 */
export async function transcribeAudio(
  bytes: Buffer,
  cfg: Config & { tmpRoot: string },
  hintSeconds = 0,
): Promise<TranscribeOutcome> {
  let dir: string;
  try {
    dir = await mkdtemp(join(cfg.tmpRoot, "audio-"));
  } catch (err) {
    return { status: "environment", reason: `sem diretório temporário: ${String(err)}` };
  }

  try {
    const wav = join(dir, "audio.wav");

    // whisper-cli lists ogg as supported, but its ogg decoder is stb_vorbis and a
    // WhatsApp voice note is `audio/ogg; codecs=opus`, which stb_vorbis cannot open.
    // Converting is not an optimisation, it is the only way in.
    let conv: RunResult;
    try {
      conv = await run(
        cfg.ffmpegBin,
        [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-i", "pipe:0",
          "-vn", "-sn", "-dn", "-map", "0:a:0",
          "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le",
          "-t", "3600",
          "-f", "wav", wav,
        ],
        { timeoutMs: FFMPEG_TIMEOUT_MS, stdin: bytes },
      );
    } catch (err) {
      if (isMissingBinary(err)) return { status: "environment", reason: `ffmpeg não encontrado em ${cfg.ffmpegBin}` };
      throw err;
    }

    if (conv.timedOut) return { status: "failed", reason: "ffmpeg travou na conversão", permanent: true };
    if (conv.code !== 0) {
      return { status: "failed", reason: `áudio ilegível: ${tail(conv.stderr)}`, permanent: true };
    }

    // The file is written, never piped: `whisper-cli -f -` exits 0 with empty stdout,
    // which would turn every voice note into "sem fala reconhecida" and look like the
    // feature working.
    let out: RunResult;
    try {
      out = await run(
        cfg.whisperBin,
        [
          "-m", cfg.whisperModel,
          "-f", wav,
          // Portuguese by default, not "auto". Measured on this machine with the
          // turbo model: a clearly pt-BR clip was auto-detected as `en` at p=0.91 and
          // came back as "Tista Transcriseo ... Boromacara Manta de Manta", while the
          // same clip with -l pt gave "Teste Transcrição, Abacaxi e Bicicleta". The
          // fear that forcing a language would wreck English notes did not hold up:
          // an English clip transcribed identically under -l pt and -l auto, because
          // the flag steers decoding rather than translating. Overridable in
          // config.json for anyone whose inbox is mostly another language.
          "-l", cfg.whisperLanguage,
          // Non-speech token suppression: whisper.cpp's own documented mitigation for
          // the invented-sentence-over-silence failure.
          "-sns",
        ],
        { timeoutMs: whisperBudgetMs(hintSeconds) },
      );
    } catch (err) {
      if (isMissingBinary(err)) return { status: "environment", reason: `whisper não encontrado em ${cfg.whisperBin}` };
      throw err;
    }

    if (out.timedOut) {
      // Permanent on the first occurrence, not after three: a job that already burned
      // its whole budget would pin the single worker for three more cycles to reach
      // the same verdict.
      return { status: "failed", reason: "a transcrição estourou o tempo limite", permanent: true };
    }
    if (out.code !== 0) {
      const why = tail(out.stderr);
      if (/failed to initialize|no such file|unable to load model/i.test(why)) {
        return { status: "environment", reason: `modelo não carregou: ${why}` };
      }
      return { status: "failed", reason: `whisper falhou: ${why}`, permanent: false };
    }

    const parsed = parseWhisperStdout(out.stdout);
    if (!parsed) return { status: "empty", reason: "nenhuma fala reconhecida" };
    if (looksHallucinated(parsed.text)) {
      return { status: "empty", reason: "só ruído: o modelo devolveu crédito de legenda" };
    }
    // A second, independent signal, measured: silence of 2 s, 4 s and 10 s all came
    // back as one segment ending at 29,98 s — whisper pads its window and then fills
    // it. A transcript that claims to run far past the note's own length did not come
    // from the note. Only applied when the sender's duration hint exists and the gap
    // is large, so ordinary rounding never trips it.
    if (hintSeconds > 0 && parsed.endsAt > hintSeconds * 2 + 10) {
      return { status: "empty", reason: "só ruído: o texto não corresponde à duração do áudio" };
    }
    if (looksLooped(parsed.segments)) {
      return { status: "empty", reason: "o modelo entrou em laço; transcrição descartada" };
    }

    return { status: "ok", text: parsed.text };
  } finally {
    // The reason nothing is persisted. Covers every throw above; SIGKILL is covered by
    // sweepTmp on the next boot.
    rmSync(dir, { recursive: true, force: true });
  }
}
