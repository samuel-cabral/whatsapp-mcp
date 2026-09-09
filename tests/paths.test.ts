import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureDirs, sweepTmp } from "../src/shared/paths.js";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "wamcp-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("deriva todos os caminhos de ~/.whatsapp-mcp", () => {
    const home = tempHome();
    const p = resolvePaths(home);
    expect(p.root).toBe(join(home, ".whatsapp-mcp"));
    expect(p.authDir).toBe(join(p.root, "auth"));
    expect(p.dbFile).toBe(join(p.root, "store.db"));
    expect(p.socketFile).toBe(join(p.root, "control.sock"));
    expect(p.configFile).toBe(join(p.root, "config.json"));
  });
});

describe("ensureDirs", () => {
  it("cria root e auth com modo 0700", () => {
    const p = resolvePaths(tempHome());
    ensureDirs(p);
    expect(statSync(p.root).mode & 0o777).toBe(0o700);
    expect(statSync(p.authDir).mode & 0o777).toBe(0o700);
  });

  it("é idempotente", () => {
    const p = resolvePaths(tempHome());
    ensureDirs(p);
    expect(() => ensureDirs(p)).not.toThrow();
  });
});

describe("sweepTmp", () => {
  it("apaga o entulho e recria o diretório dono-só", () => {
    const home = mkdtempSync(join(tmpdir(), "wa-sweep-"));
    const paths = resolvePaths(home);
    ensureDirs(paths);
    mkdirSync(paths.tmpDir, { recursive: true });

    // Decoded WAV is plaintext conversation. A SIGKILL — which is what
    // `launchctl kickstart -k` sends — never runs a finally block, so this sweep is
    // the only thing standing between a crash and somebody's audio sitting on disk.
    writeFileSync(join(paths.tmpDir, "audio.wav"), "conversa em claro");
    sweepTmp(paths);

    expect(existsSync(paths.tmpDir)).toBe(true);
    expect(readdirSync(paths.tmpDir)).toEqual([]);
    expect(statSync(paths.tmpDir).mode & 0o777).toBe(0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it("funciona quando o diretório ainda não existe", () => {
    const home = mkdtempSync(join(tmpdir(), "wa-sweep2-"));
    const paths = resolvePaths(home);
    expect(() => sweepTmp(paths)).not.toThrow();
    expect(existsSync(paths.tmpDir)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
