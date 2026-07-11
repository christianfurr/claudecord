import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-sch-"));
const { ReminderStore } = await import("./reminders.js");
const { Scheduler } = await import("./scheduler.js");

let store: InstanceType<typeof ReminderStore>;
beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-sch-"));
  store = new ReminderStore();
});

const FIRE_AT = "2026-07-12T09:00:00+00:00";
function seed(over: Record<string, unknown> = {}) {
  return store.add({
    threadId: "t-1",
    kind: "nudge",
    text: "test the deploy",
    fireAt: FIRE_AT,
    tz: "UTC",
    ...over,
  });
}

/** Fire callback that emulates the host: marks fired first, then records. */
function markingFire(clock: () => Date, log: string[]) {
  return async (r: { id: string }) => {
    store.markFired(r.id, clock());
    log.push(r.id);
  };
}

test("fires a due reminder exactly once across repeated ticks", async () => {
  const now = new Date(FIRE_AT);
  const log: string[] = [];
  const sched = new Scheduler(store, markingFire(() => now, log), { now: () => now });
  seed();
  await sched.tick();
  await sched.tick();
  expect(log).toHaveLength(1);
});

test("fires reminders that came due while the daemon was down, on the first tick", async () => {
  seed();
  const boot = new Date(new Date(FIRE_AT).getTime() + 10 * 60_000); // 10 min late
  const log: string[] = [];
  const sched = new Scheduler(store, markingFire(() => boot, log), { now: () => boot });
  await sched.tick();
  expect(log).toEqual([store.get(log[0]!)!.id]);
  expect(log).toHaveLength(1);
});

test("does not fire a reminder that is not yet due", async () => {
  seed();
  const early = new Date(new Date(FIRE_AT).getTime() - 60_000);
  const log: string[] = [];
  const sched = new Scheduler(store, markingFire(() => early, log), { now: () => early });
  await sched.tick();
  expect(log).toHaveLength(0);
});

test("a failing fire is isolated and does not block sibling reminders", async () => {
  const now = new Date(FIRE_AT);
  const a = seed({ text: "a" });
  const b = seed({ text: "b" });
  const fired: string[] = [];
  const fire = async (r: { id: string }) => {
    store.markFired(r.id, now);
    if (r.id === a.id) throw new Error("boom");
    fired.push(r.id);
  };
  const sched = new Scheduler(store, fire, { now: () => now });
  await sched.tick();
  expect(fired).toEqual([b.id]);
});

test("prunes fired reminders older than the retention window", async () => {
  const r = seed();
  const now = new Date(new Date(FIRE_AT).getTime() + 2 * 60 * 60 * 1000); // 2h later
  const sched = new Scheduler(store, markingFire(() => new Date(FIRE_AT), []), {
    now: () => now,
    pruneAfterMs: 60 * 60 * 1000, // keep 1h
  });
  await sched.tick();
  expect(store.get(r.id)).toBeUndefined();
});
