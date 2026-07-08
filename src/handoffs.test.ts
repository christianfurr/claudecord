import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-ho-"));
const {
  encodeProjectDir,
  findLatestSessionId,
  writeHandoff,
  readHandoff,
} = await import("./handoffs.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-home-"));
});

test("encodeProjectDir replaces slashes and dots with dashes", () => {
  expect(encodeProjectDir("/Users/me/Code/proj")).toBe("-Users-me-Code-proj");
  expect(encodeProjectDir("/Users/me/.config/x")).toBe("-Users-me--config-x");
});

test("findLatestSessionId returns the newest jsonl's id", () => {
  const cwd = "/Users/me/proj";
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "{}");
  writeFileSync(join(dir, "new.jsonl"), "{}");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "old.jsonl"), past, past);
  expect(findLatestSessionId(cwd, home)).toBe("new");
});

test("findLatestSessionId throws when the project dir is absent", () => {
  expect(() => findLatestSessionId("/nope/missing", home)).toThrow();
});

test("findLatestSessionId throws when there are no jsonl files", () => {
  const cwd = "/Users/me/empty";
  mkdirSync(join(home, ".claude", "projects", encodeProjectDir(cwd)), { recursive: true });
  expect(() => findLatestSessionId(cwd, home)).toThrow();
});

test("writeHandoff then readHandoff round-trips", () => {
  const dir = join(home, "handoffs");
  const req = { sessionId: "s1", cwd: "/x", title: "t", createdAt: "now" };
  const path = writeHandoff(req, dir);
  expect(existsSync(path)).toBe(true);
  expect(readHandoff(path)).toEqual(req);
});

test("readHandoff throws on malformed JSON", () => {
  const dir = join(home, "handoffs");
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  expect(() => readHandoff(bad)).toThrow();
});

test("readHandoff throws when a required field is missing", () => {
  const dir = join(home, "handoffs");
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "partial.json");
  writeFileSync(bad, JSON.stringify({ sessionId: "s1" }));
  expect(() => readHandoff(bad)).toThrow();
});
