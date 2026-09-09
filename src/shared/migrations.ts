import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";

export type DB = BetterSqlite3.Database;

export const SCHEMA_VERSION = 2;

const here = dirname(fileURLToPath(import.meta.url));

interface Step {
  version: number;
  up(db: DB): void;
}

function readVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : 0;
}

function writeVersion(db: DB, version: number): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

function tableExists(db: DB, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !==
    undefined
  );
}

/** pragma_table_info takes a bind parameter; `PRAGMA table_info(x)` does not. */
function columnsOf(db: DB, table: string): Set<string> {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * v1 → v2: the six transcription columns, and an FTS index that covers the new
 * `transcript` alongside `text`.
 *
 * The FTS table is dropped and rebuilt rather than altered, because there is no way
 * to widen an fts5 table from one column to two: leaving the old one-column index in
 * place under the new two-column triggers makes `integrity-check` report
 * `database disk image is malformed`. The rebuild costs ~0,3-0,5 s for 316k rows and
 * pushes ~11 MB into the WAL, once, on the boot that migrates.
 */
const STEP_002: Step = {
  version: 2,
  up(db: DB): void {
    // A brand new file: schema.sql, which runs right after the steps, already
    // declares the v2 shape, so there is nothing to alter.
    if (!tableExists(db, "messages")) return;

    const cols = columnsOf(db, "messages");
    const ftsCols = tableExists(db, "messages_fts") ? columnsOf(db, "messages_fts") : new Set<string>();
    if (cols.has("transcript") && ftsCols.has("transcript")) return; // already v2 shaped

    db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
    `);

    // No DEFAULT on any of these: SQLite hands a synthesised default to every
    // pre-existing row, so `DEFAULT 'pending'` would enqueue the entire store.
    const added: Array<[string, string]> = [
      ["transcript", "TEXT"],
      ["transcript_status", "TEXT"],
      ["transcript_at", "INTEGER"],
      ["transcript_attempts", "INTEGER"],
      ["transcript_error", "TEXT"],
      ["media_ref", "TEXT"],
    ];
    for (const [name, type] of added) {
      if (!cols.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }

    db.exec(`
      DROP TABLE IF EXISTS messages_fts;
      CREATE VIRTUAL TABLE messages_fts USING fts5 (
        text, transcript, content='messages', content_rowid='id',
        tokenize="unicode61 remove_diacritics 2"
      );
      INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');
      CREATE INDEX IF NOT EXISTS idx_messages_transcript_pending
        ON messages (timestamp) WHERE transcript_status = 'pending';
    `);
  },
};

/** Kept in ascending order; the loop in migrate relies on it. */
const STEPS: Step[] = [STEP_002];

/**
 * Order matters and is not obvious: `meta` first, then the numbered steps, then
 * schema.sql. schema.sql is written entirely with IF NOT EXISTS, so it only ever
 * creates what is missing — but its partial index names `transcript_status`, which
 * would fail with `no such column` against a v1 store if it ran before the ALTERs.
 */
export function migrate(db: DB): number {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Before anything else: the steps read and write the version row, and on a brand
  // new file schema.sql — which is what creates `meta` — has not run yet.
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");

  let version = readVersion(db);
  for (const step of STEPS) {
    if (step.version <= version) continue;
    // The DDL and the version bump commit together. A crash between them would leave
    // a database reporting the old version while already half-migrated, and the retry
    // would then die on ALTER TABLE. A step that throws is fatal by design: migrate
    // runs from openWritableDb, so a failed migration is a daemon that does not
    // start, which is strictly better than a half-migrated store nobody knows about.
    db.transaction(() => {
      step.up(db);
      writeVersion(db, step.version);
    })();
    version = step.version;
  }

  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  writeVersion(db, SCHEMA_VERSION);

  // The moment "from here on" starts, written once and never again. The 24h of slack
  // is not cosmetic: migrate() runs before createConnection, and the offline backlog
  // WhatsApp dumps right after login carries older timestamps — without the slack,
  // every voice note received during a deploy window would be dropped silently.
  db.exec(
    "INSERT INTO meta (key, value) VALUES ('transcription_since', " +
      "CAST(strftime('%s','now') - 86400 AS TEXT)) ON CONFLICT(key) DO NOTHING",
  );

  return SCHEMA_VERSION;
}
