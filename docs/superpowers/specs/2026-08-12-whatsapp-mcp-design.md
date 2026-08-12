# whatsapp-mcp — design

Data: 2026-08-12
Status: aguardando revisão do autor
Escopo deste spec: **apenas o servidor MCP (projeto A).** O bridge inbound (WhatsApp como
controle remoto do Claude) é um projeto separado, com spec próprio, depois deste rodar.

## Problema

Dar ao Claude acesso ao WhatsApp pessoal do autor, para quatro tarefas:

1. Resumir o que aconteceu num chat ou grupo
2. Buscar no histórico ("onde me mandaram aquele link?")
3. Redigir e enviar uma mensagem
4. Triar o que falta responder

Uso pessoal, máquina local (macOS). Um único número, o do autor.

## Restrição que define a arquitetura

Histórico do WhatsApp não é acessível sob demanda. Pelo Baileys:

- O histórico chega **uma vez**, no sync da conexão, pelo evento `messaging-history.set`,
  em lotes, e só com `syncFullHistory: true`
- Para ir além, `fetchMessageHistory` pagina no máximo 50 mensagens por chamada, e exige
  como cursor a mensagem **mais antiga que já se tem** — sem histórico local, não há de
  onde paginar
- Uma credencial só suporta uma conexão ativa; abrir outra derruba a anterior

Consequência: um servidor MCP que conecta ao WhatsApp sob demanda não atende nenhum dos
quatro casos de uso. Mensagem recebida com o processo fechado não existe, a primeira
chamada bloqueia no sync inteiro, e duas sessões de Claude brigam pela credencial.

O sistema precisa de um processo persistente que acumule histórico independentemente do
Claude estar aberto.

## Arquitetura

Dois processos, separados por **quem escreve**.

```
  ┌──────────────────────┐         ┌─────────────────────────┐
  │  whatsapp-daemon     │         │  whatsapp-mcp (stdio)   │
  │  (launchd, sempre)   │         │  (nasce e morre com     │
  │                      │         │   a sessão do Claude)   │
  │  · socket Baileys    │         │                         │
  │  · ingest de eventos │         │  · 8 tools              │
  │  · backfill          │         │  · zero estado próprio  │
  │  · dono dos drafts   │         │                         │
  └────┬────────────┬────┘         └───┬──────────────┬──────┘
       │ escreve    │ envia            │ lê           │ pede
       ▼            ▼                  ▼              │
   store.db      WhatsApp          store.db           │
   (rw, WAL)                       (read-only) ◄──────┘
       ▲                                               │
       └────────────── control.sock ◄──────────────────┘
```

- O **daemon** é o único que escreve — no banco e no WhatsApp
- O **MCP** abre o mesmo SQLite em modo somente leitura (WAL suporta múltiplos leitores
  concorrentes com um escritor) e usa o unix socket só para operações de escrita
- Os dois compartilham `src/shared/` (schema, migrations, tipos, helpers de jid). Nenhum
  importa o outro

Alternativas descartadas:

- **MCP monolítico (um processo):** inviável pelas três consequências da seção anterior
- **Daemon + HTTP local:** mesma topologia, mas paga uma camada de rede para ler dados que
  já estão num arquivo local. O único acesso que precisa de mediação é o envio

## Estrutura

```
whatsapp-mcp/
  src/
    daemon/
      index.ts       bootstrap, launchd, sinais
      socket.ts      conexão Baileys, QR, reconexão
      ingest.ts      eventos → banco, idempotente
      backfill.ts    fetchMessageHistory paginado
      drafts.ts      criação e guarda dos rascunhos
      control.ts     unix socket, protocolo JSONL
    mcp/
      index.ts       servidor MCP stdio
      tools/         uma tool por arquivo
      db.ts          conexão read-only
    shared/
      schema.sql  migrations.ts  jid.ts  types.ts
  tests/
```

Estado em `~/.whatsapp-mcp/` (dir `700`):

| caminho | conteúdo | permissão |
|---|---|---|
| `auth/` | credenciais Baileys (`useMultiFileAuthState`) | `700` |
| `store.db` | mensagens, chats, contatos | `600` |
| `control.sock` | unix socket do daemon | `600` |
| `config.json` | preferências | `600` |

O banco contém o WhatsApp inteiro em texto claro. As permissões acima são requisito, não
detalhe de implementação, e o README diz isso explicitamente. Criptografia em repouso está
fora do escopo: a chave teria que viver na mesma máquina, o que não muda o modelo de
ameaça para uso pessoal.

## Dados

| tabela | conteúdo |
|---|---|
| `chats` | `jid` PK, nome, `is_group`, `last_message_at`, `unread_count`, `archived` |
| `contacts` | `jid` PK, nome, `push_name` |
| `messages` | PK `(chat_jid, msg_id)`, `sender_jid`, `from_me`, `timestamp`, `type`, `text`, `quoted_id` |
| `messages_fts` | FTS5 externo sobre `messages.text` |
| `sync_state` | por chat: `oldest_msg_id`, `oldest_ts`, `complete` |
| `meta` | `schema_version`, `initial_sync_done`, `last_connected_at` |

FTS5 com `tokenize = "unicode61 remove_diacritics 2"`. Sem isso, busca por "reuniao" não
encontra "reunião" — o caso comum, não a exceção.

Mídia fora do MVP: imagem, áudio e documento entram com `type`, legenda e nome do arquivo,
sem baixar o binário. Resumo, busca e triagem funcionam sem isso. Download vira uma tool
depois, se fizer falta.

