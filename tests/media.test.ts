import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, type DB } from "../src/shared/migrations.js";
import { saveImage } from "../src/daemon/media.js";

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
