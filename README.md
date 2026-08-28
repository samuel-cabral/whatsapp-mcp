# whatsapp-mcp

MCP server for your **personal WhatsApp**: Claude reads your history, searches it,
triages unread chats — and sends messages only through an explicit two-step
confirmation.

Two processes, split by who writes:

- **`whatsapp-daemon`** — keeps the WhatsApp connection (via
  [Baileys](https://github.com/WhiskeySockets/Baileys)), stores every message in a
  local SQLite database, and is the *only* process that writes — to the database
  and to WhatsApp. It also owns message drafts.
- **`whatsapp-mcp`** — the MCP server Claude talks to. Opens the same database
  **read-only** and asks the daemon over a unix socket when it needs to send.

## ⚠️ Read this before using

- **Unofficial client.** Baileys speaks the WhatsApp Web protocol without Meta's
  blessing. Automating a personal account is against WhatsApp's Terms of Service
  and can get the number **banned**. This project mitigates (no bulk send, no
  auto-reply, human-paced backfill, human-confirmed sends) but cannot eliminate
  that risk. Consider a secondary number if yours is critical.
- **Your entire WhatsApp ends up in plain text** in `~/.whatsapp-mcp/store.db`.
  `~/.whatsapp-mcp` is created `700` and that directory bit is what actually keeps
  other users out; inside it only `store.db` and the control socket are `600`, the
  Baileys credential files are not. Keep the directory `700`. Anyone who gets past
  it has your entire message history and your session credentials.

## Setup

```bash
npm install
npm run build

# 1. Start the daemon; a QR code appears on first run — scan it with
#    WhatsApp on your phone (Settings → Linked devices).
node build/daemon/index.js

# 2. Wait for the initial history sync (watch the "history: +N" log lines;
#    they carry a percentage, and "(sync inicial completo)" marks the end).

# 3. Check it from another terminal:
printf '{"cmd":"status"}\n' | nc -U ~/.whatsapp-mcp/control.sock
```

### Register with Claude Code

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/whatsapp-mcp/build/mcp/index.js"]
    }
  }
}
```

### Run the daemon at login (macOS)

Edit `launchd/com.samuelcabral.whatsapp-daemon.plist` (node path — check
`which node` — and project path), then:

```bash
cp launchd/com.samuelcabral.whatsapp-daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.samuelcabral.whatsapp-daemon.plist
```

## Tools

| tool | kind | what it does |
|---|---|---|
| `list_chats` | read | chats by recent activity; `onlyUnread` for triage |
| `read_messages` | read | messages of one chat, by time window or limit |
| `search_messages` | read | full-text search, accent-insensitive |
| `get_contact` | read | resolve a name or number to a jid |
| `whatsapp_status` | read | whether messages are still arriving, plus connection and sync |
| `backfill_chat` | write | pull older history, 50 messages a page |
| `draft_message` | write | prepare a message — **does not send** |
| `confirm_send` | write | send a prepared draft — takes only a `draftId` |

## The two-step send

There is no tool that sends a message directly, and that is the point.

`draft_message` stores the draft **inside the daemon** and returns the exact text
plus a `draftId`. `confirm_send` accepts **only the id** — no text parameter
exists — so the daemon sends what it stored, never what the caller says at
confirmation time. That is the guarantee, and it is narrower than "nothing can be
sent without you": the approval step itself lives in your MCP client's UI, not in
this repo, so a client that auto-approves tool calls will chain `draft_message`
into `confirm_send` with no human in between. What this repo guarantees is that
the text sent is the text it stored, and that a prompt injection cannot smuggle a
different recipient or body into the confirmation. Drafts expire after 10 minutes
and die with the daemon: it fails closed.

## Development

```bash
npm test          # vitest, everything runs against in-memory SQLite
npm run typecheck
```

No test touches real WhatsApp. The Baileys surface is confined to
`src/daemon/socket.ts` behind a narrow `Sender` interface, which is also what
would make a future migration to the official Cloud API a one-file change.

## License

MIT
