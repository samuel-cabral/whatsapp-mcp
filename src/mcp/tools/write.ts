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
