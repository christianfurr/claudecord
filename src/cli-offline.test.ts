import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-cli-"));
const { Registry } = await import("./registry.js");
const { offlineHost } = await import("./cli.js");
const { listSessions, pruneEnded, endSession } = await import("./sessions.js");

beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-cli-"));
});

test("offlineHost reports no live runtimes", () => {
  const reg = new Registry();
  reg.create("t-a", "alpha");
  const list = listSessions(offlineHost());
  expect(list[0]).toMatchObject({ title: "alpha", live: false, busy: false, costUsd: 0 });
});

test("offline end and prune mutate the registry file", async () => {
  const reg = new Registry();
  const a = reg.create("t-a", "alpha");
  await endSession(offlineHost(), a.sessionNum);
  expect(new Registry().get("t-a")?.status).toBe("ended");
  expect(pruneEnded(offlineHost())).toEqual({ removed: 1 });
  expect(new Registry().get("t-a")).toBeUndefined();
});
