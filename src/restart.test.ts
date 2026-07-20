import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-restart-"));
const {
  writeRestartMarker,
  readRestartMarker,
  clearRestartMarker,
  currentSha,
  runPreflight,
} = await import("./restart.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-restart-"));
  process.env.CLAUDECORD_HOME = home;
});

test("marker round-trips write -> read", () => {
  writeRestartMarker({ threadId: "t-1", sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
  expect(readRestartMarker()).toEqual({ threadId: "t-1", sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
});

test("read returns undefined when no marker exists", () => {
  expect(readRestartMarker()).toBeUndefined();
});

test("write leaves no .tmp file behind", () => {
  writeRestartMarker({ sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
  expect(readdirSync(home).some((f) => f.endsWith(".tmp"))).toBe(false);
});

test("clear removes the marker", () => {
  writeRestartMarker({ sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
  clearRestartMarker();
  expect(readRestartMarker()).toBeUndefined();
  clearRestartMarker(); // idempotent — no throw when already gone
});

test("runPreflight maps a zero exit to ok and captures output", () => {
  const res = runPreflight(home, ["bash", "-lc", "echo hello; exit 0"]);
  expect(res.ok).toBe(true);
  expect(res.output).toContain("hello");
});

test("runPreflight maps a non-zero exit to failure and captures output", () => {
  const res = runPreflight(home, ["bash", "-lc", "echo boom 1>&2; exit 1"]);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("boom");
});

test("currentSha returns 'unknown' outside a git repo", () => {
  expect(currentSha(home)).toBe("unknown");
});
