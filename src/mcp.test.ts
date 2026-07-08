import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-mcp-"));
const { runHandoff } = await import("./mcp.js");
const { encodeProjectDir, readHandoff } = await import("./handoffs.js");

let home: string;
let handoffDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-home-"));
  handoffDir = mkdtempSync(join(tmpdir(), "cc-hdir-"));
});

function seedSession(cwd: string): void {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "abc-123.jsonl"), "{}");
}

test("runHandoff writes a handoff file for the live session", () => {
  const cwd = "/Users/me/proj";
  seedSession(cwd);
  const res = runHandoff({ cwd, title: "my task", home, now: "T", dir: handoffDir });
  expect(existsSync(res.path)).toBe(true);
  const req = readHandoff(res.path);
  expect(req.sessionId).toBe("abc-123");
  expect(req.cwd).toBe(cwd);
  expect(req.title).toBe("my task");
  expect(res.message).toContain("Discord");
});

test("runHandoff derives a title from the cwd basename when none given", () => {
  const cwd = "/Users/me/proj";
  seedSession(cwd);
  const res = runHandoff({ cwd, home, now: "T", dir: handoffDir });
  expect(readHandoff(res.path).title).toBe("proj (handoff)");
});

test("runHandoff throws when there is no session to hand off", () => {
  expect(() => runHandoff({ cwd: "/nope", home, now: "T", dir: handoffDir })).toThrow();
});
