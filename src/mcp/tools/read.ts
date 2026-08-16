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
        (m) =>
          `[${when(m.at)}] ${m.fromMe ? "eu" : (m.senderName ?? m.sender ?? args.jid)}: ${m.text ?? `(${m.type})`}`,
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
        (h) =>
          `[${when(h.at)}] ${h.chatName ?? h.chatJid} — ${h.fromMe ? "eu" : (h.senderName ?? "eles")}: ${h.text ?? `(${h.type})`}`,
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
