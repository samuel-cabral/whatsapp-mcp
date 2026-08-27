import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/shared/migrations.js";
import { DraftStore } from "../src/daemon/drafts.js";
import { startControlServer, claimSocketFile } from "../src/daemon/server.js";

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wamcp-lock-"));
  dirs.push(d);
  return d;
};

const boot = async (socketFile: string) => {
  const db = new Database(":memory:");
  migrate(db);
  const s = await startControlServer({
    socketFile,
    deps: {
      db,
      drafts: new DraftStore(),
      sender: { sendText: vi.fn(async () => "SENT"), fetchOlder: vi.fn(async () => 0) },
      connected: () => true,
    },
  });
  servers.push(s);
  return s;
};

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("trava de instância única", () => {
  it("recusa subir quando outro daemon já está escutando", async () => {
    const socketFile = join(newDir(), "control.sock");
    await boot(socketFile);

    // Este é o cenário de 25/08: um segundo daemon subindo ao lado do primeiro,
    // no mesmo ~/.whatsapp-mcp/auth, os dois avançando o mesmo ratchet Signal.
    await expect(boot(socketFile)).rejects.toThrow(/outro daemon já está escutando/);
  });

  it("a mensagem de erro diz como parar o outro", async () => {
    const socketFile = join(newDir(), "control.sock");
    await boot(socketFile);
    await expect(claimSocketFile(socketFile)).rejects.toThrow(/launchctl bootout/);
  });

  it("apaga socket órfão de um processo que morreu, em vez de travar para sempre", async () => {
    const socketFile = join(newDir(), "control.sock");
    // Arquivo existe mas ninguém escuta: é exatamente o que um crash deixa para trás.
    writeFileSync(socketFile, "");
    await expect(claimSocketFile(socketFile)).resolves.toBeUndefined();
    expect(existsSync(socketFile)).toBe(false);
  });

  it("não faz nada quando não há socket algum", async () => {
    const socketFile = join(newDir(), "control.sock");
    await expect(claimSocketFile(socketFile)).resolves.toBeUndefined();
  });

  it("depois que o primeiro sai, o segundo sobe normalmente", async () => {
    const socketFile = join(newDir(), "control.sock");
    const first = await boot(socketFile);
    await first.close();
    await expect(boot(socketFile)).resolves.toBeDefined();
  });
});
