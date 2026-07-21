import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-no-"));
const {
  writeNotification,
  readNotification,
  quarantineNotification,
  formatDm,
  NOTIFY_FAILED_DIR,
  MAX_MESSAGE_LEN,
  MAX_FROM_LEN,
} = await import("./notifications.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-ndir-"));
});

test("writeNotification then readNotification round-trips", () => {
  const req = { message: "build done", from: "rust-academy", createdAt: "now" };
  const path = writeNotification(req, dir);
  expect(existsSync(path)).toBe(true);
  expect(readNotification(path)).toEqual(req);
});

test("writeNotification round-trips without a from label", () => {
  const req = { message: "just text", createdAt: "now" };
  const path = writeNotification(req, dir);
  expect(readNotification(path)).toEqual(req);
});

test("writeNotification produces unique filenames within the same millisecond", () => {
  const req = { message: "m", createdAt: "now" };
  const a = writeNotification(req, dir, 1000);
  const b = writeNotification(req, dir, 1000);
  expect(a).not.toBe(b);
  expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(2);
});

test("readNotification throws on malformed JSON", () => {
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  expect(() => readNotification(bad)).toThrow();
});

test("readNotification throws when message is missing", () => {
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "partial.json");
  writeFileSync(bad, JSON.stringify({ from: "x", createdAt: "now" }));
  expect(() => readNotification(bad)).toThrow();
});

test("readNotification throws when message exceeds the cap", () => {
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "big.json");
  writeFileSync(bad, JSON.stringify({ message: "x".repeat(MAX_MESSAGE_LEN + 1), createdAt: "now" }));
  expect(() => readNotification(bad)).toThrow();
});

test("readNotification throws when from exceeds the cap", () => {
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "bigfrom.json");
  writeFileSync(bad, JSON.stringify({ message: "ok", from: "x".repeat(MAX_FROM_LEN + 1), createdAt: "now" }));
  expect(() => readNotification(bad)).toThrow();
});

test("quarantineNotification moves malformed files into failed/", () => {
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  quarantineNotification(bad, 42);
  expect(existsSync(bad)).toBe(false);
  expect(existsSync(join(NOTIFY_FAILED_DIR, "42-bad.json"))).toBe(true);
});

test("formatDm prefixes with the source label when present", () => {
  expect(formatDm({ message: "hi", from: "cron", createdAt: "now" })).toBe("📨 cron: hi");
});

test("formatDm returns the plain message without a label", () => {
  expect(formatDm({ message: "hi", createdAt: "now" })).toBe("hi");
});
