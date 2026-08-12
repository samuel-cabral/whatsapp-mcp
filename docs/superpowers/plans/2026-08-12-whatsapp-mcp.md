# whatsapp-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um servidor MCP que dá ao Claude leitura do WhatsApp pessoal (resumo, busca, triagem) e envio em dois passos, apoiado num daemon persistente que acumula o histórico.

**Architecture:** Dois processos separados por quem escreve. O daemon mantém a conexão Baileys, grava tudo num SQLite em WAL e é o único que envia mensagem; guarda também os rascunhos. O servidor MCP abre o mesmo banco em somente-leitura e fala com o daemon por um unix socket apenas para escrever. Spec: `docs/superpowers/specs/2026-08-12-whatsapp-mcp-design.md`.

**Tech Stack:** TypeScript ESM, Node 22, `@whiskeysockets/baileys`, `better-sqlite3` (FTS5), `@modelcontextprotocol/sdk`, `zod`, `vitest`.

## Global Constraints

- Node `>=22`. `"type": "module"` em todo o projeto; imports relativos sempre com extensão `.js`.
- **stdout do processo MCP é o canal JSON-RPC.** Nunca `console.log` em `src/mcp/**` nem em nada que ele importe. Diagnóstico vai para `stderr` via `console.error`.
- Só o daemon abre o banco para escrita. Todo código em `src/mcp/**` abre com `readonly: true`.
- `confirm_send` e o comando `confirm` do socket **nunca** aceitam texto de mensagem. Só `draftId`.
- Diretório `~/.whatsapp-mcp` criado com modo `0o700`; `store.db`, `config.json` e `control.sock` com `0o600`.
- Baileys fixado em `6.7.24` (tag `legacy`, estável). A tag `latest` é `7.0.0-rc14`, um release candidate. A Task 7 tem um ponto de decisão explícito caso a 6.7.24 não conecte.
- Todo teste roda contra SQLite em memória ou arquivo temporário. Nenhum teste toca o WhatsApp real.
- Mensagens de erro voltadas ao usuário em português; identificadores e comentários de código em inglês.

---

## File Structure

| arquivo | responsabilidade |
|---|---|
| `src/shared/paths.ts` | resolve `~/.whatsapp-mcp` e os caminhos derivados; cria dirs com a permissão certa |
| `src/shared/schema.sql` | DDL completo, incluindo FTS5 e triggers |
| `src/shared/migrations.ts` | aplica o schema, versiona, é idempotente |
| `src/shared/db.ts` | abre conexão de escrita (daemon) e de leitura (MCP) |
| `src/shared/jid.ts` | normaliza jid, detecta grupo |
| `src/shared/types.ts` | tipos compartilhados: linhas, comandos do socket, respostas |
| `src/shared/normalize.ts` | `WAMessage` do Baileys → linha do banco. Funções puras |
| `src/daemon/ingest.ts` | grava mensagens, chats e contatos. Idempotente |
| `src/daemon/drafts.ts` | cria, guarda, expira e consome rascunhos |
| `src/daemon/control.ts` | interpreta comandos do socket; handler puro + servidor |
| `src/daemon/socket.ts` | conexão Baileys atrás de uma interface estreita |
| `src/daemon/backfill.ts` | paginação de histórico antigo |
| `src/daemon/index.ts` | monta o daemon, sinais, launchd |
| `src/mcp/queries.ts` | todas as leituras do banco |
| `src/mcp/client.ts` | cliente do unix socket |
| `src/mcp/tools/*.ts` | uma tool por arquivo |
| `src/mcp/index.ts` | servidor MCP stdio, `createServer()` |

---

### Task 1: Scaffold e caminhos

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `resolvePaths(home?: string): Paths` onde
  `Paths = { root: string; authDir: string; dbFile: string; socketFile: string; configFile: string }`;
  `ensureDirs(paths: Paths): void`

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "@samuel-cabral/whatsapp-mcp",
  "version": "0.1.0",
  "description": "MCP server for personal WhatsApp: read history, search, and send with an explicit two-step confirmation.",
  "type": "module",
  "bin": {
    "whatsapp-mcp": "./build/mcp/index.js",
    "whatsapp-daemon": "./build/daemon/index.js"
  },
  "files": ["build", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "rm -rf build && tsc && chmod +x build/mcp/index.js build/daemon/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "daemon": "node build/daemon/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@whiskeysockets/baileys": "6.7.24",
    "better-sqlite3": "^13.0.3",
    "qrcode-terminal": "^0.12.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.10.0",
    "@types/qrcode-terminal": "^0.12.2",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "build",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Criar `vitest.config.ts` e `.gitignore`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

`.gitignore`:

```
node_modules/
build/
*.log
.DS_Store
```

- [ ] **Step 4: Instalar dependências**

Run: `npm install`
Expected: instala sem erro. `better-sqlite3` compila binário nativo — em macOS com Xcode CLT já instalado isso leva menos de um minuto.

- [ ] **Step 5: Escrever o teste que falha**

`tests/paths.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureDirs } from "../src/shared/paths.js";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "wamcp-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("deriva todos os caminhos de ~/.whatsapp-mcp", () => {
    const home = tempHome();
    const p = resolvePaths(home);
    expect(p.root).toBe(join(home, ".whatsapp-mcp"));
    expect(p.authDir).toBe(join(p.root, "auth"));
    expect(p.dbFile).toBe(join(p.root, "store.db"));
    expect(p.socketFile).toBe(join(p.root, "control.sock"));
    expect(p.configFile).toBe(join(p.root, "config.json"));
  });
});

describe("ensureDirs", () => {
  it("cria root e auth com modo 0700", () => {
    const p = resolvePaths(tempHome());
    ensureDirs(p);
    expect(statSync(p.root).mode & 0o777).toBe(0o700);
    expect(statSync(p.authDir).mode & 0o777).toBe(0o700);
  });

  it("é idempotente", () => {
    const p = resolvePaths(tempHome());
    ensureDirs(p);
    expect(() => ensureDirs(p)).not.toThrow();
  });
});
```

- [ ] **Step 6: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/paths.js'`

- [ ] **Step 7: Implementar `src/shared/paths.ts`**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";

export interface Paths {
  root: string;
  authDir: string;
  dbFile: string;
  socketFile: string;
  configFile: string;
}

/** All state lives under a single directory so it can be inspected or wiped as one unit. */
export function resolvePaths(home: string = homedir()): Paths {
  const root = join(home, ".whatsapp-mcp");
  return {
    root,
    authDir: join(root, "auth"),
    dbFile: join(root, "store.db"),
    socketFile: join(root, "control.sock"),
    configFile: join(root, "config.json"),
  };
}

/**
 * The database holds the user's entire WhatsApp in the clear, so the directory
 * is owner-only. chmod runs unconditionally: mkdir's mode is masked by umask.
 */
export function ensureDirs(paths: Paths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.root, 0o700);
  chmodSync(paths.authDir, 0o700);
}
```

- [ ] **Step 8: Rodar o teste e confirmar que passa**

Run: `npx vitest run tests/paths.test.ts` — Expected: PASS (3 testes)
Run: `npm run typecheck` — Expected: sem erro

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/shared/paths.ts tests/paths.test.ts
git commit -m "feat: scaffold do projeto e resolução de caminhos com permissão 700"
```

---

### Task 2: Schema e migrations

**Files:**
- Create: `src/shared/schema.sql`, `src/shared/migrations.ts`, `src/shared/db.ts`
- Test: `tests/migrations.test.ts`

**Interfaces:**
- Consumes: `Paths` da Task 1
- Produces: `SCHEMA_VERSION: number`; `migrate(db: DB): number`;
  `openWritableDb(file: string): DB`; `openReadonlyDb(file: string): DB`;
  `DB` é o tipo `Database` de `better-sqlite3`, reexportado como `export type DB = BetterSqlite3.Database`

- [ ] **Step 1: Escrever `src/shared/schema.sql`**

Repare no `tokenize`: sem `remove_diacritics 2`, buscar "reuniao" não encontra "Reunião", que é o caso comum e não a exceção.

```sql
CREATE TABLE IF NOT EXISTS chats (
  jid             TEXT PRIMARY KEY,
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  jid       TEXT PRIMARY KEY,
  name      TEXT,
  push_name TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  chat_jid   TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  sender_jid TEXT,
  from_me    INTEGER NOT NULL DEFAULT 0,
  timestamp  INTEGER NOT NULL,
  type       TEXT NOT NULL,
  text       TEXT,
  quoted_id  TEXT,
  UNIQUE (chat_jid, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages (timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  text,
  content='messages',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS sync_state (
  chat_jid      TEXT PRIMARY KEY,
  oldest_msg_id TEXT,
  oldest_ts     INTEGER,
  complete      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

- [ ] **Step 2: Escrever o teste que falha**

`tests/migrations.test.ts`:

```typescript
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
```

- [ ] **Step 3: Rodar e confirmar falha**

Run: `npx vitest run tests/migrations.test.ts`
Expected: FAIL — módulo `migrations.js` não existe

- [ ] **Step 4: Implementar `src/shared/migrations.ts`**

```typescript
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
```

`schema.sql` não é compilado pelo `tsc`, então precisa ser copiado para `build/`. Ajustar o script de build no `package.json`:

```json
"build": "rm -rf build && tsc && cp src/shared/schema.sql build/shared/schema.sql && chmod +x build/mcp/index.js build/daemon/index.js"
```

- [ ] **Step 5: Implementar `src/shared/db.ts`**

```typescript
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
```

- [ ] **Step 6: Rodar os testes**

Run: `npx vitest run tests/migrations.test.ts` — Expected: PASS (4 testes)
Run: `npm run typecheck` — Expected: sem erro

- [ ] **Step 7: Commit**

```bash
git add src/shared/schema.sql src/shared/migrations.ts src/shared/db.ts tests/migrations.test.ts package.json
git commit -m "feat: schema SQLite com FTS5 sem acento, migrations e abertura read-only"
```

---

### Task 3: Jid e normalização de mensagem

**Files:**
- Create: `src/shared/jid.ts`, `src/shared/types.ts`, `src/shared/normalize.ts`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  `normalizeJid(jid: string): string`; `isGroupJid(jid: string): boolean`;
  `MessageRow = { chat_jid: string; msg_id: string; sender_jid: string | null; from_me: 0 | 1; timestamp: number; type: MessageType; text: string | null; quoted_id: string | null }`;
  `MessageType = "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact" | "other"`;
  `toMessageRow(msg: unknown): MessageRow | null`

- [ ] **Step 1: Escrever `src/shared/jid.ts`**

```typescript
/**
 * Baileys hands out jids in several shapes: with a device suffix (":12@"),
 * as "@lid", or already bare. Everything downstream keys on the bare form,
 * so normalization has to happen at the boundary — not at each call site.
 */
