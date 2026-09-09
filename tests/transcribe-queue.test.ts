import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { createAudioQueue, recoverRunning, MAX_ATTEMPTS, type MediaFetcher } from "../src/daemon/audio-queue.js";
import type { TranscribeOutcome } from "../src/daemon/transcribe.js";
import type { AudioRef } from "../src/shared/types.js";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

const REF: AudioRef = { mediaKey: "AQID", directPath: "/v/t62/abc", mimetype: "audio/ogg", seconds: 5 };

function queueNote(msgId: string, ts = 1_800_000_000, ref: unknown = REF): number {
  const info = db
    .prepare(
      "INSERT INTO messages (chat_jid, msg_id, timestamp, type, transcript_status, transcript_attempts, media_ref) " +
        "VALUES (?,?,?,'audio','pending',0,?)",
    )
    .run("5511@s.whatsapp.net", msgId, ts, JSON.stringify(ref));
  return Number(info.lastInsertRowid);
}

const row = (msgId: string) =>
  db
    .prepare("SELECT transcript, transcript_status, transcript_attempts, transcript_error, media_ref FROM messages WHERE msg_id = ?")
    .get(msgId) as any;

const okFetcher: MediaFetcher = { fetchAudio: async () => Buffer.from("opus") };

/** A stand-in for whisper: the real one needs a 547 MB model the CI does not have. */
const fakeTranscribe = (outcome: TranscribeOutcome | ((n: number) => TranscribeOutcome)) => {
  let calls = 0;
  const fn = async (): Promise<TranscribeOutcome> => {
    calls++;
    return typeof outcome === "function" ? outcome(calls) : outcome;
  };
  // defineProperty, not Object.assign: assign copies the getter's current value and
  // would freeze the counter at zero.
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as typeof fn & { calls: number };
};

const build = (over: Partial<Parameters<typeof createAudioQueue>[0]> = {}) =>
  createAudioQueue({
    db,
    fetcher: okFetcher,
    cfg: { ffmpegBin: "f", whisperBin: "w", whisperModel: "m", whisperLanguage: "pt", tmpRoot: "/tmp" },
    transcribe: fakeTranscribe({ status: "ok", text: "abacaxi" }),
    log: () => {},
    pauseAfterFailureMs: 1,
    ...over,
  });

