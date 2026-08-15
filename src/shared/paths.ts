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
