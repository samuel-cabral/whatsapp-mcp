import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";

export type DB = BetterSqlite3.Database;

export const SCHEMA_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The schema is written entirely with IF NOT EXISTS, so applying it to an
 * existing database is a no-op. Version 2+ will append numbered steps here.
 */
export function migrate(db: DB): number {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
  return SCHEMA_VERSION;
}
