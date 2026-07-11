import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-rem-"));
const { ReminderStore } = await import("./reminders.js");

let store: InstanceType<typeof ReminderStore>;
beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-rem-"));
  store = new ReminderStore();
});

function input(over: Partial<Parameters<InstanceType<typeof ReminderStore>["add"]>[0]> = {}) {
  return {
    threadId: "t-1",
    kind: "nudge" as const,
    text: "test the deploy",
    fireAt: "2026-07-12T09:00:00+06:00",
    tz: "Asia/Dhaka",
    ...over,
  };
}

test("add assigns a monotonic id and persists the schedule shape", () => {
  const a = store.add(input());
  const b = store.add(input());
  expect(a.id).toBe("r1");
  expect(b.id).toBe("r2");
  expect(a.schedule).toEqual({ type: "once", fireAt: "2026-07-12T09:00:00+06:00", tz: "Asia/Dhaka" });
  expect(a.createdAt).toBeString();
});

test("add persists across store instances (atomic write)", () => {
  store.add(input({ text: "persisted" }));
  const reopened = new ReminderStore();
  expect(reopened.all()).toHaveLength(1);
  expect(reopened.all()[0]!.text).toBe("persisted");
});

test("optional fields are only stored when provided", () => {
  const bare = store.add(input());
  expect(bare.sdkSessionId).toBeUndefined();
  expect(bare.cwd).toBeUndefined();
  const full = store.add(input({ sdkSessionId: "sess-9", cwd: "/Users/me/proj" }));
  expect(full.sdkSessionId).toBe("sess-9");
  expect(full.cwd).toBe("/Users/me/proj");
});

test("all returns pending reminders soonest-first", () => {
  store.add(input({ fireAt: "2026-07-12T12:00:00+06:00" }));
  store.add(input({ fireAt: "2026-07-12T08:00:00+06:00" }));
  const ids = store.all().map((r) => r.schedule.fireAt);
  expect(ids).toEqual(["2026-07-12T08:00:00+06:00", "2026-07-12T12:00:00+06:00"]);
});

test("due fires at exactly-now and past, not future", () => {
  const at = "2026-07-12T09:00:00+00:00";
  const r = store.add(input({ fireAt: at }));
  const justBefore = new Date(new Date(at).getTime() - 1);
  const exactly = new Date(at);
  const later = new Date(new Date(at).getTime() + 60_000);
  expect(store.due(justBefore)).toHaveLength(0);
  expect(store.due(exactly).map((x) => x.id)).toEqual([r.id]);
  expect(store.due(later).map((x) => x.id)).toEqual([r.id]);
});

test("markFired removes a reminder from due and all", () => {
  const at = "2026-07-12T09:00:00+00:00";
  const r = store.add(input({ fireAt: at }));
  store.markFired(r.id, new Date(at));
  expect(store.due(new Date(at))).toHaveLength(0);
  expect(store.all()).toHaveLength(0);
  expect(store.get(r.id)?.firedAt).toBeString();
});

test("remove reports whether the id existed", () => {
  const r = store.add(input());
  expect(store.remove(r.id)).toBe(true);
  expect(store.get(r.id)).toBeUndefined();
  expect(store.remove(r.id)).toBe(false);
  expect(store.remove("nope")).toBe(false);
});

test("prune drops fired reminders older than the cutoff, keeps recent + pending", () => {
  const old = store.add(input({ fireAt: "2026-07-12T09:00:00+00:00" }));
  const recent = store.add(input({ fireAt: "2026-07-12T09:00:00+00:00" }));
  const pending = store.add(input({ fireAt: "2030-01-01T00:00:00+00:00" }));
  store.markFired(old.id, new Date("2026-07-12T09:00:00Z"));
  store.markFired(recent.id, new Date("2026-07-12T10:59:00Z"));
  store.prune(new Date("2026-07-12T10:00:00Z"));
  const ids = store.all().map((r) => r.id);
  expect(store.get(old.id)).toBeUndefined();
  expect(store.get(recent.id)?.firedAt).toBeString();
  expect(ids).toEqual([pending.id]);
});
