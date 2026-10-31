import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, type DB } from "../src/shared/migrations.js";
import { resolveMsgId, saveDocument, saveImage, MAX_DOCUMENT_BYTES } from "../src/daemon/media.js";

const CHAT = "5511@s.whatsapp.net";
const REF = JSON.stringify({ mediaKey: "AQI=", directPath: "/v/img", mimetype: "image/jpeg" });

let db: DB;
let dir: string;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  const ins = db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, media_ref) VALUES (?, ?, 1000, ?, ?)");
  ins.run(CHAT, "I1", "image", REF);
  ins.run(CHAT, "I2", "image", null);
  ins.run(CHAT, "T1", "text", null);
});

describe("saveImage", () => {
  it("baixa, grava owner-only e devolve caminho e tipo", async () => {
    const fetcher = { fetchImage: vi.fn(async () => Buffer.from("jpeg-bytes")) };
    const res = await saveImage(db, fetcher, dir, CHAT, "I1");
    expect(res).toEqual({ ok: true, image: { path: join(dir, "I1.jpg"), mimetype: "image/jpeg", bytes: 10 } });
    expect(readFileSync(join(dir, "I1.jpg"), "utf8")).toBe("jpeg-bytes");
    expect(statSync(join(dir, "I1.jpg")).mode & 0o777).toBe(0o600);
  });

  // The copy on disk outlives WhatsApp serving the original, so a second ask must not
  // go back to the network.
  it("a segunda vez usa o arquivo já salvo", async () => {
    const fetcher = { fetchImage: vi.fn(async () => Buffer.from("x")) };
    await saveImage(db, fetcher, dir, CHAT, "I1");
    await saveImage(db, fetcher, dir, CHAT, "I1");
    expect(fetcher.fetchImage).toHaveBeenCalledTimes(1);
  });

  it("recusa o que não é imagem e imagem sem descritor", async () => {
    const fetcher = { fetchImage: vi.fn() };
    expect(await saveImage(db, fetcher, dir, CHAT, "T1")).toMatchObject({ ok: false });
    const noRef = await saveImage(db, fetcher, dir, CHAT, "I2");
    expect(noRef).toMatchObject({ ok: false });
    expect((noRef as any).error).toContain("veja no celular");
    expect(fetcher.fetchImage).not.toHaveBeenCalled();
  });

  it("404 vira 'o WhatsApp não serve mais' e não deixa arquivo", async () => {
    const fetcher = { fetchImage: vi.fn(async () => { throw new Error("Failed to fetch stream from x: 404"); }) };
    const res = await saveImage(db, fetcher, dir, CHAT, "I1");
    expect((res as any).error).toContain("não serve mais");
    expect(() => statSync(join(dir, "I1.jpg"))).toThrow();
  });
});

describe("saveDocument", () => {
  const DOC = JSON.stringify({
    mediaKey: "AQI=", directPath: "/v/doc", mimetype: "application/pdf", fileName: "../Contrato Final (1).pdf",
  });

  beforeEach(() => {
    const ins = db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, media_ref) VALUES (?, ?, 1000, ?, ?)");
    ins.run(CHAT, "D1", "document", DOC);
    ins.run(CHAT, "D2", "document", null);
  });

  it("baixa o PDF, sanitiza o nome do remetente e grava owner-only", async () => {
    const fetcher = { fetchDocument: vi.fn(async () => Buffer.from("%PDF-1.4")) };
    const res = await saveDocument(db, fetcher, dir, CHAT, "D1");
    const path = join(dir, "D1_Contrato_Final_1_.pdf");
    expect(res).toEqual({
      ok: true,
      document: { path, mimetype: "application/pdf", bytes: 8, fileName: "../Contrato Final (1).pdf" },
    });
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.4");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a segunda vez usa o arquivo salvo", async () => {
    const fetcher = { fetchDocument: vi.fn(async () => Buffer.from("x")) };
    await saveDocument(db, fetcher, dir, CHAT, "D1");
    await saveDocument(db, fetcher, dir, CHAT, "D1");
    expect(fetcher.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("recusa o que não é documento e documento sem descritor", async () => {
    const fetcher = { fetchDocument: vi.fn() };
    expect(await saveDocument(db, fetcher, dir, CHAT, "I1")).toMatchObject({ ok: false });
    const noRef = await saveDocument(db, fetcher, dir, CHAT, "D2");
    expect((noRef as any).error).toContain("veja no celular");
    expect(fetcher.fetchDocument).not.toHaveBeenCalled();
  });

  it("404 vira 'não serve mais'", async () => {
    const fetcher = { fetchDocument: vi.fn(async () => { throw new Error("stream: 404"); }) };
    expect(((await saveDocument(db, fetcher, dir, CHAT, "D1")) as any).error).toContain("não serve mais");
  });
});

describe("resolveMsgId com lid", () => {
  const LID = "9988@lid";

  it("acha a mensagem guardada sob o lid quando o chamador passa o numero", () => {
    db.prepare("INSERT INTO lid_map (lid, pn) VALUES (?, ?)").run(LID, CHAT);
    db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, media_ref) VALUES (?, ?, 1000, 'image', ?)").run(LID, "L1ABCDEFGH", REF);
    expect(resolveMsgId(db, CHAT, "L1ABCDEFGH")).toEqual({ msgId: "L1ABCDEFGH", chatJid: LID });
    expect(resolveMsgId(db, CHAT, "L1ABCDEF…")).toEqual({ msgId: "L1ABCDEFGH", chatJid: LID });
  });

  it("sem vinculo no lid_map a busca continua restrita a conversa", () => {
    db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, media_ref) VALUES (?, ?, 1000, 'image', ?)").run(LID, "L2ABCDEFGH", REF);
    expect("error" in resolveMsgId(db, CHAT, "L2ABCDEFGH")).toBe(true);
  });

  it("mensagem arquivada sob os dois jids devolve a copia que ainda tem o descritor", () => {
    db.prepare("INSERT INTO lid_map (lid, pn) VALUES (?, ?)").run(LID, CHAT);
    const ins = db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, media_ref) VALUES (?, ?, 1000, 'image', ?)");
    ins.run(CHAT, "L3ABCDEFGH", null);
    ins.run(LID, "L3ABCDEFGH", REF);
    expect(resolveMsgId(db, CHAT, "L3ABCDEFGH")).toEqual({ msgId: "L3ABCDEFGH", chatJid: LID });
  });
});

describe("saveDocument: limite de tamanho", () => {
  it("recusa pelo tamanho declarado sem baixar nada", async () => {
    const big = JSON.stringify({ mediaKey: "AQI=", directPath: "/v/d", mimetype: "application/pdf", fileName: "x.pdf", fileLength: MAX_DOCUMENT_BYTES + 1 });
    db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, media_ref) VALUES (?, 'BIG', 1000, 'document', ?)").run(CHAT, big);
    const fetcher = { fetchDocument: vi.fn() };
    const res: any = await saveDocument(db, fetcher, dir, CHAT, "BIG");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("grande demais");
    expect(fetcher.fetchDocument).not.toHaveBeenCalled();
  });
});