## Fluxo

1. Daemon sobe, lê `auth/`. Sem credenciais, imprime o QR no terminal para pareamento
2. Conecta com `syncFullHistory: true`; `messaging-history.set` chega em lotes e é gravado
   em transação. `meta.initial_sync_done` só vira verdadeiro no lote com `isLatest`
3. `messages.upsert` ao vivo usa o mesmo caminho de ingest. Idempotente pela PK, então
   reprocessar não duplica
4. `backfill_chat` faz o daemon paginar `fetchMessageHistory` de 50 em 50, atualizando
   `sync_state` a cada página
5. Envio, em dois passos, descrito abaixo

## Envio: por que dois passos e por que o rascunho mora no daemon

Enviar mensagem é irreversível e sai sob o nome do autor. Duas ameaças distintas:

- **Erro do modelo:** texto errado, ou certo para o contato errado
- **Injeção via conteúdo lido:** todas as mensagens lidas foram escritas por terceiros e
  entram no contexto do Claude. Uma delas pode instruir o modelo a enviar algo

O desenho ingênuo — rascunho na memória do MCP, `confirm` mandando o texto pelo socket —
não resolve nenhuma das duas: o daemon aceitaria qualquer texto que chegasse ao socket, e
a confirmação seria apenas uma convenção do processo que já pode estar comprometido.

Portanto:

- `draft_message(jid, text)` cria o rascunho **no daemon**, que o guarda e devolve
  `draft_id` mais o texto exato e o nome resolvido do destinatário
- `confirm_send(draft_id)` **não aceita texto algum**. O daemon envia o que ele guardou

O modelo nunca controla o conteúdo e a confirmação ao mesmo tempo. O pior caso de uma
injeção bem-sucedida é um rascunho estranho, visível, que o autor lê antes de confirmar.
Rascunho expira em 10 minutos e não sobrevive a reinício do daemon — falha fechada.

## Tools

| tool | tipo | notas |
|---|---|---|
| `list_chats` | leitura | ordenado por atividade, filtro de não-lidas. É a triagem |
| `read_messages` | leitura | por chat, com intervalo de tempo ou limite |
| `search_messages` | leitura | FTS, filtrável por chat e período |
| `get_contact` | leitura | resolve nome ↔ jid |
| `whatsapp_status` | leitura | conexão, progresso do sync, contagens |
| `backfill_chat` | escrita | pede histórico mais antigo ao daemon |
| `draft_message` | escrita | cria rascunho no daemon; **não envia** |
| `confirm_send` | escrita | envia; aceita apenas `draft_id` |

Toda tool de leitura inclui no resultado o estado do sync quando ele está incompleto.
Sem isso, uma busca durante o sync inicial devolve pouco e é indistinguível de bug.

## Erros

Regra geral: falhar alto e dizer o que fazer. Nunca devolver vazio silencioso.

| situação | resposta |
|---|---|
| daemon fora do ar | erro com o comando exato para subir |
| sync incompleto | resultado normal + aviso de que o histórico está parcial |
| rascunho vencido ou inexistente | erro pedindo para redigir de novo |
| jid inexistente | falha na validação, antes de tocar no WhatsApp |
| desconexão do WhatsApp | daemon reconecta com backoff; tools reportam desconectado |
| credencial inválida | daemon pede novo pareamento por QR |

## Testes

Vitest, como no `safe-postgres-mcp`.

1. **Ingest idempotente** — o mesmo lote de `messaging-history.set` aplicado duas vezes
   produz o mesmo estado
2. **Busca com acento e caixa** — "reuniao" encontra "Reunião"
3. **Não existe envio sem rascunho válido** — nenhum caminho do socket de controle envia
   com texto vindo de fora; `confirm_send` com id inválido, vencido ou de outro rascunho
   falha. É o teste que justifica a arquitetura de envio
4. **Migrations** — banco vazio e banco de versão anterior chegam ao mesmo schema
5. **Sync parcial é reportado** — leitura com `initial_sync_done` falso traz o aviso

Sem teste end-to-end contra o WhatsApp real: exigiria um número pareado e tráfego real.
A camada Baileys é isolada atrás de `socket.ts` e substituída por fixtures.

## Riscos

**Banimento do número.** Baileys é cliente não-oficial e a automação contraria os Termos
do WhatsApp. Mitigações no desenho: nenhum envio em massa, nenhuma resposta automática, o
envio sempre passa por confirmação humana. Recomendação operacional: usar número
secundário se o principal for crítico — o do autor está em uso ativo na busca de vaga.

**Nome no npm.** `whatsapp-mcp`, `safe-whatsapp-mcp` e `whatsapp-mcp-server` já estão
publicados por terceiros. Se houver publicação, usar escopo: `@samuel-cabral/whatsapp-mcp`
(livre em 12/08/2026). Nome local do projeto permanece `whatsapp-mcp`.

**Volume do sync inicial.** Uma conta com anos de histórico pode gerar um banco grande e um
sync demorado. Nenhum limite artificial no MVP; se doer, entra corte por data em `config.json`.

## Fora de escopo

Mídia baixada, multi-conta, envio em massa, resposta automática, bridge inbound,
criptografia em repouso, qualquer coisa multi-tenant.

Migração futura para a Cloud API oficial da Meta permanece possível porque a superfície de
WhatsApp está inteira em `daemon/socket.ts` — as tools e o schema não sabem qual transporte
está embaixo. Isso não é um requisito do MVP, apenas uma fronteira que não custa manter.
