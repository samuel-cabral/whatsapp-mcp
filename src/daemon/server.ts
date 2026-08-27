import { connect, createServer, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { handleCommand, type ControlDeps } from "./control.js";

/** How long to wait for an existing socket to prove it still has an owner. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * A socket file left over from a crash has to go, but a LIVE one means another
 * daemon already owns this auth directory, and unlinking it is exactly how two
 * daemons came to share one Signal ratchet on 25/08: the second login evicted the
 * first (13 `connectionReplaced` disconnects), both kept writing to the same
 * ~/.whatsapp-mcp/auth, and every peer's session desynced.
 *
 * Connecting is the only honest liveness test — a unix socket file outlives the
 * process that made it, so its existence proves nothing on its own.
 */
export async function claimSocketFile(socketFile: string): Promise<void> {
  if (!existsSync(socketFile)) return;

  const ownerAlive = await new Promise<boolean>((resolve) => {
    const probe = connect(socketFile);
    const settle = (v: boolean): void => {
      probe.destroy();
      resolve(v);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false)); // ECONNREFUSED = nobody listening
    setTimeout(() => settle(false), PROBE_TIMEOUT_MS).unref();
  });

  if (ownerAlive) {
    throw new Error(
      `outro daemon já está escutando em ${socketFile}. Dois daemons no mesmo ` +
        `~/.whatsapp-mcp/auth corrompem as sessões Signal e derrubam o recebimento. ` +
        `Pare o outro primeiro: launchctl bootout gui/$(id -u)/com.samuelcabral.whatsapp-daemon`,
    );
  }

  unlinkSync(socketFile);
}

/**
 * One JSON object per line, in and out. A unix socket with 0600 means the OS
 * does the authentication: no other user on the machine can send commands.
 */
export async function startControlServer(opts: {
  socketFile: string;
  deps: ControlDeps;
}): Promise<{ close(): Promise<void> }> {
  await claimSocketFile(opts.socketFile);

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