export function normalizeJid(jid: string): string {
  const [user, server] = jid.split("@");
  if (!server) return jid;
  const bare = user.split(":")[0];
  return `${bare}@${server}`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}
```

- [ ] **Step 2: Escrever `src/shared/types.ts`**

```typescript
export type MessageType =
  | "text" | "image" | "video" | "audio"
  | "document" | "sticker" | "location" | "contact" | "other";

export interface MessageRow {
  chat_jid: string;
  msg_id: string;
  sender_jid: string | null;
  from_me: 0 | 1;
  timestamp: number;
  type: MessageType;
  text: string | null;
  quoted_id: string | null;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: 0 | 1;
  last_message_at: number | null;
  unread_count: number;
  archived: 0 | 1;
}

export interface ContactRow {
  jid: string;
  name: string | null;
  push_name: string | null;
}

export interface SyncStatus {
  connected: boolean;
  initialSyncDone: boolean;
  messageCount: number;
  chatCount: number;
  lastConnectedAt: number | null;
}

/** Commands accepted by the daemon's control socket. */
export type ControlCommand =
  | { cmd: "draft"; jid: string; text: string }
  | { cmd: "confirm"; draftId: string }
  | { cmd: "backfill"; jid: string; pages: number }
  | { cmd: "status" };

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };
```

- [ ] **Step 3: Escrever o teste que falha**

`tests/normalize.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeJid, isGroupJid } from "../src/shared/jid.js";
import { toMessageRow } from "../src/shared/normalize.js";

describe("normalizeJid", () => {
  it("remove o sufixo de device", () => {
    expect(normalizeJid("5511999999999:12@s.whatsapp.net")).toBe("5511999999999@s.whatsapp.net");
  });
  it("deixa jid já normalizado intacto", () => {
    expect(normalizeJid("5511999999999@s.whatsapp.net")).toBe("5511999999999@s.whatsapp.net");
  });
  it("reconhece grupo", () => {
    expect(isGroupJid("12345-67890@g.us")).toBe(true);
    expect(isGroupJid("5511999999999@s.whatsapp.net")).toBe(false);
  });
});

const base = {
  key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "ABC123" },
  messageTimestamp: 1754000000,
};

describe("toMessageRow", () => {
  it("extrai texto de conversation", () => {
    const row = toMessageRow({ ...base, message: { conversation: "oi" } })!;
    expect(row.type).toBe("text");
    expect(row.text).toBe("oi");
    expect(row.msg_id).toBe("ABC123");
    expect(row.chat_jid).toBe("5511999999999@s.whatsapp.net");
    expect(row.from_me).toBe(0);
  });

  it("extrai texto de extendedTextMessage e o id citado", () => {
    const row = toMessageRow({
      ...base,
      message: {
        extendedTextMessage: {
          text: "respondendo",
          contextInfo: { stanzaId: "QUOTED1" },
        },
      },
    })!;
    expect(row.text).toBe("respondendo");
    expect(row.quoted_id).toBe("QUOTED1");
  });

  it("guarda imagem como tipo + legenda, sem baixar binário", () => {
    const row = toMessageRow({ ...base, message: { imageMessage: { caption: "a foto" } } })!;
    expect(row.type).toBe("image");
    expect(row.text).toBe("a foto");
  });

  it("em grupo, usa participant como remetente", () => {
    const row = toMessageRow({
      key: { remoteJid: "12345-67890@g.us", fromMe: false, id: "G1", participant: "5511999@s.whatsapp.net" },
      messageTimestamp: 1754000000,
      message: { conversation: "oi grupo" },
    })!;
    expect(row.chat_jid).toBe("12345-67890@g.us");
    expect(row.sender_jid).toBe("5511999@s.whatsapp.net");
  });

  it("aceita messageTimestamp em Long ({low, high})", () => {
    const row = toMessageRow({ ...base, messageTimestamp: { low: 1754000000, high: 0 }, message: { conversation: "x" } })!;
    expect(row.timestamp).toBe(1754000000);
  });

  it("devolve null quando não há id, chat ou message", () => {
    expect(toMessageRow({ key: { remoteJid: null, id: "X" }, message: { conversation: "a" } })).toBeNull();
    expect(toMessageRow({ ...base, message: null })).toBeNull();
  });

  it("classifica protocolo/desconhecido como other, sem texto", () => {
    const row = toMessageRow({ ...base, message: { protocolMessage: { type: 0 } } })!;
    expect(row.type).toBe("other");
    expect(row.text).toBeNull();
  });
});
```

- [ ] **Step 4: Rodar e confirmar falha**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL — `normalize.js` não existe

- [ ] **Step 5: Implementar `src/shared/normalize.ts`**

```typescript
import { normalizeJid, isGroupJid } from "./jid.js";
import type { MessageRow, MessageType } from "./types.js";

/** Baileys returns timestamps as number, Long, or numeric string depending on the path. */
function toEpochSeconds(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  if (value && typeof value === "object" && "low" in (value as any)) {
    return Number((value as any).low);
  }
  return null;
}

const MEDIA: Array<[string, MessageType]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "location"],
  ["contactMessage", "contact"],
];

/**
 * Media binaries are deliberately not downloaded: type + caption is enough for
 * summarizing, searching and triage, and it keeps the store small.
 */
function classify(message: Record<string, any>): { type: MessageType; text: string | null; quotedId: string | null } {
  if (typeof message.conversation === "string") {
    return { type: "text", text: message.conversation, quotedId: null };
  }
  const ext = message.extendedTextMessage;
  if (ext) {
    return { type: "text", text: ext.text ?? null, quotedId: ext.contextInfo?.stanzaId ?? null };
  }
  for (const [key, type] of MEDIA) {
    const node = message[key];
    if (node) {
      return { type, text: node.caption ?? node.fileName ?? null, quotedId: node.contextInfo?.stanzaId ?? null };
    }
  }
  return { type: "other", text: null, quotedId: null };
}

export function toMessageRow(msg: unknown): MessageRow | null {
  const m = msg as any;
  const remoteJid = m?.key?.remoteJid;
  const msgId = m?.key?.id;
  if (!remoteJid || !msgId || !m?.message) return null;

  const timestamp = toEpochSeconds(m.messageTimestamp);
  if (timestamp === null) return null;

  const chatJid = normalizeJid(remoteJid);
  const fromMe = m.key.fromMe === true;
  const sender = isGroupJid(chatJid)
    ? (m.key.participant ? normalizeJid(m.key.participant) : null)
    : (fromMe ? null : chatJid);

  const { type, text, quotedId } = classify(m.message);

  return {
    chat_jid: chatJid,
    msg_id: String(msgId),
    sender_jid: sender,
    from_me: fromMe ? 1 : 0,
    timestamp,
    type,
    text,
    quoted_id: quotedId,
  };
}
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `npx vitest run tests/normalize.test.ts` — Expected: PASS (10 testes)
Run: `npm run typecheck` — Expected: sem erro

- [ ] **Step 7: Commit**

```bash
git add src/shared/jid.ts src/shared/types.ts src/shared/normalize.ts tests/normalize.test.ts
git commit -m "feat: normalização de jid e de mensagem do Baileys para linha do banco"
```

---

### Task 4: Ingest idempotente

**Files:**
- Create: `src/daemon/ingest.ts`
- Test: `tests/ingest.test.ts`

**Interfaces:**
- Consumes: `DB`, `migrate`, `toMessageRow`, `normalizeJid`, `isGroupJid`
- Produces:
  `ingestMessages(db: DB, messages: unknown[]): number` (retorna quantas linhas foram gravadas);
  `ingestChats(db: DB, chats: unknown[]): number`;
  `ingestContacts(db: DB, contacts: unknown[]): number`;
  `setMeta(db: DB, key: string, value: string): void`;
  `getMeta(db: DB, key: string): string | null`

- [ ] **Step 1: Escrever o teste que falha**

