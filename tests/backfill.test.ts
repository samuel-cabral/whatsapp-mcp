import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages } from "../src/daemon/ingest.js";
import { planBackfill, runBackfill } from "../src/daemon/backfill.js";
import {
  BACKFILL_BUDGET_MS,
  PAGE_PAUSE_MS,
  PAGE_SIZE,
  MAX_BACKFILL_PAGES,
} from "../src/shared/backfill-limits.js";

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
    expect(planBackfill(db, IGOR)).toEqual({ msgId: "OLD", ts: 1000, fromMe: false });
  });

  it("carrega o fromMe da mensagem mais antiga, porque ele faz parte da chave", () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "NEW" }, messageTimestamp: 5000, message: { conversation: "b" } },
      { key: { remoteJid: IGOR, fromMe: true, id: "MINE" }, messageTimestamp: 1000, message: { conversation: "a" } },
    ]);
    expect(planBackfill(db, IGOR)).toEqual({ msgId: "MINE", ts: 1000, fromMe: true });
  });

  it("devolve null quando o chat está marcado como completo", () => {
    ingestMessages(db, [
      { key: { remoteJid: IGOR, fromMe: false, id: "OLD" }, messageTimestamp: 1000, message: { conversation: "a" } },
    ]);
    db.prepare("UPDATE sync_state SET complete = 1 WHERE chat_jid = ?").run(IGOR);
    expect(planBackfill(db, IGOR)).toBeNull();
  });
});

/** A clock the test drives by hand, so proving a twenty-second budget costs no seconds. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    elapsed: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    },
  };
}

function seed(): void {
  ingestMessages(db, [
    { key: { remoteJid: IGOR, fromMe: false, id: "OLD" }, messageTimestamp: 1000, message: { conversation: "a" } },
  ]);
}

describe("runBackfill", () => {
  it("pede as páginas pedidas e não dorme depois da última", async () => {
    seed();
    const f = fakeClock();
    const out = await runBackfill(db, IGOR, 3, async () => {}, f.clock);

    expect(out).toEqual({ asked: 3 * PAGE_SIZE, stopped: "pages" });
    // Two pauses for three pages: the pause exists to space requests out, and there is
    // nothing left to space out after the last one.
    expect(f.slept).toEqual([PAGE_PAUSE_MS, PAGE_PAUSE_MS]);
  });

  it("para no orçamento em vez de estourar o timeout do cliente", async () => {
    seed();
    const f = fakeClock();
    // Twenty pages was the old declared ceiling. At PAGE_PAUSE_MS apiece it costs 30s
    // of sleep against a 30s client timeout, so it could only ever answer with the
    // daemon looking hung. It now answers, and says it stopped short.
    const out = await runBackfill(db, IGOR, 20, async () => {}, f.clock);

    expect(out.stopped).toBe("budget");
    expect(f.elapsed()).toBeLessThan(BACKFILL_BUDGET_MS);
    expect(out.asked).toBeGreaterThan(0);
  });

  it("conta o round trip no orçamento, não só o sono", async () => {
    seed();
    const f = fakeClock();
    // Three pages sleep for 3s total, nowhere near the budget. The fetches themselves
    // burn it — which is why the guard is a wall clock and not a page counter.
    const out = await runBackfill(db, IGOR, 3, async () => f.advance(9_000), f.clock);

    expect(out.stopped).toBe("budget");
    expect(out.asked).toBe(2 * PAGE_SIZE);
  });

  it("para quando a conversa chega ao começo", async () => {
    seed();
    const f = fakeClock();
    const out = await runBackfill(
      db,
      IGOR,
      5,
      async () => {
        db.prepare("UPDATE sync_state SET complete = 1 WHERE chat_jid = ?").run(IGOR);
      },
      f.clock,
    );

    expect(out).toEqual({ asked: PAGE_SIZE, stopped: "exhausted" });
  });

  it("não pede nada quando não há de onde paginar", async () => {
    const f = fakeClock();
    let calls = 0;
    const out = await runBackfill(db, IGOR, 5, async () => void calls++, f.clock);

    expect(out).toEqual({ asked: 0, stopped: "exhausted" });
    expect(calls).toBe(0);
  });

  it("o teto de páginas cabe dentro do orçamento", () => {
    // The regression this file exists for: a ceiling that costs more than the budget
    // allows is a maximum nobody can reach.
    expect(MAX_BACKFILL_PAGES * PAGE_PAUSE_MS).toBeLessThanOrEqual(BACKFILL_BUDGET_MS);
    expect(MAX_BACKFILL_PAGES).toBeGreaterThan(0);
  });
});
