import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface RestartMarker {
  threadId?: string;
  sha: string;
  requestedAt: string;
}

export interface RestartResult {
  ok: boolean;
  sha: string;
  error?: string;
}

export interface RestartOptions {
  threadId?: string;
  /** Skip the typecheck gate (CLI --force). */
  skipPreflight?: boolean;
  /** Delay before process.exit so replies/tool results flush first. */
  exitDelayMs?: number;
}

function markerFile(): string {
  return join(process.env.CLAUDECORD_HOME ?? CONFIG_DIR, "restart.json");
}

export function writeRestartMarker(marker: RestartMarker): void {
  const file = markerFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, file);
}

export function readRestartMarker(): RestartMarker | undefined {
  const file = markerFile();
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RestartMarker;
  } catch {
    return undefined; // partial write in flight — treat as absent
  }
}

export function clearRestartMarker(): void {
  const file = markerFile();
  if (existsSync(file)) unlinkSync(file);
}

/** Short git SHA of the repo, best-effort — "unknown" if git is unavailable. */
export function currentSha(repoRoot: string): string {
  const res = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  const sha = res.stdout?.trim();
  return res.status === 0 && sha ? sha : "unknown";
}

/**
 * Preflight gate before a restart: run the typecheck and report pass/fail with
 * combined output. Deliberately blocking (spawnSync) — a restart is disruptive
 * anyway, but this also freezes the daemon's event loop for every other session
 * for the duration. Callers assume the typecheck completes in well under a
 * second: the CLI's control-socket response has a 5s budget, so a slower
 * typecheck would both stall concurrent sessions and risk a CLI timeout.
 * `cmd` is injectable for tests.
 */
export function runPreflight(
  repoRoot: string,
  cmd: string[] = ["bun", "run", "typecheck"],
): { ok: boolean; output: string } {
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd: repoRoot, encoding: "utf8" });
  const output = ((res.stdout ?? "") + (res.stderr ?? "")).trim();
  return { ok: res.status === 0, output };
}
