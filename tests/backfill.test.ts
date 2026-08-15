import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages } from "../src/daemon/ingest.js";
import { planBackfill } from "../src/daemon/backfill.js";

const IGOR = "5511999@s.whatsapp.net";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

describe("planBackfill", () => {
  it("devolve null quando não há nada de onde paginar", () => {
    expect(planBackfill(db, IGOR)).toBeNull();
  });

  it("aponta para a mensagem mais antiga conhecida", () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "NEW" }, messageTimestamp: 5000, message: { conversation: "b" } },
      { key: { remoteJid: IGOR, fromMe: false, id: "OLD" }, messageTimestamp: 1000, message: { conversation: "a" } },
    ]);
    expect(planBackfill(db, IGOR)).toEqual({ msgId: "OLD", ts: 1000 });
  });

  it("devolve null quando o chat está marcado como completo", () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "OLD" }, messageTimestamp: 1000, message: { conversation: "a" } },
    ]);
    db.prepare("UPDATE sync_state SET complete = 1 WHERE chat_jid = ?").run(IGOR);
    expect(planBackfill(db, IGOR)).toBeNull();
  });
});