`tests/ingest.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, setMeta, getMeta } from "../src/daemon/ingest.js";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

const msg = (id: string, text: string, ts = 1754000000) => ({
  key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id },
  messageTimestamp: ts,
  message: { conversation: text },
});

describe("ingestMessages", () => {
  it("grava mensagens novas", () => {
    expect(ingestMessages(db, [msg("A", "um"), msg("B", "dois")])).toBe(2);
    const n = db.prepare("SELECT count(*) AS n FROM messages").get() as any;
    expect(n.n).toBe(2);
  });

  it("é idempotente: o mesmo lote duas vezes não duplica", () => {
    const batch = [msg("A", "um"), msg("B", "dois")];
    ingestMessages(db, batch);
    ingestMessages(db, batch);
    const n = db.prepare("SELECT count(*) AS n FROM messages").get() as any;
    expect(n.n).toBe(2);
    const f = db.prepare("SELECT count(*) AS n FROM messages_fts").get() as any;
    expect(f.n).toBe(2);
  });

  it("ignora entradas que não normalizam, sem abortar o lote", () => {
    expect(ingestMessages(db, [msg("A", "um"), { key: {}, message: null }])).toBe(1);
  });

  it("cria o chat implicitamente e atualiza last_message_at", () => {
    ingestMessages(db, [msg("A", "um", 1000), msg("B", "dois", 2000)]);
    const chat = db.prepare("SELECT * FROM chats WHERE jid = ?").get("5511999999999@s.whatsapp.net") as any;
    expect(chat).toBeTruthy();
    expect(chat.last_message_at).toBe(2000);
  });

  it("mantém sync_state apontando para a mensagem mais antiga do chat", () => {
    ingestMessages(db, [msg("B", "dois", 2000), msg("A", "um", 1000)]);
    const s = db.prepare("SELECT * FROM sync_state WHERE chat_jid = ?").get("5511999999999@s.whatsapp.net") as any;
    expect(s.oldest_msg_id).toBe("A");
    expect(s.oldest_ts).toBe(1000);
  });
});

describe("ingestChats e ingestContacts", () => {
  it("grava chat com nome e marca grupo", () => {
    ingestChats(db, [{ id: "12345-67890@g.us", name: "Grupo da Igreja", unreadCount: 3 }]);
    const c = db.prepare("SELECT * FROM chats WHERE jid = ?").get("12345-67890@g.us") as any;
    expect(c.name).toBe("Grupo da Igreja");
    expect(c.is_group).toBe(1);
    expect(c.unread_count).toBe(3);
  });

  it("não apaga o nome já conhecido quando o novo vem vazio", () => {
    ingestChats(db, [{ id: "5511@s.whatsapp.net", name: "Igor" }]);
    ingestChats(db, [{ id: "5511@s.whatsapp.net" }]);
    const c = db.prepare("SELECT name FROM chats WHERE jid = ?").get("5511@s.whatsapp.net") as any;
    expect(c.name).toBe("Igor");
  });

  it("grava contato com push_name", () => {
    ingestContacts(db, [{ id: "5511@s.whatsapp.net", name: "Igor", notify: "Igor S." }]);
    const c = db.prepare("SELECT * FROM contacts WHERE jid = ?").get("5511@s.whatsapp.net") as any;
    expect(c.name).toBe("Igor");
    expect(c.push_name).toBe("Igor S.");
  });
});

describe("meta", () => {
  it("grava e lê, com null para chave ausente", () => {
    expect(getMeta(db, "initial_sync_done")).toBeNull();
    setMeta(db, "initial_sync_done", "1");
    expect(getMeta(db, "initial_sync_done")).toBe("1");
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/ingest.test.ts`
Expected: FAIL — `ingest.js` não existe

- [ ] **Step 3: Implementar `src/daemon/ingest.ts`**

```typescript
import type { DB } from "../shared/migrations.js";
import { toMessageRow } from "../shared/normalize.js";
import { normalizeJid, isGroupJid } from "../shared/jid.js";

/**
 * Every write goes through ON CONFLICT so that replaying a history batch — which
 * WhatsApp does on every reconnect — converges instead of duplicating.
 */
export function ingestMessages(db: DB, messages: unknown[]): number {
  const insertMsg = db.prepare(`
    INSERT INTO messages (chat_jid, msg_id, sender_jid, from_me, timestamp, type, text, quoted_id)
    VALUES (@chat_jid, @msg_id, @sender_jid, @from_me, @timestamp, @type, @text, @quoted_id)
    ON CONFLICT (chat_jid, msg_id) DO UPDATE SET
      text = excluded.text,
      type = excluded.type,
      quoted_id = excluded.quoted_id
  `);

  const touchChat = db.prepare(`
    INSERT INTO chats (jid, is_group, last_message_at)
    VALUES (@jid, @is_group, @ts)
    ON CONFLICT (jid) DO UPDATE SET
      last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at)
  `);

  const touchSync = db.prepare(`
    INSERT INTO sync_state (chat_jid, oldest_msg_id, oldest_ts, complete)
    VALUES (@jid, @msg_id, @ts, 0)
    ON CONFLICT (chat_jid) DO UPDATE SET
      oldest_msg_id = CASE WHEN excluded.oldest_ts < sync_state.oldest_ts THEN excluded.oldest_msg_id ELSE sync_state.oldest_msg_id END,
      oldest_ts     = MIN(sync_state.oldest_ts, excluded.oldest_ts)
  `);

  const run = db.transaction((batch: unknown[]) => {
    let written = 0;
    for (const raw of batch) {
      const row = toMessageRow(raw);
      if (!row) continue;
      insertMsg.run(row);
      touchChat.run({ jid: row.chat_jid, is_group: isGroupJid(row.chat_jid) ? 1 : 0, ts: row.timestamp });
      touchSync.run({ jid: row.chat_jid, msg_id: row.msg_id, ts: row.timestamp });
      written++;
    }
    return written;
  });

  return run(messages);
}

export function ingestChats(db: DB, chats: unknown[]): number {
  // COALESCE keeps a name we already know when a later sync omits it.
  const stmt = db.prepare(`
    INSERT INTO chats (jid, name, is_group, unread_count, archived)
    VALUES (@jid, @name, @is_group, @unread_count, @archived)
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      unread_count = excluded.unread_count,
      archived = excluded.archived
  `);

  const run = db.transaction((batch: unknown[]) => {
    let n = 0;
    for (const raw of batch) {
      const c = raw as any;
      if (!c?.id) continue;
      const jid = normalizeJid(c.id);
      stmt.run({
        jid,
        name: c.name ?? c.subject ?? null,
        is_group: isGroupJid(jid) ? 1 : 0,
        unread_count: Number(c.unreadCount ?? 0),
        archived: c.archived ? 1 : 0,
      });
      n++;
    }
    return n;
  });

  return run(chats);
}

export function ingestContacts(db: DB, contacts: unknown[]): number {
  const stmt = db.prepare(`
    INSERT INTO contacts (jid, name, push_name)
    VALUES (@jid, @name, @push_name)
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      push_name = COALESCE(excluded.push_name, contacts.push_name)
  `);

  const run = db.transaction((batch: unknown[]) => {
    let n = 0;
    for (const raw of batch) {
      const c = raw as any;
      if (!c?.id) continue;
      stmt.run({
        jid: normalizeJid(c.id),
        name: c.name ?? null,
        push_name: c.notify ?? null,
      });
      n++;
    }
    return n;
  });

  return run(contacts);
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/ingest.test.ts` — Expected: PASS (9 testes)
Run: `npm run typecheck` — Expected: sem erro

- [ ] **Step 5: Commit**

```bash
git add src/daemon/ingest.ts tests/ingest.test.ts
git commit -m "feat: ingest idempotente de mensagens, chats e contatos"
```

---

### Task 5: Camada de leitura

**Files:**
- Create: `src/mcp/queries.ts`
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `DB`, tipos da Task 3
- Produces:
  `listChats(db, opts: { limit?: number; onlyUnread?: boolean }): ChatSummary[]` onde
  `ChatSummary = { jid: string; name: string | null; isGroup: boolean; unread: number; lastMessageAt: number | null; lastText: string | null }`;
  `readMessages(db, opts: { jid: string; since?: number; until?: number; limit?: number }): MessageView[]` onde
  `MessageView = { id: string; at: number; fromMe: boolean; sender: string | null; type: string; text: string | null }`;
  `searchMessages(db, opts: { query: string; jid?: string; since?: number; limit?: number }): SearchHit[]` onde
  `SearchHit = MessageView & { chatJid: string; chatName: string | null }`;
  `getContact(db, query: string): ContactRow[]`;
  `getSyncStatus(db, connected: boolean): SyncStatus`

- [ ] **Step 1: Escrever o teste que falha**

`tests/queries.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, setMeta } from "../src/daemon/ingest.js";
import { listChats, readMessages, searchMessages, getContact, getSyncStatus } from "../src/mcp/queries.js";

const IGOR = "5511999@s.whatsapp.net";
const GRUPO = "12345-67890@g.us";

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ingestContacts(db, [{ id: IGOR, name: "Igor", notify: "Igor S." }]);
  ingestChats(db, [
    { id: IGOR, name: "Igor", unreadCount: 2 },
    { id: GRUPO, name: "Grupo da Igreja", unreadCount: 0 },
  ]);
  ingestMessages(db, [
    { key: { remoteJid: IGOR, fromMe: false, id: "M1" }, messageTimestamp: 1000, message: { conversation: "bora marcar a reunião" } },
    { key: { remoteJid: IGOR, fromMe: true, id: "M2" }, messageTimestamp: 2000, message: { conversation: "fechado" } },
    { key: { remoteJid: GRUPO, fromMe: false, id: "G1", participant: IGOR }, messageTimestamp: 3000, message: { conversation: "ensaio às 19h" } },
  ]);
});

describe("listChats", () => {
  it("ordena por atividade mais recente e traz a última mensagem", () => {
    const chats = listChats(db, {});
    expect(chats[0].jid).toBe(GRUPO);
    expect(chats[0].lastText).toBe("ensaio às 19h");
    expect(chats[0].isGroup).toBe(true);
  });

  it("filtra só não-lidas", () => {
    const chats = listChats(db, { onlyUnread: true });
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe(IGOR);
    expect(chats[0].unread).toBe(2);
  });

  it("respeita o limite", () => {
    expect(listChats(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("readMessages", () => {
  it("devolve em ordem cronológica", () => {
    const msgs = readMessages(db, { jid: IGOR });
    expect(msgs.map((m) => m.id)).toEqual(["M1", "M2"]);
    expect(msgs[1].fromMe).toBe(true);
  });

  it("filtra por janela de tempo", () => {
    expect(readMessages(db, { jid: IGOR, since: 1500 }).map((m) => m.id)).toEqual(["M2"]);
    expect(readMessages(db, { jid: IGOR, until: 1500 }).map((m) => m.id)).toEqual(["M1"]);
  });

  it("com limite, devolve as mais recentes ainda em ordem cronológica", () => {
    const msgs = readMessages(db, { jid: IGOR, limit: 1 });
    expect(msgs.map((m) => m.id)).toEqual(["M2"]);
  });
});

describe("searchMessages", () => {
  it("encontra ignorando acento e caixa", () => {
    const hits = searchMessages(db, { query: "REUNIAO" });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("M1");
    expect(hits[0].chatName).toBe("Igor");
  });

  it("filtra por chat", () => {
    expect(searchMessages(db, { query: "ensaio", jid: IGOR })).toHaveLength(0);
    expect(searchMessages(db, { query: "ensaio", jid: GRUPO })).toHaveLength(1);
  });

  it("aceita várias palavras sem quebrar na sintaxe do FTS", () => {
    expect(searchMessages(db, { query: "ensaio 19h" })).toHaveLength(1);
  });

  it("não explode com aspas ou operadores soltos vindos do modelo", () => {
    expect(() => searchMessages(db, { query: 'reunião" OR' })).not.toThrow();
  });
});

describe("getContact", () => {
  it("acha por parte do nome, sem acento", () => {
    expect(getContact(db, "igor")).toHaveLength(1);
  });
  it("acha por número", () => {
    expect(getContact(db, "5511999")).toHaveLength(1);
  });
});

describe("getSyncStatus", () => {
  it("reporta sync incompleto enquanto meta não estiver marcada", () => {
    const s = getSyncStatus(db, true);
    expect(s.connected).toBe(true);
    expect(s.initialSyncDone).toBe(false);
    expect(s.messageCount).toBe(3);
    expect(s.chatCount).toBe(2);
  });

  it("reporta completo depois de marcado", () => {
    setMeta(db, "initial_sync_done", "1");
    expect(getSyncStatus(db, false).initialSyncDone).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/queries.test.ts`
