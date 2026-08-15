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
