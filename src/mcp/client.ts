import { connect } from "node:net";
import type { ControlCommand, ControlResponse } from "../shared/types.js";

/** Thin JSONL client for the daemon's control socket. One command per connection. */
export class ControlClient {
  constructor(private readonly socketFile: string) {}

  send(cmd: ControlCommand): Promise<ControlResponse> {
    return new Promise((resolve) => {
      const sock = connect(this.socketFile);
      let buf = "";
      let settled = false;
      const done = (r: ControlResponse) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(r);
      };

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
          error: "daemon fora do ar. Suba com: node build/daemon/index.js (ou carregue o serviço do launchd).",
        }));
    });
  }
}