Expected: FAIL — `queries.js` não existe

- [ ] **Step 3: Implementar `src/mcp/queries.ts`**

O ponto delicado é `sanitizeFtsQuery`. O texto vem do modelo e pode conter aspas ou operadores do FTS5; sem tratamento, isso vira erro de sintaxe do SQLite no meio de uma busca legítima.

```typescript
import type { DB } from "../shared/migrations.js";
import type { ContactRow, SyncStatus } from "../shared/types.js";

export interface ChatSummary {
  jid: string;
  name: string | null;
  isGroup: boolean;
  unread: number;
  lastMessageAt: number | null;
  lastText: string | null;
}

export interface MessageView {
  id: string;
  at: number;
  fromMe: boolean;
  sender: string | null;
  type: string;
  text: string | null;
}

export type SearchHit = MessageView & { chatJid: string; chatName: string | null };

/**
 * The query text is written by a model and may contain quotes or FTS5 operators.
 * Each word becomes its own quoted term, so any input is a valid AND search.
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" ");
}

export function listChats(db: DB, opts: { limit?: number; onlyUnread?: boolean }): ChatSummary[] {
  const rows = db
    .prepare(`
      SELECT c.jid, c.name, c.is_group, c.unread_count, c.last_message_at,
             (SELECT m.text FROM messages m
               WHERE m.chat_jid = c.jid
               ORDER BY m.timestamp DESC LIMIT 1) AS last_text
        FROM chats c
       WHERE (@onlyUnread = 0 OR c.unread_count > 0)
       ORDER BY COALESCE(c.last_message_at, 0) DESC
       LIMIT @limit
    `)
    .all({ onlyUnread: opts.onlyUnread ? 1 : 0, limit: opts.limit ?? 30 }) as any[];

  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    isGroup: r.is_group === 1,
    unread: r.unread_count,
    lastMessageAt: r.last_message_at,
    lastText: r.last_text,
  }));
}

export function readMessages(
  db: DB,
  opts: { jid: string; since?: number; until?: number; limit?: number },
): MessageView[] {
  // Ordered DESC to take the most recent under the limit, then flipped back to
  // chronological order, which is how a reader expects to see a conversation.
  const rows = db
    .prepare(`
      SELECT msg_id, timestamp, from_me, sender_jid, type, text
        FROM messages
       WHERE chat_jid = @jid
         AND (@since IS NULL OR timestamp >= @since)
         AND (@until IS NULL OR timestamp <= @until)
       ORDER BY timestamp DESC
       LIMIT @limit
    `)
    .all({
      jid: opts.jid,
      since: opts.since ?? null,
      until: opts.until ?? null,
      limit: opts.limit ?? 100,
    }) as any[];

  return rows
    .map((r) => ({
      id: r.msg_id,
      at: r.timestamp,
      fromMe: r.from_me === 1,
      sender: r.sender_jid,
      type: r.type,
      text: r.text,
    }))
    .reverse();
}

export function searchMessages(
  db: DB,
  opts: { query: string; jid?: string; since?: number; limit?: number },
): SearchHit[] {
  const rows = db
    .prepare(`
      SELECT m.msg_id, m.timestamp, m.from_me, m.sender_jid, m.type, m.text,
             m.chat_jid, c.name AS chat_name
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        LEFT JOIN chats c ON c.jid = m.chat_jid
       WHERE messages_fts MATCH @q
         AND (@jid IS NULL OR m.chat_jid = @jid)
         AND (@since IS NULL OR m.timestamp >= @since)
       ORDER BY m.timestamp DESC
       LIMIT @limit
    `)
    .all({
      q: sanitizeFtsQuery(opts.query),
      jid: opts.jid ?? null,
      since: opts.since ?? null,
      limit: opts.limit ?? 50,
    }) as any[];

  return rows.map((r) => ({
    id: r.msg_id,
    at: r.timestamp,
    fromMe: r.from_me === 1,
    sender: r.sender_jid,
    type: r.type,
    text: r.text,
    chatJid: r.chat_jid,
    chatName: r.chat_name,
  }));
}

export function getContact(db: DB, query: string): ContactRow[] {
  // Falls back to chats so that groups, which have no contact row, remain findable.
  return db
    .prepare(`
      SELECT jid, name, push_name FROM contacts
       WHERE jid LIKE @like OR name LIKE @like OR push_name LIKE @like
      UNION
      SELECT jid, name, NULL AS push_name FROM chats
       WHERE jid LIKE @like OR name LIKE @like
       LIMIT 20
    `)
    .all({ like: `%${query}%` }) as ContactRow[];
}

export function getSyncStatus(db: DB, connected: boolean): SyncStatus {
  const m = db.prepare("SELECT count(*) AS n FROM messages").get() as any;
  const c = db.prepare("SELECT count(*) AS n FROM chats").get() as any;
  const done = db.prepare("SELECT value FROM meta WHERE key = 'initial_sync_done'").get() as any;
  const last = db.prepare("SELECT value FROM meta WHERE key = 'last_connected_at'").get() as any;
  return {
    connected,
    initialSyncDone: done?.value === "1",
    messageCount: m.n,
    chatCount: c.n,
    lastConnectedAt: last?.value ? Number(last.value) : null,
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/queries.test.ts` — Expected: PASS (13 testes)

Se `getContact` falhar por causa de acento em "Igor" versus "igor", note que `LIKE` no SQLite só é case-insensitive para ASCII — que é o caso deste teste. Busca por nome com acento é responsabilidade do FTS, não desta função.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/queries.ts tests/queries.test.ts
git commit -m "feat: camada de leitura com busca FTS saneada e status de sync"
```

---

### Task 6: Rascunhos e protocolo de controle

Esta é a task que justifica a arquitetura. O teste do Step 1 é o mais importante do projeto: ele garante que não existe caminho de envio que aceite texto vindo de fora.

**Files:**
- Create: `src/daemon/drafts.ts`, `src/daemon/control.ts`
- Test: `tests/control.test.ts`

**Interfaces:**
- Consumes: `ControlCommand`, `ControlResponse`, `DB`, `getSyncStatus`
- Produces:
  `DRAFT_TTL_MS = 600_000`;
  `class DraftStore { constructor(now?: () => number); create(jid: string, text: string): Draft; take(id: string): Draft | null; size(): number }`
  com `Draft = { id: string; jid: string; text: string; createdAt: number }`;
  `handleCommand(cmd: unknown, deps: ControlDeps): Promise<ControlResponse>` com
  `ControlDeps = { db: DB; drafts: DraftStore; sender: Sender; connected: () => boolean }` e
  `Sender = { sendText(jid: string, text: string): Promise<string>; fetchOlder(jid: string, pages: number): Promise<number> }`

- [ ] **Step 1: Escrever o teste que falha**

`tests/control.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate, type DB } from "../src/shared/migrations.js";
import { DraftStore, DRAFT_TTL_MS } from "../src/daemon/drafts.js";
import { handleCommand } from "../src/daemon/control.js";

const IGOR = "5511999@s.whatsapp.net";

let db: DB;
let drafts: DraftStore;
let sendText: ReturnType<typeof vi.fn>;
let fetchOlder: ReturnType<typeof vi.fn>;
let deps: any;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO chats (jid, name) VALUES (?, ?)").run(IGOR, "Igor");
  drafts = new DraftStore();
  sendText = vi.fn(async () => "SENT1");
  fetchOlder = vi.fn(async () => 50);
  deps = { db, drafts, sender: { sendText, fetchOlder }, connected: () => true };
});

describe("DraftStore", () => {
  it("cria com id único e devolve o texto exato", () => {
    const a = drafts.create(IGOR, "oi");
    const b = drafts.create(IGOR, "oi");
    expect(a.id).not.toBe(b.id);
    expect(a.text).toBe("oi");
  });

  it("take consome: o segundo take devolve null", () => {
    const d = drafts.create(IGOR, "oi");
    expect(drafts.take(d.id)?.text).toBe("oi");
    expect(drafts.take(d.id)).toBeNull();
  });

  it("expira depois do TTL", () => {
    let now = 1_000_000;
    const store = new DraftStore(() => now);
    const d = store.create(IGOR, "oi");
    now += DRAFT_TTL_MS + 1;
    expect(store.take(d.id)).toBeNull();
  });
});

