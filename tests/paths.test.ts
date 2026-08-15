import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureDirs } from "../src/shared/paths.js";

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
