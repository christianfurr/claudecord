import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-reg-"));
const { Registry } = await import("./registry.js");

let reg: InstanceType<typeof Registry>;
beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-reg-"));
  reg = new Registry();
});

test("getByNum finds a session by its number", () => {
  const a = reg.create("t-a", "alpha");
  const b = reg.create("t-b", "beta");
  expect(reg.getByNum(a.sessionNum)?.threadId).toBe("t-a");
  expect(reg.getByNum(b.sessionNum)?.threadId).toBe("t-b");
  expect(reg.getByNum(999)).toBeUndefined();
});

test("update stores a per-session cwd", () => {
  reg.create("t-a", "alpha");
  const updated = reg.update("t-a", { cwd: "/Users/me/proj" });
  expect(updated.cwd).toBe("/Users/me/proj");
  expect(reg.get("t-a")?.cwd).toBe("/Users/me/proj");
});

test("remove deletes a record and reports whether it existed", () => {
  reg.create("t-a", "alpha");
  expect(reg.remove("t-a")).toBe(true);
  expect(reg.get("t-a")).toBeUndefined();
  expect(reg.remove("t-a")).toBe(false);
});
