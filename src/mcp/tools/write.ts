import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./read.js";
import { MAX_BACKFILL_PAGES, PAGE_SIZE } from "../../shared/backfill-limits.js";

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
    `Puxa histórico mais antigo de uma conversa, ${PAGE_SIZE} mensagens por página. Use quando uma busca parecer incompleta.`,
    { jid: z.string(), pages: z.number().int().min(1).max(MAX_BACKFILL_PAGES).optional() },
    async ({ jid, pages }) => {
      const res = await ctx.client.send({ cmd: "backfill", jid, pages: pages ?? 1 });
      if (!res.ok) return text(`Backfill falhou: ${res.error}`);

      const r = res.result as { fetched: number; stopped: "pages" | "exhausted" | "budget" };
      // Why it stopped is the difference between "there is no more history" and "there
      // is more, ask again" — a count alone leaves the caller guessing which.
      const why =
        r.stopped === "exhausted"
          ? " A conversa não tem mais histórico para trás: chegou ao começo."
          : r.stopped === "budget"
            ? " Parou no limite de tempo do comando antes de esgotar as páginas; chame de novo para continuar de onde parou."
            : "";
      return text(
        `Pedidas ${r.fetched} mensagens antigas de ${jid}. ` +
          "Elas chegam de forma assíncrona; espere alguns segundos e busque de novo." +
          why,
      );
    },
  );

  server.tool(
    "transcribe_audio",
    "Transcreve um áudio específico com o whisper local: nota de voz ou áudio encaminhado (mp3 etc.). " +
      "Use quando a leitura mostrar (audio, id …), (áudio, transcrevendo) parado ou (áudio, transcrição " +
      "falhou). Aceita o id cortado que a leitura mostra. Já transcrito, devolve o texto guardado sem " +
      "reprocessar, a menos que force.",
    {
      jid: z.string(),
      // Both, always: the store's uniqueness is (chat_jid, msg_id), so a msgId on its
      // own could name somebody else's message and hand back their words.
      msgId: z.string(),
      force: z.boolean().optional(),
    },
    async ({ jid, msgId, force }) => {
      const res = await ctx.client.send({ cmd: "transcribe", jid, msgId, force: force === true });
      if (!res.ok) return text(res.error);

      const r = res.result as { state: string; text?: string; error?: string };
      if (r.state === "done") {
        return text(r.text ? `(áudio, transcrito) ${r.text}` : "(áudio, sem fala reconhecida)");
      }
      if (r.state === "failed") return text(`A transcrição falhou: ${r.error}`);
      return text("Ainda transcrevendo. Leia a conversa de novo em alguns segundos.");
    },
  );

  server.tool(
    "download_image",
    "Baixa uma imagem de uma conversa, salva em ~/.whatsapp-mcp/media e devolve a imagem para você ver. " +
      "Use com o id que a leitura mostra em (imagem, id …); o id cortado serve.",
    { jid: z.string(), msgId: z.string() },
    async ({ jid, msgId }) => {
      const res = await ctx.client.send({ cmd: "download_image", jid, msgId });
      if (!res.ok) return text(`Imagem não baixada: ${res.error}`);

      const r = res.result as { path: string; mimetype: string; bytes: number };
      const saved = `Salva em ${r.path} (${Math.round(r.bytes / 1024)} KB).`;
      // Above this the client rejects the inline image anyway; the file on disk is still
      // the deliverable, so say where it is instead of failing the whole call.
      if (!INLINE_MIME.has(r.mimetype) || r.bytes > MAX_INLINE_BYTES) {
        return text(`${saved} Grande demais ou formato que não dá para mostrar aqui.`);
      }
      const data = (await readFile(r.path)).toString("base64");
      return {
        content: [
          { type: "image" as const, data, mimeType: r.mimetype },
          { type: "text" as const, text: saved },
        ],
      };
    },
  );
}

const INLINE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
