# whatsapp-mcp

[![CI](https://github.com/samuel-cabral/whatsapp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/samuel-cabral/whatsapp-mcp/actions/workflows/ci.yml)

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

> **Runtime output is in Brazilian Portuguese.** Log lines, error messages, MCP
> tool descriptions and the `whatsapp_status` output are all pt-BR. Only this
> README is in English.

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

## Requirements

- **Node 22 or newer.** That is what `engines` declares and what CI runs; older versions are
  untested. (npm only warns about `engines`, so a wrong version fails later, not at install.)
- **A build toolchain**, if npm has no prebuilt binary for your platform:
  `better-sqlite3` falls back to compiling, which needs python3 and a C++ compiler.
- **`nc` with `-U`** (unix socket support), for the status check in step 3. Debian and
  Ubuntu need `netcat-openbsd`, Fedora and RHEL need `nmap-ncat`. If you would rather not
  install it, skip step 3 — once the MCP client is registered, the `whatsapp_status` tool
  answers the same question.
- **macOS or Linux.** Developed on macOS; the launchd section is macOS only.
- **Your phone**, to scan the pairing QR code.

### Optional: voice note transcription

Voice notes are transcribed locally, by whisper.cpp. Nothing is uploaded and no API key is
involved. This is optional in the real sense: without it the daemon runs exactly as before
and voice notes keep showing up as `(audio)`. Nothing else changes, and nothing fails.

```bash
brew install whisper-cpp ffmpeg
```

Then fetch a model (about 547 MB) into `~/.cache/whisper-models/`:

```bash
mkdir -p ~/.cache/whisper-models && curl -L -o ~/.cache/whisper-models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

The daemon checks all three at boot, says so in its log, and reports the answer through
`whatsapp_status`. Paths and language come from `~/.whatsapp-mcp/config.json`, which is
optional — these are the defaults:

```json
{
  "whisperBin": "/opt/homebrew/bin/whisper-cli",
  "ffmpegBin": "/opt/homebrew/bin/ffmpeg",
  "whisperModel": "/Users/you/.cache/whisper-models/ggml-large-v3-turbo-q5_0.bin",
  "whisperLanguage": "pt"
}
```

The paths must be absolute. launchd hands the daemon a `PATH` of
`/usr/bin:/bin:/usr/sbin:/sbin`, so a bare `whisper-cli` resolves in a terminal and fails
every time as a service.

`whisperLanguage` is `pt` rather than `auto` on measurement, not taste: a clearly Brazilian
clip was auto-detected as English at p=0.91 and came back as nonsense, while an English
clip transcribed identically under `-l pt`. Set it to your own language, or to `auto` if
your inbox is genuinely mixed.

Transcription is a guess, and it is labelled as one everywhere it appears: a transcribed
note reads `(áudio, transcrito) …`, and any response containing one carries a one-line
reminder not to act on a name, a number or an amount without checking.

## Setup

```bash
npm install
npm run build

# 1. Start the daemon. On first run a QR code is printed — scan it with
#    WhatsApp on your phone (Settings → Linked devices → Link a device).
#    If the QR expires, a new one is printed automatically.
node build/daemon/index.js

# 2. Wait for the initial history sync. Watch the "history: +N mensagens NN%"
#    lines; "(sync inicial completo)" marks the end. Expect tens of minutes to a
#    few hours depending on how much history your account has.

# 3. Check it from another terminal:
printf '{"cmd":"status"}\n' | nc -U ~/.whatsapp-mcp/control.sock
```

Leave the daemon running. Stop it with Ctrl+C; nothing is lost, it resumes on the
next start.

### Register with your MCP client

**Use an absolute path to `node`, and make sure it is a stable one.** MCP clients start
with a minimal `PATH`, so a bare `"node"` fails for anyone using nvm, fnm or asdf. But
`which node` is not the answer either: under fnm it returns a per-shell path like
`~/.local/state/fnm_multishells/<pid>_<timestamp>/bin/node`, which stops existing when
that shell does. Get the real one with:

```bash
node -e 'console.log(process.execPath)'
```

That prints the version's install directory (for fnm,
`~/.local/share/fnm/node-versions/vNN/installation/bin/node`). Update it when you upgrade
Node.

**Claude Code** — one command, no file to edit:

```bash
claude mcp add whatsapp -- /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/whatsapp-mcp/build/mcp/index.js
```

**Claude Desktop** — edit
`~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/whatsapp-mcp/build/mcp/index.js"]
    }
  }
}
```

The MCP server reads the database directly, so the read tools work even with the daemon
stopped — they just stop seeing new messages. Sending needs the daemon up.

### Run the daemon at login (macOS)

**Stop the daemon you started by hand first.** The plist sets `KeepAlive`, and the
daemon refuses to start when another one already owns the socket — so leaving both
around gives you a process that crashes and relaunches every ten seconds, forever.

Edit `launchd/com.samuelcabral.whatsapp-daemon.plist` and replace every
`/ABSOLUTE/PATH/TO/...` (node path from the `process.execPath` command above, project
path, and your home directory for the log). Getting the node path wrong here is worse
than in the MCP config: `KeepAlive` is on, so launchd will relaunch forever against a
binary that no longer exists. Then:

```bash
cp launchd/com.samuelcabral.whatsapp-daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.samuelcabral.whatsapp-daemon.plist
```

To stop it, and to watch it:

```bash
launchctl bootout gui/$(id -u)/com.samuelcabral.whatsapp-daemon
tail -f ~/.whatsapp-mcp/daemon.log
```

**Under launchd the QR code goes to the log file, not to your terminal.** If you
ever need to pair again, `tail -f` the log to see it. Nothing rotates that log, so
prune it yourself if it grows.

## Using it

Once the daemon is synced and the MCP server is registered, you talk to your own
history in plain language:

- *"o que rolou no grupo do trabalho hoje?"*
- *"o que eu ainda não respondi?"* — triage over unread chats
- *"acha a mensagem em que a Ana mandou o link do apartamento"*
- *"resume a conversa com o Pedro dessa semana"*
- *"manda pra Ana: chego 19h"* — this comes back as a **draft**, not a sent message.
  You read the exact text, then approve it in a second turn.

Read results carry a banner when the store cannot be trusted: still syncing, or no
longer receiving. It is deliberate — "nothing found" and "we stopped receiving" look
identical from the outside and lead to opposite conclusions.

## Tools

| tool | kind | what it does |
|---|---|---|
| `list_chats` | read | chats by recent activity; `onlyUnread` for triage |
| `read_messages` | read | messages of one chat, by time window or limit |
| `search_messages` | read | full-text search, accent-insensitive |
| `get_contact` | read | resolve a name or number to a jid |
| `whatsapp_status` | read | whether messages are still arriving, plus connection and sync |
| `transcribe_audio` | write | transcribe one voice note by hand, or reprocess it |
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

## Knowing when it stopped receiving

This daemon once went 47 hours without receiving a single message while its status
still answered "connected: yes". Monitoring the connection is not monitoring the
service, so it now measures the thing that actually matters.

`whatsapp_status` leads with `recebendo:` (receiving), and calls it broken when:

- **6 hours of daytime silence** (07:00–23:00 local; a threshold loose enough to
  survive a night is too loose to catch a workday). 3 hours marks it suspicious.
- **20 undecryptable messages in an hour with zero decrypted** — traffic arriving
  and nothing readable is a break, not a quiet afternoon, and this catches it in
  about forty minutes instead of six hours.
- **the event buffer stuck for more than a minute**, which is the exact shape of
  the outage above.

It also tries to heal itself: it drains a stuck event buffer, renegotiates broken
Signal sessions in small batches, and tops up pre-keys when the server pool runs
low. Those are in `src/daemon/socket.ts`, each with the measurement that motivated it.

## When something breaks

| symptom | what to do |
|---|---|
| `outro daemon já está escutando...` | Another daemon owns the socket. Stop it: `launchctl bootout gui/$(id -u)/com.samuelcabral.whatsapp-daemon`, or kill the one you started by hand. |
| `recebendo: NÃO` in the status | The daemon retries on its own. If it persists, restart the daemon and watch the log. If messages still do not arrive, the Signal session is broken: delete `~/.whatsapp-mcp/auth` and pair again. |
| `sessão encerrada no celular` | You unlinked the device from your phone. Delete `~/.whatsapp-mcp/auth` and pair again. |
| MCP client says the daemon is down | Start it, and check you used an absolute path to `node` when registering. |
| Want to start over | Delete `~/.whatsapp-mcp/auth` to re-pair — that is safe. **Deleting `store.db` is not reversible:** full history arrives once, at first sync, and `backfill_chat` only pages back 50 messages at a time. |

## Development

```bash
npm test          # vitest; every test database is in-memory, and none touch WhatsApp
npm run typecheck
```

No test touches real WhatsApp. Baileys is imported in exactly one file,
`src/daemon/socket.ts`, behind a narrow `Sender` interface.

The design document is in [`docs/design.md`](docs/design.md) (pt-BR).

## License

MIT
