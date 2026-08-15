import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { connect } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, type DB } from "../src/shared/migrations.js";
import { DraftStore } from "../src/daemon/drafts.js";
import { startControlServer } from "../src/daemon/server.js";

let dir: string;
let db: DB;
let server: { close(): Promise<void> };
let socketFile: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wamcp-sock-"));
  socketFile = join(dir, "control.sock");
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO chats (jid, name) VALUES (?, ?)").run("5511999@s.whatsapp.net", "Igor");
  server = await startControlServer({
    socketFile,
    deps: {
      db,
      drafts: new DraftStore(),
      sender: { sendText: vi.fn(async () => "SENT"), fetchOlder: vi.fn(async () => 0) },
      connected: () => true,
    },
  });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function ask(cmd: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketFile);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify(cmd) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        sock.end();
        resolve(JSON.parse(buf.trim()));
      }
    });
    sock.on("error", reject);
  });
}

describe("startControlServer", () => {
  it("cria o socket com modo 0600", () => {
    expect(statSync(socketFile).mode & 0o777).toBe(0o600);
  });

  it("responde status em JSONL", async () => {
    const res = await ask({ cmd: "status" });
    expect(res.ok).toBe(true);
    expect(res.result.chatCount).toBe(1);
  });

  it("faz o ciclo draft → confirm por socket", async () => {
    const d = await ask({ cmd: "draft", jid: "5511999@s.whatsapp.net", text: "oi" });
    const c = await ask({ cmd: "confirm", draftId: d.result.draftId });
    expect(c.ok).toBe(true);
  });

  it("JSON inválido devolve erro em vez de derrubar o servidor", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const sock = connect(socketFile);
      let buf = "";
      sock.on("connect", () => sock.write("{isso não é json\n"));
      sock.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\n")) { sock.end(); resolve(JSON.parse(buf.trim())); }
      });
      sock.on("error", reject);
    });
    expect(res.ok).toBe(false);
    const after = await ask({ cmd: "status" });
    expect(after.ok).toBe(true);
  });
});
