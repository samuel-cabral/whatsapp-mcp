import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, chmodSync, rmSync } from "node:fs";

export interface Paths {
  root: string;
  authDir: string;
  dbFile: string;
  socketFile: string;
  configFile: string;
  tmpDir: string;
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
    tmpDir: join(root, "tmp"),
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

/**
 * Empties the scratch directory and recreates it owner-only.
 *
 * Transcription decodes a voice note to plaintext WAV before feeding it to whisper,
 * and the transcriber deletes that in a finally block. This sweep is the other half:
 * a SIGKILL — which is what `launchctl kickstart -k` sends — never runs a finally, so
 * without a sweep on boot the decoded audio of somebody's conversation would sit on
 * disk indefinitely. os.tmpdir() is deliberately not used: only in a directory that
 * is ours is "anything in here is crash debris, delete it" a true statement.
 */
export function sweepTmp(paths: Paths): void {
  rmSync(paths.tmpDir, { recursive: true, force: true });
  mkdirSync(paths.tmpDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.tmpDir, 0o700);
}
