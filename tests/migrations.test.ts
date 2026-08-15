import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate, SCHEMA_VERSION } from "../src/shared/migrations.js";

function fresh() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("migrate", () => {
  it("cria todas as tabelas e grava a versão", () => {
    const db = fresh();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r: any) => r.name);
    for (const t of ["chats", "contacts", "messages", "messages_fts", "sync_state", "meta"]) {
      expect(names).toContain(t);
    }
    const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any;
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
  });

  it("é idempotente: rodar de novo não quebra nem duplica", () => {
    const db = fresh();
    expect(() => migrate(db)).not.toThrow();
    const rows = db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'schema_version'").get() as any;
    expect(rows.n).toBe(1);
  });

  it("o índice FTS ignora acento e caixa", () => {
    const db = fresh();
    db.prepare(
      "INSERT INTO messages (chat_jid, msg_id, timestamp, type, text) VALUES (?,?,?,?,?)",
    ).run("5511@s.whatsapp.net", "A1", 1000, "text", "Reunião amanhã às 9");
    const hit = db
      .prepare("SELECT m.text FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?")
      .all("reuniao");
    expect(hit).toHaveLength(1);
  });

  it("o trigger de update mantém o FTS em sincronia", () => {
    const db = fresh();
    db.prepare(
      "INSERT INTO messages (chat_jid, msg_id, timestamp, type, text) VALUES (?,?,?,?,?)",
    ).run("5511@s.whatsapp.net", "A1", 1000, "text", "texto antigo");
    db.prepare("UPDATE messages SET text = ? WHERE msg_id = ?").run("texto novo", "A1");
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("antigo")).toHaveLength(0);
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("novo")).toHaveLength(1);
  });
});
