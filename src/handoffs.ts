import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
} from "node:fs";
import { z } from "zod";
import { CONFIG_DIR } from "./config.js";

export const HANDOFF_DIR = join(CONFIG_DIR, "handoffs");
export const HANDOFF_FAILED_DIR = join(HANDOFF_DIR, "failed");

const handoffSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().min(1),
});

export type HandoffRequest = z.infer<typeof handoffSchema>;

/** Encode an absolute cwd the way Claude Code names its project dir: "/" and "." → "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Return the session id of the most-recently-modified `.jsonl` in the Claude Code
 * project dir for `cwd` — i.e. the live session. Throws if the dir or any jsonl
 * is missing (nothing to hand off).
 */
export function findLatestSessionId(cwd: string, home = homedir()): string {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  if (!existsSync(dir)) {
    throw new Error(`No Claude project directory for ${cwd} (looked in ${dir}). Run a turn first.`);
  }
  const jsonl = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (jsonl.length === 0) {
    throw new Error(`No session files in ${dir}. Run a turn first.`);
  }
  return jsonl[0].f.replace(/\.jsonl$/, "");
}

/** Atomically write a handoff request; returns the file path. */
export function writeHandoff(req: HandoffRequest, dir = HANDOFF_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${req.sessionId}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(req, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

/** Read + validate a handoff file. Throws on malformed JSON or missing fields. */
export function readHandoff(path: string): HandoffRequest {
  return handoffSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Move a handoff file into the failed/ subdir (never silently drop a request). */
export function quarantineHandoff(path: string, now = Date.now()): void {
  mkdirSync(HANDOFF_FAILED_DIR, { recursive: true });
  renameSync(path, join(HANDOFF_FAILED_DIR, `${now}-${basename(path)}`));
}
