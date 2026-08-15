import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { migrate, type DB } from "./migrations.js";

/** Only the daemon may call this. It migrates on open. */
export function openWritableDb(file: string): DB {
  const db = new Database(file);
  migrate(db);
  chmodSync(file, 0o600);
  return db;
}

/**
 * The MCP side opens read-only: a bug there cannot corrupt the store, and WAL
 * lets it read while the daemon writes.
 */
export function openReadonlyDb(file: string): DB {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

export type { DB };
