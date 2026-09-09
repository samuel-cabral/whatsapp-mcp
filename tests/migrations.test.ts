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

/**
 * The v1 schema, verbatim, so the upgrade path is exercised against the shape that is
 * actually on disk in ~/.whatsapp-mcp/store.db rather than against a guess at it.
 */
const V1_SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY, chat_jid TEXT NOT NULL, msg_id TEXT NOT NULL,
  sender_jid TEXT, from_me INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL,
  type TEXT NOT NULL, text TEXT, quoted_id TEXT, UNIQUE (chat_jid, msg_id)
);
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text, content='messages', content_rowid='id', tokenize="unicode61 remove_diacritics 2"
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** A v1 database with data in it, which is the only interesting case. */
function v1WithData() {
  const db = new Database(":memory:");
  db.exec(V1_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  const ins = db.prepare(
    "INSERT INTO messages (chat_jid, msg_id, timestamp, type, text) VALUES (?,?,?,?,?)",
  );
  ins.run("5511@s.whatsapp.net", "T1", 1000, "text", "Reunião amanhã às 9");
  ins.run("5511@s.whatsapp.net", "A1", 1001, "audio", null);
  return db;
}

const columns = (db: any, table: string) =>
  new Set((db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as any[]).map((r) => r.name));

describe("migração v1 → v2", () => {
  it("acrescenta as seis colunas de transcrição sem tocar nos dados", () => {
    const db = v1WithData();
    migrate(db);
    const cols = columns(db, "messages");
    for (const c of [
      "transcript", "transcript_status", "transcript_at",
      "transcript_attempts", "transcript_error", "media_ref",
    ]) {
      expect(cols).toContain(c);
    }
    expect((db.prepare("SELECT count(*) AS n FROM messages").get() as any).n).toBe(2);
  });

  it("não enfileira nada do histórico: todo transcript_status continua NULL", () => {
    const db = v1WithData();
    migrate(db);
    const n = db
      .prepare("SELECT count(*) AS n FROM messages WHERE transcript_status IS NOT NULL")
      .get() as any;
    expect(n.n).toBe(0);
  });

  it("o FTS vira de duas colunas e o texto v1 continua buscável", () => {
    const db = v1WithData();
    migrate(db);
    expect(columns(db, "messages_fts")).toContain("transcript");
    // Depends on the 'rebuild': the old index was dropped, so without it this is empty.
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("reuniao"),
    ).toHaveLength(1);
  });

  it("o índice FTS fica íntegro depois do rebuild", () => {
    const db = v1WithData();
    migrate(db);
    expect(() =>
      db.prepare("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')").run(),
    ).not.toThrow();
  });

  it("a transcrição entra no FTS e é achável", () => {
    const db = v1WithData();
    migrate(db);
    db.prepare("UPDATE messages SET transcript = ? WHERE msg_id = ?").run("abacaxi e bicicleta", "A1");
    const hit = db
      .prepare("SELECT m.msg_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?")
      .all("abacaxi") as any[];
    expect(hit.map((r) => r.msg_id)).toEqual(["A1"]);
  });

  it("escrever só o status não mexe no índice (o trigger é UPDATE OF)", () => {
    const db = v1WithData();
    migrate(db);
    db.prepare("UPDATE messages SET transcript = ? WHERE msg_id = ?").run("abacaxi", "A1");
    db.prepare("UPDATE messages SET transcript_status = 'done' WHERE msg_id = ?").run("A1");
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("abacaxi")).toHaveLength(1);
  });

  it("migrar duas vezes não quebra nem duplica o índice", () => {
    const db = v1WithData();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("reuniao")).toHaveLength(1);
  });

  it("se auto-cura quando a linha de versão some", () => {
    const db = v1WithData();
    migrate(db);
    db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    expect(columns(db, "messages")).toContain("transcript");
  });

  it("grava transcription_since uma vez e não o reescreve depois", () => {
    const db = v1WithData();
    migrate(db);
    const first = (db.prepare("SELECT value FROM meta WHERE key = 'transcription_since'").get() as any).value;
    expect(Number(first)).toBeGreaterThan(0);
    migrate(db);
    const second = (db.prepare("SELECT value FROM meta WHERE key = 'transcription_since'").get() as any).value;
    expect(second).toBe(first);
  });

  it("a consulta da fila usa o índice parcial, não um scan de 316k linhas", () => {
    const db = fresh();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE transcript_status = 'pending' ORDER BY timestamp LIMIT 1",
      )
      .all() as any[];
    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_messages_transcript_pending");
  });
});