describe("handleCommand — a trava de envio", () => {
  it("draft não envia nada", async () => {
    const res = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    expect(res.ok).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("draft devolve id, texto exato e nome resolvido", async () => {
    const res: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    expect(res.result.draftId).toBeTruthy();
    expect(res.result.text).toBe("oi");
    expect(res.result.to).toBe("Igor");
  });

  it("confirm envia exatamente o texto guardado", async () => {
    const d: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "texto guardado" }, deps);
    const res: any = await handleCommand({ cmd: "confirm", draftId: d.result.draftId }, deps);
    expect(res.ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(IGOR, "texto guardado");
  });

  it("IGNORA qualquer texto anexado ao confirm — só o rascunho vale", async () => {
    const d: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "texto legítimo" }, deps);
    await handleCommand(
      { cmd: "confirm", draftId: d.result.draftId, text: "texto injetado", jid: "5599@s.whatsapp.net" } as any,
      deps,
    );
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(IGOR, "texto legítimo");
  });

  it("confirm com id inexistente falha sem enviar", async () => {
    const res = await handleCommand({ cmd: "confirm", draftId: "nao-existe" }, deps);
    expect(res.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("o mesmo rascunho não pode ser enviado duas vezes", async () => {
    const d: any = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    await handleCommand({ cmd: "confirm", draftId: d.result.draftId }, deps);
    const again = await handleCommand({ cmd: "confirm", draftId: d.result.draftId }, deps);
    expect(again.ok).toBe(false);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("draft para jid desconhecido falha antes de tocar no WhatsApp", async () => {
    const res = await handleCommand({ cmd: "draft", jid: "nao-existe@s.whatsapp.net", text: "oi" }, deps);
    expect(res.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("desconectado, o draft é recusado", async () => {
    deps.connected = () => false;
    const res = await handleCommand({ cmd: "draft", jid: IGOR, text: "oi" }, deps);
    expect(res.ok).toBe(false);
  });

  it("comando desconhecido não derruba o daemon", async () => {
    const res = await handleCommand({ cmd: "rm -rf" }, deps);
    expect(res.ok).toBe(false);
  });

  it("comando malformado não derruba o daemon", async () => {
    expect((await handleCommand(null, deps)).ok).toBe(false);
    expect((await handleCommand({ cmd: "draft", jid: IGOR }, deps)).ok).toBe(false);
  });

  it("status responde sem depender de conexão", async () => {
    const res: any = await handleCommand({ cmd: "status" }, deps);
    expect(res.ok).toBe(true);
    expect(res.result.chatCount).toBe(1);
  });

  it("backfill repassa para o sender", async () => {
    const res: any = await handleCommand({ cmd: "backfill", jid: IGOR, pages: 2 }, deps);
    expect(res.ok).toBe(true);
    expect(fetchOlder).toHaveBeenCalledWith(IGOR, 2);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/control.test.ts`
Expected: FAIL — `drafts.js` não existe

- [ ] **Step 3: Implementar `src/daemon/drafts.ts`**

```typescript
import { randomUUID } from "node:crypto";

export const DRAFT_TTL_MS = 600_000; // 10 minutes

export interface Draft {
  id: string;
  jid: string;
  text: string;
  createdAt: number;
}

/**
 * Drafts live in the daemon, never in the MCP process. That is what makes the
 * two-step send a real control rather than a convention: the confirm command
 * carries only an id, so the model never supplies the text at send time.
 *
 * In-memory on purpose — a daemon restart drops pending drafts, which fails closed.
 */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly now: () => number = Date.now) {}

  create(jid: string, text: string): Draft {
    const draft: Draft = { id: randomUUID(), jid, text, createdAt: this.now() };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  /** Consumes the draft: a given draft can be sent at most once. */
  take(id: string): Draft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    this.drafts.delete(id);
    if (this.now() - draft.createdAt > DRAFT_TTL_MS) return null;
    return draft;
  }

  size(): number {
    return this.drafts.size;
  }
}
```

- [ ] **Step 4: Implementar `src/daemon/control.ts`**

```typescript
import type { DB } from "../shared/migrations.js";
import type { ControlResponse } from "../shared/types.js";
import { getSyncStatus } from "../mcp/queries.js";
import { setMeta } from "./ingest.js";
import type { DraftStore } from "./drafts.js";

export interface Sender {
  sendText(jid: string, text: string): Promise<string>;
  fetchOlder(jid: string, pages: number): Promise<number>;
}

export interface ControlDeps {
  db: DB;
  drafts: DraftStore;
  sender: Sender;
  connected: () => boolean;
}

const fail = (error: string): ControlResponse => ({ ok: false, error });
const done = (result: unknown): ControlResponse => ({ ok: true, result });

function chatName(db: DB, jid: string): string | null | undefined {
  const row = db.prepare("SELECT name FROM chats WHERE jid = ?").get(jid) as { name: string | null } | undefined;
  return row ? row.name : undefined;
}

/**
 * Note what `confirm` does NOT read: any text or jid on the incoming command.
 * Both come from the stored draft. Extra fields are ignored by construction,
 * not by validation — there is no code path that could use them.
 */
export async function handleCommand(cmd: unknown, deps: ControlDeps): Promise<ControlResponse> {
  const c = cmd as any;
  if (!c || typeof c !== "object" || typeof c.cmd !== "string") {
    return fail("comando malformado");
  }

  try {
    switch (c.cmd) {
      case "status":
        return done(getSyncStatus(deps.db, deps.connected()));

      case "draft": {
        if (typeof c.jid !== "string" || typeof c.text !== "string" || c.text.trim() === "") {
          return fail("draft exige jid e text não vazios");
        }
        if (!deps.connected()) {
          return fail("WhatsApp desconectado — o rascunho não pôde ser criado. Verifique o daemon.");
        }
        const name = chatName(deps.db, c.jid);
        if (name === undefined) {
          return fail(`jid desconhecido: ${c.jid}. Use get_contact para achar o destinatário certo.`);
        }
        const draft = deps.drafts.create(c.jid, c.text);
        return done({ draftId: draft.id, jid: draft.jid, to: name ?? c.jid, text: draft.text });
      }

      case "confirm": {
        if (typeof c.draftId !== "string") return fail("confirm exige draftId");
        const draft = deps.drafts.take(c.draftId);
        if (!draft) {
          return fail("rascunho inexistente, já enviado ou vencido (10 min). Redija de novo com draft_message.");
        }
        if (!deps.connected()) return fail("WhatsApp desconectado — nada foi enviado.");
        const msgId = await deps.sender.sendText(draft.jid, draft.text);
        return done({ sent: true, msgId, jid: draft.jid });
      }

      case "backfill": {
        if (typeof c.jid !== "string") return fail("backfill exige jid");
        if (!deps.connected()) return fail("WhatsApp desconectado — backfill indisponível.");
        const pages = Number.isInteger(c.pages) && c.pages > 0 ? Math.min(c.pages, 20) : 1;
        const fetched = await deps.sender.fetchOlder(c.jid, pages);
        setMeta(deps.db, "last_backfill_at", String(Math.floor(Date.now() / 1000)));
        return done({ fetched });
      }

      default:
        return fail(`comando desconhecido: ${c.cmd}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run tests/control.test.ts` — Expected: PASS (16 testes)
Run: `npm run typecheck` — Expected: sem erro

- [ ] **Step 6: Commit**

```bash
git add src/daemon/drafts.ts src/daemon/control.ts tests/control.test.ts
git commit -m "feat: rascunhos no daemon e protocolo de controle sem envio direto"
```

---

### Task 7: Conexão Baileys e backfill

Ponto de decisão: se a `6.7.24` não conectar (WhatsApp costuma cortar versões antigas de protocolo), troque para `7.0.0-rc14` e rode a suíte de novo. A interface `Sender` isola essa escolha — nada além de `socket.ts` muda.

**Files:**
- Create: `src/daemon/socket.ts`, `src/daemon/backfill.ts`
- Test: `tests/backfill.test.ts`

**Interfaces:**
- Consumes: `ingestMessages`, `ingestChats`, `ingestContacts`, `setMeta`, `Paths`, `Sender`
- Produces:
  `interface WhatsAppConnection extends Sender { isConnected(): boolean; close(): Promise<void> }`;
  `createConnection(opts: { authDir: string; db: DB; onQr?(qr: string): void }): Promise<WhatsAppConnection>`;
  `planBackfill(db: DB, jid: string): { msgId: string; ts: number } | null`

- [ ] **Step 1: Escrever o teste que falha**

Só `planBackfill` é testado aqui: é a lógica de cursor. A conexão em si é uma casca sobre o Baileys e seria testada apenas contra um mock do próprio mock.

`tests/backfill.test.ts`:

```typescript
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
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/backfill.test.ts`
Expected: FAIL — `backfill.js` não existe

- [ ] **Step 3: Implementar `src/daemon/backfill.ts`**

```typescript
import type { DB } from "../shared/migrations.js";

/**
 * fetchMessageHistory pages backwards from a message you already have, so the
 * cursor is the oldest known message of the chat. No local history, no cursor —
 * which is exactly why the daemon has to exist.
 */
export function planBackfill(db: DB, jid: string): { msgId: string; ts: number } | null {
  const row = db
    .prepare("SELECT oldest_msg_id, oldest_ts, complete FROM sync_state WHERE chat_jid = ?")
    .get(jid) as { oldest_msg_id: string | null; oldest_ts: number | null; complete: number } | undefined;

  if (!row || row.complete === 1) return null;
  if (!row.oldest_msg_id || row.oldest_ts === null) return null;
  return { msgId: row.oldest_msg_id, ts: row.oldest_ts };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/backfill.test.ts` — Expected: PASS (3 testes)

- [ ] **Step 5: Implementar `src/daemon/socket.ts`**

```typescript
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import type { DB } from "../shared/migrations.js";
import { ingestMessages, ingestChats, ingestContacts, setMeta } from "./ingest.js";
import { planBackfill } from "./backfill.js";
import type { Sender } from "./control.js";

export interface WhatsAppConnection extends Sender {
  isConnected(): boolean;
  close(): Promise<void>;
}

/**
 * Everything WhatsApp-specific is confined to this file. The rest of the system
 * talks to the Sender interface, which is what keeps a future migration to the
 * official Cloud API from touching tools, schema, or queries.
 */
export async function createConnection(opts: {
  authDir: string;
  db: DB;
  onQr?: (qr: string) => void;
}): Promise<WhatsAppConnection> {
  const { db } = opts;
  const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);

  let sock: WASocket;
  let connected = false;
  let closing = false;
  let backoffMs = 1_000;

  const start = (): void => {
    sock = makeWASocket({ auth: state, syncFullHistory: true, printQRInTerminal: false });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (u.qr) {
        (opts.onQr ?? ((qr: string) => qrcode.generate(qr, { small: true })))(u.qr);
      }
      if (u.connection === "open") {
        connected = true;
        backoffMs = 1_000;
        setMeta(db, "last_connected_at", String(Math.floor(Date.now() / 1000)));
        console.error("[whatsapp-daemon] conectado.");
      }
      if (u.connection === "close") {
        connected = false;
        const status = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          console.error("[whatsapp-daemon] sessão encerrada no celular. Apague ~/.whatsapp-mcp/auth e pareie de novo.");
          return;
        }
        if (closing) return;
        console.error(`[whatsapp-daemon] desconectado (${status}); reconectando em ${backoffMs}ms.`);
        setTimeout(start, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    });

    sock.ev.on("messaging-history.set", ({ messages, chats, contacts, isLatest }) => {
      ingestChats(db, chats ?? []);
      ingestContacts(db, contacts ?? []);
      const n = ingestMessages(db, messages ?? []);
      console.error(`[whatsapp-daemon] history: +${n} mensagens${isLatest ? " (último lote)" : ""}`);
      if (isLatest) setMeta(db, "initial_sync_done", "1");
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      ingestMessages(db, messages ?? []);
    });

    sock.ev.on("chats.upsert", (chats) => ingestChats(db, chats ?? []));
    sock.ev.on("contacts.upsert", (contacts) => ingestContacts(db, contacts ?? []));
  };

  start();

  return {
    isConnected: () => connected,

    async sendText(jid: string, text: string): Promise<string> {
      const sent = await sock.sendMessage(jid, { text });
      if (sent) ingestMessages(db, [sent]);
      return sent?.key?.id ?? "";
    },

    async fetchOlder(jid: string, pages: number): Promise<number> {
      // Results arrive asynchronously through messaging-history.set; this only
      // asks. The caller learns the outcome from the growing message count.
      let asked = 0;
      for (let i = 0; i < pages; i++) {
        const cursor = planBackfill(db, jid);
        if (!cursor) break;
        await sock.fetchMessageHistory(50, { remoteJid: jid, id: cursor.msgId, fromMe: false }, cursor.ts);
        asked += 50;
        await new Promise((r) => setTimeout(r, 1_500)); // human-paced, avoids tripping rate limits
      }
      return asked;
    },

    async close(): Promise<void> {
      closing = true;
      connected = false;
      sock.end(undefined);
    },
  };
}
```

Adicionar `@hapi/boom` às dependências: `npm install @hapi/boom`

- [ ] **Step 6: Verificar tipos**

Run: `npm run typecheck`
Expected: sem erro. Se a assinatura de `fetchMessageHistory` divergir na versão instalada, ajuste a chamada conforme o `.d.ts` do pacote — a ordem dos argumentos mudou entre 6.x e 7.x.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/socket.ts src/daemon/backfill.ts tests/backfill.test.ts package.json
git commit -m "feat: conexão Baileys atrás de interface estreita e cursor de backfill"
```

---

### Task 8: Daemon completo

**Files:**
- Create: `src/daemon/index.ts`, `src/daemon/server.ts`
- Test: `tests/control-server.test.ts`

**Interfaces:**
- Consumes: tudo das tasks 1–7
- Produces:
  `startControlServer(opts: { socketFile: string; deps: ControlDeps }): Promise<{ close(): Promise<void> }>`

- [ ] **Step 1: Escrever o teste que falha**

`tests/control-server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { connect } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, type DB } from "../src/shared/migrations.js";
import { DraftStore } from "../src/daemon/drafts.js";
import { startControlServer } from "../src/daemon/server.js";

let dir: string;
let db: DB;
let server: { close(): Promise<void> };
let socketFile: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wamcp-sock-"));
  socketFile = join(dir, "control.sock");
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO chats (jid, name) VALUES (?, ?)").run("5511999@s.whatsapp.net", "Igor");
  server = await startControlServer({
    socketFile,
    deps: {
      db,
      drafts: new DraftStore(),
      sender: { sendText: vi.fn(async () => "SENT"), fetchOlder: vi.fn(async () => 0) },
      connected: () => true,
    },
  });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function ask(cmd: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketFile);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify(cmd) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        sock.end();
        resolve(JSON.parse(buf.trim()));
      }
    });
    sock.on("error", reject);
  });
}

describe("startControlServer", () => {
  it("cria o socket com modo 0600", () => {
    expect(statSync(socketFile).mode & 0o777).toBe(0o600);
  });

  it("responde status em JSONL", async () => {
    const res = await ask({ cmd: "status" });
    expect(res.ok).toBe(true);
    expect(res.result.chatCount).toBe(1);
  });

  it("faz o ciclo draft → confirm por socket", async () => {
    const d = await ask({ cmd: "draft", jid: "5511999@s.whatsapp.net", text: "oi" });
    const c = await ask({ cmd: "confirm", draftId: d.result.draftId });
    expect(c.ok).toBe(true);
  });

  it("JSON inválido devolve erro em vez de derrubar o servidor", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const sock = connect(socketFile);
      let buf = "";
      sock.on("connect", () => sock.write("{isso não é json\n"));
      sock.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\n")) { sock.end(); resolve(JSON.parse(buf.trim())); }
      });
      sock.on("error", reject);
    });
    expect(res.ok).toBe(false);
    const after = await ask({ cmd: "status" });
    expect(after.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/control-server.test.ts`
Expected: FAIL — `server.js` não existe

- [ ] **Step 3: Implementar `src/daemon/server.ts`**

```typescript
import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { handleCommand, type ControlDeps } from "./control.js";

/**
 * One JSON object per line, in and out. A unix socket with 0600 means the OS
 * does the authentication: no other user on the machine can send commands.
 */
export async function startControlServer(opts: {
  socketFile: string;
  deps: ControlDeps;
}): Promise<{ close(): Promise<void> }> {
  if (existsSync(opts.socketFile)) unlinkSync(opts.socketFile); // stale socket from a crash

  const server: Server = createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void (async () => {
          let response;
          try {
            response = await handleCommand(JSON.parse(line), opts.deps);
          } catch {
            response = { ok: false, error: "JSON inválido no socket de controle" };
          }
          sock.write(JSON.stringify(response) + "\n");
        })();
      }
    });
    sock.on("error", () => sock.destroy()); // a broken client must not take the daemon down
  });

  await new Promise<void>((resolve) => server.listen(opts.socketFile, resolve));
  chmodSync(opts.socketFile, 0o600);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (existsSync(opts.socketFile)) unlinkSync(opts.socketFile);
          resolve();
        });
      }),
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/control-server.test.ts` — Expected: PASS (4 testes)

- [ ] **Step 5: Implementar `src/daemon/index.ts`**

```typescript
#!/usr/bin/env node
/**
 * whatsapp-daemon — owns the WhatsApp connection, the database, and the drafts.
 * It is the only process that writes anything.
 */
