import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, transcribeAudio } from "../src/daemon/transcribe.js";

/**
 * Real child processes, driven through process.execPath, in the same spirit as
 * control-server.test.ts opening a real unix socket. Mocking spawn here would test the
 * mock: the whole point of this file is the contract with an actual OS process.
 */
let scratch: string;
const script = (body: string): string => {
  scratch ??= mkdtempSync(join(tmpdir(), "wa-run-"));
  const file = join(scratch, `s${Math.abs(hash(body))}.mjs`);
  writeFileSync(file, body);
  return file;
};
const hash = (s: string): number => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

describe("run", () => {
  it("devolve stdout e código de saída", async () => {
    const r = await run(process.execPath, [script('process.stdout.write("oi")')], { timeoutMs: 5_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("oi");
    expect(r.timedOut).toBe(false);
  });

  it("separa stderr de stdout: o ruído do Metal não polui a transcrição", async () => {
    const r = await run(
      process.execPath,
      [script('process.stderr.write("ggml_metal_device_init: GPU\\n"); process.stdout.write("texto")')],
      { timeoutMs: 5_000 },
    );
    expect(r.stdout).toBe("texto");
    expect(r.stderr).toContain("ggml_metal");
  });

  it("carrega o stderr quando o processo falha, que é onde está o motivo", async () => {
    const r = await run(
      process.execPath,
      [script('process.stderr.write("Invalid data found when processing input\\n"); process.exit(1)')],
      { timeoutMs: 5_000 },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid data");
  });

  // A job that outlives its own timeout would pin the single worker forever.
  it("mata o filho no timeout e sinaliza timedOut", async () => {
    const r = await run(process.execPath, [script("setInterval(() => {}, 1000)")], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code === null || r.code !== 0).toBe(true);
  });

  it("ENOENT rejeita, para o chamador poder chamar de problema de ambiente", async () => {
    await expect(run("/nao/existe/whisper-cli", [], { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("escreve o stdin e não estoura quando o filho fecha o pipe cedo", async () => {
    const r = await run(process.execPath, [script('process.stdout.write("fechado"); process.exit(0)')], {
      timeoutMs: 5_000,
      stdin: Buffer.alloc(2 * 1024 * 1024, 7),
    });
    expect(r.stdout).toBe("fechado");
  });

  // Portuguese puts an accent in about every other word, and a multi-byte character
  // split across the chunk boundary would decode to U+FFFD.
  it("não corrompe acento na fronteira de chunk", async () => {
    const body =
      'const s = "coração ".repeat(20000); for (const c of Buffer.from(s)) process.stdout.write(Buffer.from([c]));';
    const r = await run(process.execPath, [script(body)], { timeoutMs: 15_000 });
    expect(r.stdout).not.toContain("�");
    expect(r.stdout.startsWith("coração")).toBe(true);
  });

  it("não trunca stdout grande", async () => {
    const r = await run(process.execPath, [script('process.stdout.write("x".repeat(400000))')], {
      timeoutMs: 10_000,
    });
    expect(r.stdout).toHaveLength(400000);
  });
});

describe("transcribeAudio limpa o rastro", () => {
  const cfg = (over: Record<string, string> = {}) => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "wa-tmp-"));
    return {
      tmpRoot,
      ffmpegBin: "/nao/existe/ffmpeg",
      whisperBin: "/nao/existe/whisper",
      whisperModel: "/nao/existe/modelo.bin",
      whisperLanguage: "pt",
      ...over,
    };
  };

  it("binário ausente vira 'environment', não falha permanente da mensagem", async () => {
    const c = cfg();
    const out = await transcribeAudio(Buffer.from("nao e audio"), c);
    expect(out.status).toBe("environment");
    rmSync(c.tmpRoot, { recursive: true, force: true });
  });

  // The finally block is what makes "no audio is persisted" true for every failure
  // short of SIGKILL. Decoded WAV is plaintext conversation.
  it("não deixa WAV em claro no disco quando o pipeline falha", async () => {
    const c = cfg({ ffmpegBin: process.execPath });
    await transcribeAudio(Buffer.from("qualquer coisa"), c);
    expect(existsSync(c.tmpRoot)).toBe(true);
    expect(readdirSync(c.tmpRoot)).toEqual([]);
    rmSync(c.tmpRoot, { recursive: true, force: true });
  });
});