describe("fila de transcrição", () => {
  it("grava a transcrição e a torna buscável no FTS", async () => {
    queueNote("A1");
    const q = build();
    await q.pump();
    q.stop();

    expect(row("A1")).toMatchObject({ transcript: "abacaxi", transcript_status: "done" });
    const hit = db
      .prepare("SELECT m.msg_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?")
      .all("abacaxi") as any[];
    expect(hit.map((h) => h.msg_id)).toEqual(["A1"]);
  });

  it("processa em ordem cronológica e drena a fila inteira", async () => {
    const seen: string[] = [];
    queueNote("B2", 2000);
    queueNote("B1", 1000);
    const q = build({
      fetcher: { fetchAudio: async () => Buffer.from("x") },
      transcribe: (async (_b: Buffer) => {
        seen.push("call");
        return { status: "ok", text: `t${seen.length}` } as TranscribeOutcome;
      }) as any,
    });
    await q.pump();
    q.stop();
    expect(row("B1").transcript).toBe("t1");
    expect(row("B2").transcript).toBe("t2");
  });

  // MAX_CONCURRENCY is 1 because two whisper processes serialise on the GPU while
  // doubling an 800 MB peak. The re-entrancy guard is what enforces it when wake()
  // and the timer fire together.
  it("nunca roda dois de uma vez, mesmo com pump concorrente", async () => {
    queueNote("C1", 1000);
    queueNote("C2", 2000);
    let inFlight = 0;
    let maxInFlight = 0;
    const q = build({
      transcribe: (async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { status: "ok", text: "x" } as TranscribeOutcome;
      }) as any,
    });
    await Promise.all([q.pump(), q.pump(), q.pump()]);
    q.stop();
    expect(maxInFlight).toBe(1);
    expect(row("C1").transcript_status).toBe("done");
    expect(row("C2").transcript_status).toBe("done");
  });

  it("'empty' grava string vazia: separa 'ouvimos e não havia fala' de 'ninguém tentou'", async () => {
    queueNote("D1");
    const q = build({ transcribe: fakeTranscribe({ status: "empty", reason: "silêncio" }) });
    await q.pump();
    q.stop();
    expect(row("D1")).toMatchObject({ transcript: "", transcript_status: "done" });
  });

  it("mantém o media_ref depois de transcrever, senão force não teria o que reprocessar", async () => {
    queueNote("D2");
    const q = build();
    await q.pump();
    q.stop();
    expect(row("D2").media_ref).not.toBeNull();
  });

  it("falha comum volta para a fila e vira 'failed' na terceira", async () => {
    queueNote("E1");
    const q = build({ transcribe: fakeTranscribe({ status: "failed", reason: "deu ruim", permanent: false }) });
    await q.pump();
    q.stop();
    expect(row("E1")).toMatchObject({ transcript_status: "failed", transcript_attempts: MAX_ATTEMPTS });
  });

  // A job that already burned its whole time budget must not pin the single worker
  // for two more cycles to reach the same verdict.
  it("falha permanente não gasta as três tentativas", async () => {
    queueNote("E2");
    const q = build({ transcribe: fakeTranscribe({ status: "failed", reason: "tempo limite", permanent: true }) });
    await q.pump();
    q.stop();
    expect(row("E2")).toMatchObject({ transcript_status: "failed", transcript_attempts: 1 });
  });

  it("um job ruim não impede os seguintes", async () => {
    queueNote("F1", 1000);
    queueNote("F2", 2000);
    const q = build({
      transcribe: fakeTranscribe((n) =>
        n === 1 ? { status: "failed", reason: "x", permanent: true } : { status: "ok", text: "seguiu" },
      ),
    });
    await q.pump();
    q.stop();
    expect(row("F1").transcript_status).toBe("failed");
    expect(row("F2").transcript).toBe("seguiu");
  });

  it("mídia que o WhatsApp não serve mais é falha permanente, sem gastar tentativas", async () => {
    queueNote("G1");
    const q = build({
      fetcher: { fetchAudio: async () => { throw new Error("Request failed with status code 404"); } },
    });
    await q.pump();
    q.stop();
    expect(row("G1")).toMatchObject({ transcript_status: "failed", transcript_attempts: 1 });
    expect(row("G1").transcript_error).toContain("não serve mais");
  });

  it("descritor de mídia ilegível falha de vez, sem tentar baixar", async () => {
    queueNote("G2", 1000, "isso não é json" as any);
    db.prepare("UPDATE messages SET media_ref = ? WHERE msg_id = 'G2'").run("{quebrado");
    const q = build();
    await q.pump();
    q.stop();
    expect(row("G2").transcript_status).toBe("failed");
  });

  // Charging thousands of messages for a binary Homebrew moved would turn an install
  // problem into a wall of permanent failures.
  it("problema de ambiente não gasta tentativa e para o worker", async () => {
    queueNote("H1");
    const q = build({ transcribe: fakeTranscribe({ status: "environment", reason: "whisper sumiu" }) });
    await q.pump();
    q.stop();
    expect(row("H1")).toMatchObject({ transcript_status: "pending", transcript_attempts: 0 });

    const meta = db.prepare("SELECT value FROM meta WHERE key = 'transcription_engine_ok'").get() as any;
    expect(meta.value).toBe("0");
  });

  it("depois de parar, não processa mais nada", async () => {
    queueNote("I1");
    const q = build();
    q.stop();
    await q.pump();
    expect(row("I1").transcript_status).toBe("pending");
  });
});