import { resolvePaths, ensureDirs } from "../shared/paths.js";
import { openWritableDb } from "../shared/db.js";
import { createConnection } from "./socket.js";
import { DraftStore } from "./drafts.js";
import { startControlServer } from "./server.js";

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);

  const db = openWritableDb(paths.dbFile);
  const drafts = new DraftStore();

  console.error("[whatsapp-daemon] conectando ao WhatsApp. Se aparecer um QR, leia com o celular.");
  const conn = await createConnection({ authDir: paths.authDir, db });

  const server = await startControlServer({
    socketFile: paths.socketFile,
    deps: { db, drafts, sender: conn, connected: () => conn.isConnected() },
  });

  console.error(`[whatsapp-daemon] ouvindo em ${paths.socketFile}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[whatsapp-daemon] ${signal}, encerrando.`);
    await server.close().catch(() => {});
    await conn.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[whatsapp-daemon] erro fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Validar de ponta a ponta, na mão**

Run: `npm run build && node build/daemon/index.js`
Expected: aparece um QR no terminal. Leia com o WhatsApp do celular em Aparelhos conectados. Depois do pareamento, o log mostra `conectado.` e lotes de `history: +N mensagens`.

Deixe rodando alguns minutos até aparecer `(último lote)`. Em outro terminal:

Run: `printf '{"cmd":"status"}\n' | nc -U ~/.whatsapp-mcp/control.sock`
Expected: JSON com `initialSyncDone: true` e `messageCount` na casa dos milhares.

