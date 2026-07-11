import { test, expect } from "bun:test";
import { dispatchReminder, type FireHooks } from "./fire.js";
import type { Reminder } from "./reminders.js";

function reminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    threadId: "t-1",
    kind: "nudge",
    text: "test the deploy",
    schedule: { type: "once", fireAt: "2026-07-12T09:00:00+00:00", tz: "UTC" },
    createdAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

function hooks(over: Partial<FireHooks> = {}) {
  const calls = {
    marked: [] as string[],
    nudged: [] as { threadId: string; text: string }[],
    woke: [] as string[],
  };
  const base: FireHooks = {
    markFired: (id) => calls.marked.push(id),
    nudge: async (threadId, text) => void calls.nudged.push({ threadId, text }),
    wakeSession: async (r) => (calls.woke.push(r.id), true),
    ...over,
  };
  return { base, calls };
}

test("always marks fired before doing anything else", async () => {
  const order: string[] = [];
  const { base } = hooks({
    markFired: () => order.push("mark"),
    nudge: async () => void order.push("nudge"),
  });
  await dispatchReminder(reminder(), base);
  expect(order[0]).toBe("mark");
});

test("nudge notifies and never wakes the session", async () => {
  const { base, calls } = hooks();
  await dispatchReminder(reminder({ kind: "nudge", text: "ship it" }), base);
  expect(calls.nudged).toEqual([{ threadId: "t-1", text: "ship it" }]);
  expect(calls.woke).toHaveLength(0);
});

test("task wakes the session and does not nudge when revival succeeds", async () => {
  const { base, calls } = hooks();
  await dispatchReminder(reminder({ kind: "task" }), base);
  expect(calls.woke).toEqual(["r1"]);
  expect(calls.nudged).toHaveLength(0);
});

test("task falls back to a nudge with a note when the session is gone", async () => {
  const { base, calls } = hooks({ wakeSession: async () => false });
  await dispatchReminder(reminder({ kind: "task", text: "run the tests" }), base);
  expect(calls.woke).toHaveLength(0);
  expect(calls.nudged).toHaveLength(1);
  expect(calls.nudged[0]!.text).toContain("run the tests");
  expect(calls.nudged[0]!.text).toContain("couldn't revive");
});
