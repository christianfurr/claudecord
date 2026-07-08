import { test, expect } from "bun:test";
import { buildQueryOptions } from "./session.js";
import type { SessionRecord } from "./registry.js";
import type { Settings } from "./config.js";

const settings = {
  workDir: "/default/work",
  terminal: "Ghostty",
  allowlist: [],
} as Settings;

function record(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    threadId: "t1",
    sessionNum: 1,
    title: "demo",
    status: "active",
    createdAt: "now",
    updatedAt: "now",
    ...patch,
  };
}

test("cwd falls back to settings.workDir", () => {
  const opts = buildQueryOptions(record(), settings);
  expect(opts.cwd).toBe("/default/work");
});

test("record.cwd overrides settings.workDir", () => {
  const opts = buildQueryOptions(record({ cwd: "/Users/me/proj" }), settings);
  expect(opts.cwd).toBe("/Users/me/proj");
});

test("no resume fields when resumeSessionId is absent", () => {
  const opts = buildQueryOptions(record(), settings) as Record<string, unknown>;
  expect(opts.resume).toBeUndefined();
  expect(opts.forkSession).toBeUndefined();
});

test("resume + forkSession are set when handing off", () => {
  const opts = buildQueryOptions(record(), settings, "sess-123", true) as Record<string, unknown>;
  expect(opts.resume).toBe("sess-123");
  expect(opts.forkSession).toBe(true);
});
