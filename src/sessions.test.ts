import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-svc-"));
const { Registry } = await import("./registry.js");
const svc = await import("./sessions.js");

type Info = import("./sessions.js").RuntimeInfo;

function makeHost() {
  const registry = new Registry();
  const runtimes = new Map<string, Info>();
  const dropped: string[] = [];
  const archived: Array<{ threadId: string; summary?: unknown }> = [];
  const host: import("./sessions.js").SessionServiceHost = {
    registry,
    runtimeInfo: (id) => runtimes.get(id),
    dropRuntime: async (id) => {
      dropped.push(id);
      runtimes.delete(id);
    },
    archiveSession: async (id, summary) => {
      archived.push({ threadId: id, summary });
    },
    requestRestart: async () => ({ ok: true, sha: "test-sha" }),
  };
  return { host, registry, runtimes, dropped, archived };
}

let h: ReturnType<typeof makeHost>;
beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-svc-"));
  h = makeHost();
});

test("listSessions merges registry records with live runtime info", () => {
  const a = h.registry.create("t-a", "alpha");
  h.runtimes.set("t-a", { busy: true, costUsd: 0.42, turns: 3, model: "claude-opus-4-8" });
  h.registry.create("t-b", "beta"); // no runtime -> dormant
  const list = svc.listSessions(h.host, new Date(a.createdAt).getTime() + 10_000);
  const byNum = Object.fromEntries(list.map((s) => [s.num, s]));
  expect(byNum[a.sessionNum]).toMatchObject({ title: "alpha", busy: true, live: true, costUsd: 0.42 });
  expect(byNum[a.sessionNum].ageSec).toBe(10);
  const b = list.find((s) => s.title === "beta")!;
  expect(b).toMatchObject({ busy: false, live: false, costUsd: 0 });
});

test("endSession on an idle active session ends it without forcing", async () => {
  const a = h.registry.create("t-a", "alpha");
  h.runtimes.set("t-a", { busy: false, costUsd: 1, turns: 2 });
  const res = await svc.endSession(h.host, a.sessionNum);
  expect(res).toMatchObject({ num: a.sessionNum, ended: true, forced: false });
  expect(h.registry.get("t-a")?.status).toBe("ended");
  expect(h.dropped).toContain("t-a");
  expect(h.archived[0]).toMatchObject({ threadId: "t-a", summary: { turns: 2, costUsd: 1 } });
});

test("endSession errors on unknown or already-ended session", async () => {
  expect((await svc.endSession(h.host, 999)).error).toContain("no session");
  const a = h.registry.create("t-a", "alpha");
  h.registry.update("t-a", { status: "ended" });
  expect((await svc.endSession(h.host, a.sessionNum)).error).toContain("already ended");
});

test("endSession waits for a busy turn to drain, then ends gracefully", async () => {
  const a = h.registry.create("t-a", "alpha");
  h.runtimes.set("t-a", { busy: true, costUsd: 0, turns: 1 });
  setTimeout(() => h.runtimes.set("t-a", { busy: false, costUsd: 0, turns: 1 }), 60);
  const res = await svc.endSession(h.host, a.sessionNum, { drainMs: 2000 });
  expect(res).toMatchObject({ ended: true, forced: false });
});

test("endSession forces when a busy turn never drains within the window", async () => {
  const a = h.registry.create("t-a", "alpha");
  h.runtimes.set("t-a", { busy: true, costUsd: 0, turns: 1 });
  const res = await svc.endSession(h.host, a.sessionNum, { drainMs: 30 });
  expect(res).toMatchObject({ ended: true, forced: true });
  expect(h.registry.get("t-a")?.status).toBe("ended");
});

test("killSession ends immediately regardless of busy state", async () => {
  const a = h.registry.create("t-a", "alpha");
  h.runtimes.set("t-a", { busy: true, costUsd: 0, turns: 5 });
  const res = await svc.killSession(h.host, a.sessionNum);
  expect(res).toMatchObject({ ended: true, forced: true });
  expect(h.dropped).toContain("t-a");
  expect(h.registry.get("t-a")?.status).toBe("ended");
});

test("endAll ends every active session and skips already-ended ones", async () => {
  h.registry.create("t-a", "alpha");
  const b = h.registry.create("t-b", "beta");
  h.registry.update("t-b", { status: "ended" });
  h.registry.create("t-c", "gamma");
  const results = await svc.endAll(h.host);
  expect(results.map((r) => r.num).sort()).toEqual([1, 3]);
  expect(h.registry.all().every((s) => s.status === "ended")).toBe(true);
  expect(b.sessionNum).toBe(2);
});

test("pruneEnded removes only ended records", () => {
  h.registry.create("t-a", "alpha");
  h.registry.create("t-b", "beta");
  h.registry.update("t-b", { status: "ended" });
  expect(svc.pruneEnded(h.host)).toEqual({ removed: 1 });
  expect(h.registry.get("t-b")).toBeUndefined();
  expect(h.registry.get("t-a")?.status).toBe("active");
});
