import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-mcp-"));
const { runHandoff, runDm } = await import("./mcp.js");
const { encodeProjectDir, readHandoff } = await import("./handoffs.js");
const { readNotification } = await import("./notifications.js");

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

test("runDm queues a notification file with the message and source label", () => {
  const res = runDm({ message: "build done", from: "rust-academy", now: "T", dir: handoffDir });
  expect(existsSync(res.path)).toBe(true);
  const req = readNotification(res.path);
  expect(req.message).toBe("build done");
  expect(req.from).toBe("rust-academy");
  expect(res.message).toContain("DM");
});

test("runDm drops a blank from label rather than storing it", () => {
  const res = runDm({ message: "hi", from: "   ", now: "T", dir: handoffDir });
  expect(readNotification(res.path).from).toBeUndefined();
});