Se a conexão falhar com erro de versão de protocolo, este é o ponto de decisão da Task 7: `npm install @whiskeysockets/baileys@7.0.0-rc14`, rode `npm test` e repita este passo.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/index.ts src/daemon/server.ts tests/control-server.test.ts
git commit -m "feat: daemon completo com socket de controle em unix socket 0600"
```

---

### Task 9: Servidor MCP e tools de leitura

**Files:**
- Create: `src/mcp/client.ts`, `src/mcp/index.ts`, `src/mcp/tools/read.ts`
- Test: `tests/mcp-read.test.ts`

**Interfaces:**
- Consumes: `openReadonlyDb`, `queries.ts`, `Paths`
- Produces:
  `class ControlClient { constructor(socketFile: string); send(cmd: ControlCommand): Promise<ControlResponse> }`;
  `registerReadTools(server: McpServer, ctx: ToolContext): void` com
  `ToolContext = { db: DB; client: ControlClient }`;
  `createServer(ctx: ToolContext): McpServer`

- [ ] **Step 1: Escrever o teste que falha**

`tests/mcp-read.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestMessages, ingestChats, setMeta } from "../src/daemon/ingest.js";
import { createServer } from "../src/mcp/index.js";

const IGOR = "5511999@s.whatsapp.net";

async function connectClient(db: DB) {
  const server = createServer({ db, client: { send: async () => ({ ok: true, result: {} }) } as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

let db: DB;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ingestChats(db, [{ id: IGOR, name: "Igor", unreadCount: 1 }]);
  ingestMessages(db, [
    { key: { remoteJid: IGOR, fromMe: false, id: "M1" }, messageTimestamp: 1000, message: { conversation: "bora marcar a reunião" } },
  ]);
});

function textOf(res: any): string {
  return res.content.map((c: any) => c.text).join("\n");
}

describe("tools de leitura", () => {
  it("expõe as oito tools", async () => {
    const client = await connectClient(db);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "backfill_chat", "confirm_send", "draft_message", "get_contact",
      "list_chats", "read_messages", "search_messages", "whatsapp_status",
    ]);
  });

  it("list_chats traz o chat com não-lidas", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "list_chats", arguments: { onlyUnread: true } });
    expect(textOf(res)).toContain("Igor");
  });

  it("search_messages encontra sem acento", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "search_messages", arguments: { query: "reuniao" } });
    expect(textOf(res)).toContain("reunião");
  });

  it("avisa que o sync está incompleto", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "search_messages", arguments: { query: "reuniao" } });
    expect(textOf(res)).toMatch(/sincroniza/i);
  });

  it("não avisa quando o sync terminou", async () => {
    setMeta(db, "initial_sync_done", "1");
    const client = await connectClient(db);
    const res = await client.callTool({ name: "search_messages", arguments: { query: "reuniao" } });
    expect(textOf(res)).not.toMatch(/sincroniza/i);
  });

  it("read_messages com jid inexistente devolve vazio explícito, não erro mudo", async () => {
    const client = await connectClient(db);
    const res = await client.callTool({ name: "read_messages", arguments: { jid: "nada@s.whatsapp.net" } });
    expect(textOf(res)).toMatch(/nenhuma mensagem/i);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/mcp-read.test.ts`
Expected: FAIL — `src/mcp/index.js` não existe

- [ ] **Step 3: Implementar `src/mcp/client.ts`**

```typescript
import { connect } from "node:net";
import type { ControlCommand, ControlResponse } from "../shared/types.js";

/** Thin JSONL client for the daemon's control socket. One command per connection. */
export class ControlClient {
  constructor(private readonly socketFile: string) {}

  send(cmd: ControlCommand): Promise<ControlResponse> {
    return new Promise((resolve) => {
      const sock = connect(this.socketFile);
      let buf = "";
      const done = (r: ControlResponse) => { sock.destroy(); resolve(r); };

      sock.setTimeout(30_000, () =>
        done({ ok: false, error: "o daemon não respondeu em 30s." }));

      sock.on("connect", () => sock.write(JSON.stringify(cmd) + "\n"));

      sock.on("data", (d) => {
        buf += d.toString();
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        try {
          done(JSON.parse(buf.slice(0, idx)) as ControlResponse);
        } catch {
          done({ ok: false, error: "resposta ilegível do daemon" });
        }
      });

      sock.on("error", () =>
        done({
          ok: false,
          error: "daemon fora do ar. Suba com: npx whatsapp-daemon (ou carregue o serviço do launchd).",
        }));
    });
  }
}
```

- [ ] **Step 4: Implementar `src/mcp/tools/read.ts`**

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DB } from "../../shared/migrations.js";
import { listChats, readMessages, searchMessages, getContact, getSyncStatus } from "../queries.js";
import type { ControlClient } from "../client.js";

export interface ToolContext {
  db: DB;
  client: ControlClient;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/**
 * A partial sync is indistinguishable from "nothing found", so every read says
 * so instead of letting the model conclude the message does not exist.
 */
function syncNote(db: DB): string {
  const status = getSyncStatus(db, true);
  return status.initialSyncDone
    ? ""
    : `\n\n⚠️ O histórico ainda está sincronizando (${status.messageCount} mensagens até agora). Resultados podem estar incompletos.`;
}

const when = (ts: number) => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16);

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "list_chats",
    "Lista conversas por atividade recente. Use onlyUnread para triar o que falta responder.",
    { limit: z.number().int().min(1).max(200).optional(), onlyUnread: z.boolean().optional() },
    async ({ limit, onlyUnread }) => {
      const chats = listChats(ctx.db, { limit, onlyUnread });
      if (chats.length === 0) return text("Nenhuma conversa encontrada." + syncNote(ctx.db));
      const lines = chats.map(
        (c) =>
          `${c.name ?? c.jid}${c.isGroup ? " (grupo)" : ""}${c.unread > 0 ? ` — ${c.unread} não lidas` : ""}\n` +
          `  jid: ${c.jid}\n  última: ${c.lastText ?? "(sem texto)"}`,
      );
      return text(lines.join("\n\n") + syncNote(ctx.db));
    },
  );

  server.tool(
    "read_messages",
    "Lê as mensagens de uma conversa. since/until são epoch em segundos.",
    {
      jid: z.string(),
      since: z.number().int().optional(),
      until: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async (args) => {
      const msgs = readMessages(ctx.db, args);
      if (msgs.length === 0) return text(`Nenhuma mensagem em ${args.jid} nesse intervalo.` + syncNote(ctx.db));
      const lines = msgs.map(
        (m) => `[${when(m.at)}] ${m.fromMe ? "eu" : (m.sender ?? args.jid)}: ${m.text ?? `(${m.type})`}`,
      );
      return text(lines.join("\n") + syncNote(ctx.db));
    },
  );

  server.tool(
    "search_messages",
    "Busca full-text no histórico. Ignora acento e caixa.",
    {
      query: z.string().min(1),
      jid: z.string().optional(),
      since: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      const hits = searchMessages(ctx.db, args);
      if (hits.length === 0) return text(`Nada encontrado para "${args.query}".` + syncNote(ctx.db));
      const lines = hits.map(
        (h) => `[${when(h.at)}] ${h.chatName ?? h.chatJid} — ${h.fromMe ? "eu" : "eles"}: ${h.text ?? `(${h.type})`}`,
      );
      return text(lines.join("\n") + syncNote(ctx.db));
    },
  );

  server.tool(
    "get_contact",
    "Resolve nome ou número em jid. Use antes de redigir uma mensagem.",
    { query: z.string().min(1) },
    async ({ query }) => {
      const found = getContact(ctx.db, query);
      if (found.length === 0) return text(`Nenhum contato para "${query}".` + syncNote(ctx.db));
      return text(found.map((c) => `${c.name ?? c.push_name ?? "(sem nome)"} — ${c.jid}`).join("\n"));
    },
  );

  server.tool(
    "whatsapp_status",
    "Estado da conexão e do sync de histórico.",
    {},
    async () => {
      const res = await ctx.client.send({ cmd: "status" });
      if (!res.ok) return text(`Não deu para falar com o daemon: ${res.error}`);
      const s = res.result as any;
      return text(
        `conectado: ${s.connected ? "sim" : "não"}\n` +
          `sync inicial: ${s.initialSyncDone ? "completo" : "em andamento"}\n` +
          `mensagens: ${s.messageCount}\nconversas: ${s.chatCount}`,
      );
    },
  );
}
```

- [ ] **Step 5: Implementar `src/mcp/index.ts`**

```typescript
#!/usr/bin/env node
/**
 * whatsapp-mcp — read-only view of the WhatsApp store, plus a two-step send.
 *
 * STDIO PROTOCOL RULE: stdout is the JSON-RPC channel. Never console.log here.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePaths } from "../shared/paths.js";
import { openReadonlyDb } from "../shared/db.js";
import { ControlClient } from "./client.js";
import { registerReadTools, type ToolContext } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export const SERVER_NAME = "whatsapp-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}

async function main(): Promise<void> {
  const paths = resolvePaths();

  let db;
  try {
    db = openReadonlyDb(paths.dbFile);
  } catch {
    console.error(
      `[${SERVER_NAME}] banco não encontrado em ${paths.dbFile}.\n` +
        "Suba o daemon primeiro: npx whatsapp-daemon",
    );
    process.exit(1);
  }

  const ctx: ToolContext = { db, client: new ControlClient(paths.socketFile) };
  const server = createServer(ctx);

  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} rodando em stdio (leitura somente do banco).`);
}

