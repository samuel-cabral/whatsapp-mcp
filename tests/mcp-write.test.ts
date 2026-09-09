import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestChats } from "../src/daemon/ingest.js";
import { createServer } from "../src/mcp/index.js";

const IGOR = "5511999@s.whatsapp.net";

let db: DB;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ingestChats(db, [{ id: IGOR, name: "Igor" }]);
  send = vi.fn(async (cmd: any) => {
    if (cmd.cmd === "draft") return { ok: true, result: { draftId: "D1", jid: cmd.jid, to: "Igor", text: cmd.text } };
    if (cmd.cmd === "confirm") return { ok: true, result: { sent: true, msgId: "S1", jid: IGOR } };
    if (cmd.cmd === "backfill") return { ok: true, result: { fetched: 50 } };
    return { ok: false, error: "?" };
  });
});

async function connectClient() {
  const server = createServer({ db, client: { send } as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (res: any) => res.content.map((c: any) => c.text).join("\n");

/** Same wiring as connectClient, but with the daemon's reply written per test. */
async function connectWith(reply: (cmd: any) => Promise<unknown>) {
  const server = createServer({ db, client: { send: reply } as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("tools de escrita", () => {
  it("draft_message não envia e mostra o texto exato para revisão", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "draft_message", arguments: { jid: IGOR, text: "oi Igor" } });
    expect(send).toHaveBeenCalledWith({ cmd: "draft", jid: IGOR, text: "oi Igor" });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: "confirm" }));
    expect(textOf(res)).toContain("oi Igor");
    expect(textOf(res)).toContain("D1");
  });

  it("confirm_send manda só o draftId ao daemon", async () => {
    const client = await connectClient();
    await client.callTool({ name: "confirm_send", arguments: { draftId: "D1" } });
    expect(send).toHaveBeenCalledWith({ cmd: "confirm", draftId: "D1" });
  });

  it("o schema de confirm_send não aceita texto", async () => {
    const client = await connectClient();
    const tool = (await client.listTools()).tools.find((t) => t.name === "confirm_send")!;
    expect(Object.keys((tool.inputSchema as any).properties ?? {})).toEqual(["draftId"]);
  });

  it("erro do daemon vira mensagem legível, não exceção", async () => {
    send = vi.fn(async () => ({ ok: false, error: "daemon fora do ar" }));
    const client = await connectClient();
    const res = await client.callTool({ name: "confirm_send", arguments: { draftId: "X" } });
    expect(textOf(res)).toContain("daemon fora do ar");
  });

  it("backfill_chat repassa jid e páginas", async () => {
    const client = await connectClient();
    await client.callTool({ name: "backfill_chat", arguments: { jid: IGOR, pages: 3 } });
    expect(send).toHaveBeenCalledWith({ cmd: "backfill", jid: IGOR, pages: 3 });
  });
});

describe("transcribe_audio", () => {
  it("repassa jid, msgId e force ao daemon", async () => {
    const sent: any[] = [];
    const client = await connectWith(async (cmd: any) => {
      sent.push(cmd);
      return { ok: true, result: { state: "done", text: "abacaxi" } };
    });
    const out = textOf(
      await client.callTool({ name: "transcribe_audio", arguments: { jid: IGOR, msgId: "A1", force: true } }),
    );
    expect(sent[0]).toEqual({ cmd: "transcribe", jid: IGOR, msgId: "A1", force: true });
    expect(out).toContain("(áudio, transcrito) abacaxi");
  });

  it("force é opcional e vira false", async () => {
    const sent: any[] = [];
    const client = await connectWith(async (cmd: any) => {
      sent.push(cmd);
      return { ok: true, result: { state: "done", text: "x" } };
    });
    await client.callTool({ name: "transcribe_audio", arguments: { jid: IGOR, msgId: "A1" } });
    expect(sent[0].force).toBe(false);
  });

  it("áudio sem fala não vira linha vazia", async () => {
    const client = await connectWith(async () => ({ ok: true, result: { state: "done", text: "" } }));
    const out = textOf(await client.callTool({ name: "transcribe_audio", arguments: { jid: IGOR, msgId: "A1" } }));
    expect(out).toContain("sem fala reconhecida");
  });

  it("ainda em andamento diz para reler, não mente dizendo que falhou", async () => {
    const client = await connectWith(async () => ({ ok: true, result: { state: "running" } }));
    const out = textOf(await client.callTool({ name: "transcribe_audio", arguments: { jid: IGOR, msgId: "A1" } }));
    expect(out).toContain("Ainda transcrevendo");
  });

  it("a recusa do daemon chega como texto legível, não como stack trace", async () => {
    const client = await connectWith(async () => ({
      ok: false,
      error: "esse áudio é anterior à transcrição automática, então o daemon não guardou a mídia dele.",
    }));
    const out = textOf(await client.callTool({ name: "transcribe_audio", arguments: { jid: IGOR, msgId: "OLD" } }));
    expect(out).toContain("anterior à transcrição automática");
  });
});