describe("recuperação de boot", () => {
  // A single instance owns this database, so `running` at boot is an orphan by
  // definition — and SIGTERM mid-transcription is what every kickstart does, so
  // charging an attempt would burn a note's three retries over three deploys.
  it("devolve 'running' órfão para a fila sem cobrar tentativa", () => {
    queueNote("J1");
    db.prepare("UPDATE messages SET transcript_status = 'running' WHERE msg_id = 'J1'").run();
    expect(recoverRunning(db)).toBe(1);
    expect(row("J1")).toMatchObject({ transcript_status: "pending", transcript_attempts: 0 });
  });

  it("não mexe em quem já terminou", () => {
    queueNote("J2");
    db.prepare("UPDATE messages SET transcript_status = 'done', transcript = 'x' WHERE msg_id = 'J2'").run();
    recoverRunning(db);
    expect(row("J2").transcript_status).toBe("done");
  });
});

describe("request: a tool manual", () => {
  it("transcreve uma nota específica e devolve o texto", async () => {
    queueNote("K1");
    const q = build();
    const res = await q.request("5511@s.whatsapp.net", "K1", false);
    q.stop();
    expect(res).toEqual({ state: "done", text: "abacaxi" });
  });

  it("já transcrito devolve o texto guardado sem reprocessar", async () => {
    queueNote("K2");
    const t = fakeTranscribe({ status: "ok", text: "primeira" });
    const q = build({ transcribe: t });
    await q.pump();
    const res = await q.request("5511@s.whatsapp.net", "K2", false);
    q.stop();
    expect(res).toEqual({ state: "done", text: "primeira" });
    expect(t.calls).toBe(1);
  });

  it("force reprocessa e zera as tentativas", async () => {
    queueNote("K3");
    const t = fakeTranscribe((n) => ({ status: "ok", text: n === 1 ? "primeira" : "segunda" }));
    const q = build({ transcribe: t });
    await q.pump();
    const res = await q.request("5511@s.whatsapp.net", "K3", true);
    q.stop();
    expect(res).toEqual({ state: "done", text: "segunda" });
  });

  it("recusa áudio antigo, que não tem mídia guardada", async () => {
    db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type) VALUES (?,?,?,'audio')")
      .run("5511@s.whatsapp.net", "OLD", 1000);
    const q = build();
    const res = await q.request("5511@s.whatsapp.net", "OLD", false);
    q.stop();
    expect(res.state).toBe("rejected");
    expect((res as any).error).toContain("anterior à transcrição automática");
  });

  it("recusa mensagem que não é áudio e mensagem inexistente", async () => {
    db.prepare("INSERT INTO messages (chat_jid, msg_id, timestamp, type, text) VALUES (?,?,?,'text','oi')")
      .run("5511@s.whatsapp.net", "T1", 1000);
    const q = build();
    expect((await q.request("5511@s.whatsapp.net", "T1", false)).state).toBe("rejected");
    expect((await q.request("5511@s.whatsapp.net", "NAOEXISTE", false)).state).toBe("rejected");
    q.stop();
  });

  // The uniqueness constraint is (chat_jid, msg_id): without the jid this could
  // transcribe someone else's message and hand back their words.
  it("o mesmo msgId em outro chat não é encontrado", async () => {
    queueNote("SAME");
    const q = build();
    const res = await q.request("999@s.whatsapp.net", "SAME", false);
    q.stop();
    expect(res.state).toBe("rejected");
  });

  it("devolve 'running' quando a paciência acaba antes do veredito", async () => {
    queueNote("K4");
    const q = build({
      transcribe: (async () => {
        await new Promise((r) => setTimeout(r, 400));
        return { status: "ok", text: "demorou" } as TranscribeOutcome;
      }) as any,
    });
    const res = await q.request("5511@s.whatsapp.net", "K4", false, 50);
    q.stop();
    expect(res).toEqual({ state: "running" });
  });

  it("devolve o motivo quando a transcrição falhou de vez", async () => {
    queueNote("K5");
    const q = build({ transcribe: fakeTranscribe({ status: "failed", reason: "áudio ilegível", permanent: true }) });
    const res = await q.request("5511@s.whatsapp.net", "K5", false);
    q.stop();
    expect(res).toMatchObject({ state: "failed", error: "áudio ilegível" });
  });
});
