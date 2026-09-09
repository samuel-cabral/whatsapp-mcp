import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultConfig } from "../src/shared/config.js";

const scratch = () => mkdtempSync(join(tmpdir(), "wa-cfg-"));

describe("loadConfig", () => {
  // The file has never existed on this machine, so absent is the normal path.
  it("arquivo ausente devolve os defaults, em silêncio", () => {
    expect(loadConfig("/nao/existe/config.json", "/home/x")).toEqual(defaultConfig("/home/x"));
  });

  it("os defaults são absolutos: o PATH do launchd não tem o Homebrew", () => {
    const c = defaultConfig("/home/x");
    expect(c.whisperBin.startsWith("/")).toBe(true);
    expect(c.ffmpegBin.startsWith("/")).toBe(true);
    expect(c.whisperModel.startsWith("/")).toBe(true);
  });

  // A stray comma in a preferences file must not stop the daemon from booting: what
  // it would stop is message reception, and that is measured in days of lost history.
  it("JSON quebrado cai nos defaults sem lançar", () => {
    const dir = scratch();
    const f = join(dir, "config.json");
    writeFileSync(f, "{ isso não é json,,, }");
    expect(() => loadConfig(f, "/home/x")).not.toThrow();
    expect(loadConfig(f, "/home/x")).toEqual(defaultConfig("/home/x"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("config parcial mantém os outros defaults em vez de zerá-los", () => {
    const dir = scratch();
    const f = join(dir, "config.json");
    writeFileSync(f, JSON.stringify({ whisperModel: "/meu/modelo.bin" }));
    const c = loadConfig(f, "/home/x");
    expect(c.whisperModel).toBe("/meu/modelo.bin");
    expect(c.ffmpegBin).toBe(defaultConfig("/home/x").ffmpegBin);
    expect(c.whisperLanguage).toBe("pt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("valor vazio ou de outro tipo não sobrescreve o default", () => {
    const dir = scratch();
    const f = join(dir, "config.json");
    writeFileSync(f, JSON.stringify({ whisperBin: "", ffmpegBin: 42 }));
    const c = loadConfig(f, "/home/x");
    expect(c.whisperBin).toBe(defaultConfig("/home/x").whisperBin);
    expect(c.ffmpegBin).toBe(defaultConfig("/home/x").ffmpegBin);
    rmSync(dir, { recursive: true, force: true });
  });
});