const isMain = (() => {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] erro fatal:`, err);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Rodar (ainda falha por causa de write.ts — siga para a Task 10 antes de fechar)**

Run: `npx vitest run tests/mcp-read.test.ts`
Expected: FAIL — `./tools/write.js` não existe. Essa é a única falha aceitável aqui; a Task 10 a resolve.

- [ ] **Step 7: Commit parcial**

```bash
git add src/mcp/client.ts src/mcp/index.ts src/mcp/tools/read.ts tests/mcp-read.test.ts
git commit -m "wip: servidor MCP e tools de leitura"
```

---

### Task 10: Tools de escrita, empacotamento e README

**Files:**
- Create: `src/mcp/tools/write.ts`, `README.md`, `LICENSE`, `launchd/com.samuelcabral.whatsapp-daemon.plist`
- Test: `tests/mcp-write.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `ControlClient`
- Produces: `registerWriteTools(server: McpServer, ctx: ToolContext): void`

- [ ] **Step 1: Escrever o teste que falha**

`tests/mcp-write.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrate, type DB } from "../src/shared/migrations.js";
import { ingestChats } from "../src/daemon/ingest.js";
import { createServer } from "../src/mcp/index.js";

const IGOR = "5511999@s.whatsapp.net";

let db: DB;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  ingestChats(db, [{ id: IGOR, name: "Igor" }]);
  send = vi.fn(async (cmd: any) => {
    if (cmd.cmd === "draft") return { ok: true, result: { draftId: "D1", jid: cmd.jid, to: "Igor", text: cmd.text } };
    if (cmd.cmd === "confirm") return { ok: true, result: { sent: true, msgId: "S1", jid: IGOR } };
    if (cmd.cmd === "backfill") return { ok: true, result: { fetched: 50 } };
    return { ok: false, error: "?" };
  });
});

async function connectClient() {
  const server = createServer({ db, client: { send } as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (res: any) => res.content.map((c: any) => c.text).join("\n");

describe("tools de escrita", () => {
  it("draft_message não envia e mostra o texto exato para revisão", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "draft_message", arguments: { jid: IGOR, text: "oi Igor" } });
    expect(send).toHaveBeenCalledWith({ cmd: "draft", jid: IGOR, text: "oi Igor" });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: "confirm" }));
    expect(textOf(res)).toContain("oi Igor");
    expect(textOf(res)).toContain("D1");
  });

  it("confirm_send manda só o draftId ao daemon", async () => {
    const client = await connectClient();
    await client.callTool({ name: "confirm_send", arguments: { draftId: "D1" } });
    expect(send).toHaveBeenCalledWith({ cmd: "confirm", draftId: "D1" });
  });

  it("o schema de confirm_send não aceita texto", async () => {
    const client = await connectClient();
    const tool = (await client.listTools()).tools.find((t) => t.name === "confirm_send")!;
    expect(Object.keys((tool.inputSchema as any).properties ?? {})).toEqual(["draftId"]);
  });

  it("erro do daemon vira mensagem legível, não exceção", async () => {
    send = vi.fn(async () => ({ ok: false, error: "daemon fora do ar" }));
    const client = await connectClient();
    const res = await client.callTool({ name: "confirm_send", arguments: { draftId: "X" } });
    expect(textOf(res)).toContain("daemon fora do ar");
  });

  it("backfill_chat repassa jid e páginas", async () => {
    const client = await connectClient();
    await client.callTool({ name: "backfill_chat", arguments: { jid: IGOR, pages: 3 } });
    expect(send).toHaveBeenCalledWith({ cmd: "backfill", jid: IGOR, pages: 3 });
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/mcp-write.test.ts`
Expected: FAIL — `write.js` não existe

- [ ] **Step 3: Implementar `src/mcp/tools/write.ts`**

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./read.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "draft_message",
    "Prepara uma mensagem para envio. NÃO envia. Devolve o texto exato e um draftId; mostre os dois ao usuário e só chame confirm_send depois que ele aprovar.",
    { jid: z.string(), text: z.string().min(1) },
    async (args) => {
      const res = await ctx.client.send({ cmd: "draft", jid: args.jid, text: args.text });
      if (!res.ok) return text(`Rascunho não criado: ${res.error}`);
      const r = res.result as any;
      return text(
        `Rascunho pronto (nada foi enviado).\n\nPara: ${r.to}\nTexto:\n${r.text}\n\n` +
          `draftId: ${r.draftId}\nExpira em 10 minutos. Confirme com confirm_send para enviar.`,
      );
    },
  );

  // Deliberately no text parameter: the daemon sends what it stored, so the
  // model cannot supply message content at send time.
  server.tool(
    "confirm_send",
    "Envia um rascunho criado por draft_message. Só depois de o usuário ter visto o texto e aprovado.",
    { draftId: z.string() },
    async ({ draftId }) => {
      const res = await ctx.client.send({ cmd: "confirm", draftId });
      if (!res.ok) return text(`Não enviado: ${res.error}`);
      const r = res.result as any;
      return text(`Enviado para ${r.jid} (id ${r.msgId}).`);
    },
  );

  server.tool(
    "backfill_chat",
    "Puxa histórico mais antigo de uma conversa, 50 mensagens por página. Use quando uma busca parecer incompleta.",
    { jid: z.string(), pages: z.number().int().min(1).max(20).optional() },
    async ({ jid, pages }) => {
      const res = await ctx.client.send({ cmd: "backfill", jid, pages: pages ?? 1 });
      if (!res.ok) return text(`Backfill falhou: ${res.error}`);
      return text(
        `Pedidas ${(res.result as any).fetched} mensagens antigas de ${jid}. ` +
          "Elas chegam de forma assíncrona; espere alguns segundos e busque de novo.",
      );
    },
  );
}
```

- [ ] **Step 4: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS em tudo — `tests/paths`, `migrations`, `normalize`, `ingest`, `queries`, `control`, `backfill`, `control-server`, `mcp-read`, `mcp-write`.

Run: `npm run typecheck && npm run build`
Expected: sem erro.

- [ ] **Step 5: Criar o plist do launchd**

`launchd/com.samuelcabral.whatsapp-daemon.plist` (troque `SEU_USUARIO` e o caminho do projeto):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.samuelcabral.whatsapp-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/SEU_USUARIO/Documents/6-work/projetos/whatsapp-mcp/build/daemon/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/SEU_USUARIO/.whatsapp-mcp/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/SEU_USUARIO/.whatsapp-mcp/daemon.log</string>
</dict>
</plist>
```

Instalar:

```bash
cp launchd/com.samuelcabral.whatsapp-daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.samuelcabral.whatsapp-daemon.plist
```

Confirme o caminho do node com `which node` antes — em macOS com Homebrew costuma ser `/opt/homebrew/bin/node`.

- [ ] **Step 6: Escrever o `README.md`**

Precisa cobrir, sem rodeios: o que é; que o banco guarda o WhatsApp inteiro em texto claro em `~/.whatsapp-mcp/store.db` com permissão 600; que o Baileys é cliente não-oficial e automação contraria os Termos do WhatsApp, com risco real de banimento do número; o pareamento por QR; o registro no Claude Code; e o fluxo de dois passos para envio.

Trecho do registro no Claude Code, para o README:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/Users/SEU_USUARIO/Documents/6-work/projetos/whatsapp-mcp/build/mcp/index.js"]
    }
  }
}
```

- [ ] **Step 7: Validar na mão, com o Claude Code**

Com o daemon rodando e o MCP registrado, abra uma sessão nova e teste os quatro casos de uso:

1. "o que preciso responder no WhatsApp?" → deve usar `list_chats` com `onlyUnread`
2. "resume o grupo X hoje" → `list_chats` + `read_messages`
3. "onde me mandaram um link de vaga?" → `search_messages`
4. "responde pro Igor que confirmo o ensaio" → `get_contact` → `draft_message` → **o texto aparece para você** → só então `confirm_send`

O passo 4 é a validação que importa: se alguma mensagem sair sem você ter lido o rascunho antes, pare e trate como bug de segurança, não de UX.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/write.ts tests/mcp-write.test.ts README.md LICENSE launchd/
git commit -m "feat: tools de escrita em dois passos, launchd e README"
```

---

## Self-Review

**Cobertura do spec:**

| requisito do spec | onde |
|---|---|
| Resumir conversa | Task 9 (`list_chats`, `read_messages`) |
| Buscar histórico | Task 5 + Task 9 (`search_messages`) |
| Enviar mensagem | Task 6 + Task 10 (`draft_message`, `confirm_send`) |
| Triar não-lidas | Task 5 + Task 9 (`onlyUnread`) |
| Daemon é o único escritor | Tasks 2, 8 |
| MCP lê read-only | Task 2 (`openReadonlyDb`) |
| Rascunho no daemon | Task 6 |
| `confirm` sem texto | Tasks 6 e 10, com teste dedicado em cada |
| FTS sem acento | Task 2 (schema), Task 5 (query) |
| Estado de sync visível | Task 5 (`getSyncStatus`), Task 9 (`syncNote`) |
| Permissões 700/600 | Tasks 1, 2, 8 |
| Backfill paginado | Tasks 7, 10 |
| Erros com instrução | Tasks 6, 9, 10 |
| Mídia fora do MVP | Task 3 (`classify` guarda tipo e legenda) |
| Migração futura para Cloud API | Task 7 (interface `Sender`) |

Sem lacunas.

**Consistência de tipos verificada:** `DB` é definido uma vez em `migrations.ts` e reexportado por `db.ts`. `Sender` é declarado em `control.ts` e implementado por `socket.ts`. `ToolContext` nasce em `tools/read.ts` e é importado por `tools/write.ts` e `index.ts`. `ControlCommand` em `types.ts` é o mesmo que `ControlClient.send` aceita e que `handleCommand` interpreta.

**Ordem de dependência:** cada task só usa o que as anteriores produziram, com uma exceção declarada: a Task 9 fica vermelha até a Task 10 criar `tools/write.ts`. As duas poderiam ser uma só; ficam separadas porque a Task 10 é onde mora a garantia de que `confirm_send` não aceita texto, e essa merece revisão isolada.

**Riscos de execução, todos com ponto de decisão explícito:**

1. Baileys `6.7.24` pode não conectar. Ponto de decisão na Task 8, Step 6 — trocar para `7.0.0-rc14`.
2. A assinatura de `fetchMessageHistory` muda entre 6.x e 7.x. Task 7, Step 6 manda conferir o `.d.ts`.
3. `syncFullHistory` pode trazer muito e demorar. O sistema é usável durante o sync porque toda leitura avisa que ele está incompleto.
