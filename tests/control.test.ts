import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { DraftStore, DRAFT_TTL_MS } from "../src/daemon/drafts.js";
import { handleCommand } from "../src/daemon/control.js";

const IGOR = "5511999@s.whatsapp.net";

let db: DB;
let drafts: DraftStore;
let sendText: ReturnType<typeof vi.fn>;
let fetchOlder: ReturnType<typeof vi.fn>;
let deps: any;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO chats (jid, name) VALUES (?, ?)").run(IGOR, "Igor");
  drafts = new DraftStore();
  sendText = vi.fn(async () => "SENT1");
  fetchOlder = vi.fn(async () => 50);
  deps = { db, drafts, sender: { sendText, fetchOlder }, connected: () => true };
});

describe("DraftStore", () => {
  it("cria com id único e devolve o texto exato", () => {
    const a = drafts.create(IGOR, "oi");
    const b = drafts.create(IGOR, "oi");
    expect(a.id).not.toBe(b.id);
    expect(a.text).toBe("oi");
  });

  it("take consome: o segundo take devolve null", () => {
    const d = drafts.create(IGOR, "oi");
    expect(drafts.take(d.id)?.text).toBe("oi");
    expect(drafts.take(d.id)).toBeNull();
  });

  it("expira depois do TTL", () => {
    let now = 1_000_000;
    const store = new DraftStore(() => now);
    const d = store.create(IGOR, "oi");
    now += DRAFT_TTL_MS + 1;
    expect(store.take(d.id)).toBeNull();
  });
});

describe("handleCommand — a trava de envio", () => {
  it("draft não envia nada", async () => {
    const res = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    expect(res.ok).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("draft devolve id, texto exato e nome resolvido", async () => {
    const res: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    expect(res.result.draftId).toBeTruthy();
    expect(res.result.text).toBe("oi");
    expect(res.result.to).toBe("Igor");
  });

  it("confirm envia exatamente o texto guardado", async () => {
    const d: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "texto guardado" }, deps);
    const res: any = await handleCommand({ cmd: "confirm", draftId: d.result.draftId }, deps);
    expect(res.ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(IGOR, "texto guardado");
  });

  it("IGNORA qualquer texto anexado ao confirm — só o rascunho vale", async () => {
    const d: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "texto legítimo" }, deps);
    await handleCommand(
      { cmd: "confirm", draftId: d.result.draftId, text: "texto injetado", jid: "5599@s.whatsapp.net" } as any,
      deps,
    );
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(IGOR, "texto legítimo");
  });

  it("confirm com id inexistente falha sem enviar", async () => {
    const res = await handleCommand({ cmd: "confirm", draftId: "nao-existe" }, deps);
    expect(res.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("o mesmo rascunho não pode ser enviado duas vezes", async () => {
    const d: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    await handleCommand({ cmd: "confirm", draftId: d.result.draftId }, deps);
    const again = await handleCommand({ cmd: "confirm", draftId: d.result.draftId }, deps);
    expect(again.ok).toBe(false);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("draft para jid desconhecido falha antes de tocar no WhatsApp", async () => {
    const res = await handleCommand({ cmd: "draft", jid: "nao-existe@s.whatsapp.net", text: "oi" }, deps);
    expect(res.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("desconectado, o draft é recusado", async () => {
    deps.connected = () => false;
    const res = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    expect(res.ok).toBe(false);
  });

  it("comando desconhecido não derruba o daemon", async () => {
    const res = await handleCommand({ cmd: "rm -rf" }, deps);
    expect(res.ok).toBe(false);
  });

  it("comando malformado não derruba o daemon", async () => {
    expect((await handleCommand(null, deps)).ok).toBe(false);
    expect((await handleCommand({ cmd: "draft", jid: IGOR }, deps)).ok).toBe(false);
  });

  it("status responde sem depender de conexão", async () => {
    const res: any = await handleCommand({ cmd: "status" }, deps);
    expect(res.ok).toBe(true);
    expect(res.result.chatCount).toBe(1);
  });

  it("backfill repassa para o sender", async () => {
    const res: any = await handleCommand({ cmd: "backfill", jid: IGOR, pages: 2 }, deps);
    expect(res.ok).toBe(true);
    expect(fetchOlder).toHaveBeenCalledWith(IGOR, 2);
  });
});
