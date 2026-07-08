# Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class session management (list, end, end-all, kill, prune) to both the host CLI and Discord, executed by the daemon over a Unix control socket.

**Architecture:** A single `sessions.ts` service layer holds all lifecycle logic behind a small `SessionServiceHost` interface. `Claudecord` implements that interface for in-process (Discord) calls; a Unix-socket control server (`control.ts`) exposes it to the CLI; the CLI's down-daemon fallback runs the same service functions against an "offline host" backed only by the registry file.

**Tech Stack:** Bun, TypeScript (strict), discord.js v14, `node:net` (Unix socket), `bun:test`.

## Global Constraints

- Runtime: Bun ≥ 1.1; all source is TypeScript ESM (`.js` import specifiers resolve to `.ts`).
- Config/registry live under `~/.claudecord/`; the control socket is `~/.claudecord/control.sock`, `chmod 0600`, local-only, no auth token (filesystem perms are the boundary).
- `end` = graceful (drain an in-flight turn up to `END_DRAIN_MS = 30_000`, then force); `kill` = force immediately. `runtime.dispose()` (called by `dropRuntime`) already interrupts an in-flight turn.
- Service functions return structured results; they never throw across the socket boundary.
- Tests use `bun test`; test files are co-located as `src/*.test.ts`.
- Match existing style: concrete classes, no external test/DI libraries, 2-space indent, no emoji in code.

---

## File Structure

- `src/registry.ts` — add `getByNum`, `remove` (modify)
- `src/sessions.ts` — service layer + `SessionServiceHost` interface (create)
- `src/sessions.test.ts` — service-layer unit tests (create)
- `src/bot.ts` — `Claudecord` implements `runtimeInfo` + `archiveSession` (modify)
- `src/control.ts` — Unix-socket control server + dispatch (create)
- `src/control.test.ts` — socket round-trip tests (create)
- `src/index.ts` — start/stop the control server (modify)
- `src/cli.ts` — `sessions`/`end`/`kill`/`prune` subcommands + offline fallback (modify)
- `src/format.ts` — `sessionListEmbed` (modify)
- `src/commands.ts` — `/sessions`, `/end-all`, `/kill`; refactor `/end` onto the service (modify)

---

## Task 1: Registry lookup/remove helpers

**Files:**
- Modify: `src/registry.ts`
- Test: `src/registry.test.ts` (create)

**Interfaces:**
- Consumes: existing `Registry`, `SessionRecord`.
- Produces:
  - `Registry.getByNum(num: number): SessionRecord | undefined`
  - `Registry.remove(threadId: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/registry.test.ts`:

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point CONFIG_DIR at a temp dir BEFORE importing the registry.
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

test("remove deletes a record and reports whether it existed", () => {
  reg.create("t-a", "alpha");
  expect(reg.remove("t-a")).toBe(true);
  expect(reg.get("t-a")).toBeUndefined();
  expect(reg.remove("t-a")).toBe(false);
});
```

- [ ] **Step 2: Make `CONFIG_DIR` honor `CLAUDECORD_HOME` (test seam)**

In `src/config.ts`, ensure `CONFIG_DIR` derives from an overridable base. Confirm current definition and change it to:

```ts
export const CONFIG_DIR =
  process.env.CLAUDECORD_HOME ?? join(homedir(), ".claudecord");
```

(If `CONFIG_DIR` is already computed differently, wrap the same override in front of it. This env var is test-only; do not document it as a feature.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/registry.test.ts`
Expected: FAIL — `getByNum`/`remove` are not functions.

- [ ] **Step 4: Implement the helpers**

In `src/registry.ts`, inside `class Registry`, after `all()`:

```ts
  getByNum(num: number): SessionRecord | undefined {
    return Object.values(this.data.sessions).find((s) => s.sessionNum === num);
  }

  remove(threadId: string): boolean {
    if (!this.data.sessions[threadId]) return false;
    delete this.data.sessions[threadId];
    save(this.data);
    return true;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts src/registry.test.ts src/config.ts
git commit -m "feat(registry): add getByNum and remove helpers"
```

---

## Task 2: Session-service layer

**Files:**
- Create: `src/sessions.ts`
- Test: `src/sessions.test.ts`

**Interfaces:**
- Consumes: `Registry` (with `getByNum`, `remove`, `all`, `update` from Task 1), `SessionRecord`.
- Produces:

```ts
export const END_DRAIN_MS = 30_000;

export interface RuntimeInfo {
  busy: boolean;
  costUsd: number;
  turns: number;
  model?: string;
}
export interface SessionServiceHost {
  registry: Registry;
  runtimeInfo(threadId: string): RuntimeInfo | undefined;
  dropRuntime(threadId: string): Promise<void>;
  archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void>;
}
export interface SessionSummary {
  num: number; title: string; status: "active" | "ended";
  model?: string; busy: boolean; live: boolean; ageSec: number; costUsd: number;
}
export interface EndResult { num: number; ended: boolean; forced: boolean; error?: string }

export function listSessions(host: SessionServiceHost, now?: number): SessionSummary[];
export async function endSession(host: SessionServiceHost, num: number, opts?: { drainMs?: number }): Promise<EndResult>;
export async function endAll(host: SessionServiceHost, opts?: { drainMs?: number }): Promise<EndResult[]>;
export async function killSession(host: SessionServiceHost, num: number): Promise<EndResult>;
export function pruneEnded(host: SessionServiceHost): { removed: number };
```

- [ ] **Step 1: Write the failing tests**

Create `src/sessions.test.ts`:

```ts
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
    dropRuntime: async (id) => { dropped.push(id); runtimes.delete(id); },
    archiveSession: async (id, summary) => { archived.push({ threadId: id, summary }); },
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/sessions.test.ts`
Expected: FAIL — cannot resolve `./sessions.js`.

- [ ] **Step 3: Implement the service layer**

Create `src/sessions.ts`:

```ts
import type { Registry } from "./registry.js";

export const END_DRAIN_MS = 30_000;
const DRAIN_POLL_MS = 100;

export interface RuntimeInfo {
  busy: boolean;
  costUsd: number;
  turns: number;
  model?: string;
}

export interface SessionServiceHost {
  registry: Registry;
  runtimeInfo(threadId: string): RuntimeInfo | undefined;
  dropRuntime(threadId: string): Promise<void>;
  archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void>;
}

export interface SessionSummary {
  num: number;
  title: string;
  status: "active" | "ended";
  model?: string;
  busy: boolean;
  live: boolean;
  ageSec: number;
  costUsd: number;
}

export interface EndResult {
  num: number;
  ended: boolean;
  forced: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function listSessions(host: SessionServiceHost, now = Date.now()): SessionSummary[] {
  return host.registry.all().map((r) => {
    const info = host.runtimeInfo(r.threadId);
    return {
      num: r.sessionNum,
      title: r.title,
      status: r.status,
      model: r.model ?? info?.model,
      busy: info?.busy ?? false,
      live: info !== undefined,
      ageSec: Math.round((now - new Date(r.createdAt).getTime()) / 1000),
      costUsd: info?.costUsd ?? 0,
    };
  });
}

async function drain(host: SessionServiceHost, threadId: string, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (host.runtimeInfo(threadId)?.busy) {
    if (Date.now() >= deadline) return false;
    await sleep(DRAIN_POLL_MS);
  }
  return true;
}

async function teardown(
  host: SessionServiceHost,
  threadId: string,
  info: RuntimeInfo | undefined,
): Promise<void> {
  await host.dropRuntime(threadId);
  host.registry.update(threadId, { status: "ended" });
  await host.archiveSession(threadId, info ? { turns: info.turns, costUsd: info.costUsd } : undefined);
}

export async function endSession(
  host: SessionServiceHost,
  num: number,
  opts: { drainMs?: number } = {},
): Promise<EndResult> {
  const record = host.registry.getByNum(num);
  if (!record) return { num, ended: false, forced: false, error: `no session #${num}` };
  if (record.status === "ended") return { num, ended: false, forced: false, error: `session #${num} already ended` };

  const info = host.runtimeInfo(record.threadId);
  let forced = false;
  if (info?.busy) forced = !(await drain(host, record.threadId, opts.drainMs ?? END_DRAIN_MS));
  await teardown(host, record.threadId, info);
  return { num, ended: true, forced };
}

export async function killSession(host: SessionServiceHost, num: number): Promise<EndResult> {
  const record = host.registry.getByNum(num);
  if (!record) return { num, ended: false, forced: true, error: `no session #${num}` };
  if (record.status === "ended") return { num, ended: false, forced: true, error: `session #${num} already ended` };
  await teardown(host, record.threadId, host.runtimeInfo(record.threadId));
  return { num, ended: true, forced: true };
}

export async function endAll(
  host: SessionServiceHost,
  opts: { drainMs?: number } = {},
): Promise<EndResult[]> {
  const active = host.registry.all().filter((r) => r.status === "active");
  const results: EndResult[] = [];
  for (const r of active) {
    try {
      results.push(await endSession(host, r.sessionNum, opts));
    } catch (err) {
      results.push({ num: r.sessionNum, ended: false, forced: false, error: String(err) });
    }
  }
  return results;
}

export function pruneEnded(host: SessionServiceHost): { removed: number } {
  const ended = host.registry.all().filter((r) => r.status === "ended");
  for (const r of ended) host.registry.remove(r.threadId);
  return { removed: ended.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/sessions.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/sessions.test.ts
git commit -m "feat(sessions): add session-service layer with host interface"
```

---

## Task 3: Claudecord implements SessionServiceHost

**Files:**
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `RuntimeInfo`, `SessionServiceHost` from Task 2; existing `endedEmbed` from `format.ts`.
- Produces: `Claudecord` now satisfies `SessionServiceHost` via new methods:
  - `runtimeInfo(threadId: string): RuntimeInfo | undefined`
  - `archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void>`

- [ ] **Step 1: Add the import and `implements` clause**

In `src/bot.ts`, extend the `format.js` import and the class declaration:

```ts
import { welcomeEmbed, endedEmbed } from "./format.js";
import type { RuntimeInfo, SessionServiceHost } from "./sessions.js";
```

```ts
export class Claudecord implements SessionServiceHost {
```

- [ ] **Step 2: Implement `runtimeInfo` and `archiveSession`**

In `src/bot.ts`, add these methods to the class (e.g. just before `shutdown()`):

```ts
  runtimeInfo(threadId: string): RuntimeInfo | undefined {
    const rt = this.runtimes.get(threadId);
    if (!rt) return undefined;
    return { busy: rt.busy, costUsd: rt.stats.totalCostUsd, turns: rt.stats.userTurns, model: rt.stats.model };
  }

  async archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void> {
    const record = this.registry.get(threadId);
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    if (!channel || !channel.isThread()) return;
    await this.applyTag(channel, "done");
    if (record) await channel.send({ embeds: [endedEmbed(record, summary)] }).catch(() => undefined);
    await channel.setArchived(true).catch(() => undefined);
  }
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors (confirms `Claudecord` structurally satisfies `SessionServiceHost`).

- [ ] **Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): implement SessionServiceHost on Claudecord"
```

---

## Task 4: Control socket server

**Files:**
- Create: `src/control.ts`
- Test: `src/control.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `SessionServiceHost` + service functions from Task 2.
- Produces:
  - `CONTROL_SOCKET: string`
  - `handleControlCommand(host: SessionServiceHost, cmd: string, args?: { num?: number }): Promise<unknown>`
  - `startControlServer(host: SessionServiceHost): import("node:net").Server`

- [ ] **Step 1: Write the failing round-trip test**

Create `src/control.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Server } from "node:net";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-ctl-"));
const { Registry } = await import("./registry.js");
const { startControlServer, CONTROL_SOCKET } = await import("./control.js");

type Host = import("./sessions.js").SessionServiceHost;

function makeHost(): Host {
  const registry = new Registry();
  return {
    registry,
    runtimeInfo: () => undefined,
    dropRuntime: async () => {},
    archiveSession: async () => {},
  };
}

function request(payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(CONTROL_SOCKET);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) { sock.end(); resolve(JSON.parse(buf.trim())); } });
    sock.on("error", reject);
  });
}

let server: Server;
let host: Host;
beforeEach(() => {
  process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-ctl-"));
  host = makeHost();
  server = startControlServer(host);
});
afterEach(() => server.close());

test("list returns session summaries", async () => {
  host.registry.create("t-a", "alpha");
  const res = await request({ cmd: "list" });
  expect(res.ok).toBe(true);
  expect(res.data[0]).toMatchObject({ title: "alpha", status: "active" });
});

test("end marks a session ended", async () => {
  const a = host.registry.create("t-a", "alpha");
  const res = await request({ cmd: "end", args: { num: a.sessionNum } });
  expect(res).toMatchObject({ ok: true, data: { ended: true } });
  expect(host.registry.get("t-a")?.status).toBe("ended");
});

test("unknown command returns a structured error", async () => {
  const res = await request({ cmd: "bogus" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("unknown command");
});

test("malformed JSON returns a structured error, not a crash", async () => {
  const res = await new Promise<any>((resolve, reject) => {
    const sock = createConnection(CONTROL_SOCKET);
    let buf = "";
    sock.on("connect", () => sock.write("not json\n"));
    sock.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) { sock.end(); resolve(JSON.parse(buf.trim())); } });
    sock.on("error", reject);
  });
  expect(res.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/control.test.ts`
Expected: FAIL — cannot resolve `./control.js`.

- [ ] **Step 3: Implement the control server**

Create `src/control.ts`:

```ts
import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { listSessions, endSession, endAll, killSession, pruneEnded, type SessionServiceHost } from "./sessions.js";

export const CONTROL_SOCKET = join(CONFIG_DIR, "control.sock");

export async function handleControlCommand(
  host: SessionServiceHost,
  cmd: string,
  args?: { num?: number },
): Promise<unknown> {
  switch (cmd) {
    case "list":
      return listSessions(host);
    case "end":
      return endSession(host, Number(args?.num));
    case "endAll":
      return endAll(host);
    case "kill":
      return killSession(host, Number(args?.num));
    case "prune":
      return pruneEnded(host);
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

export function startControlServer(host: SessionServiceHost): Server {
  if (existsSync(CONTROL_SOCKET)) unlinkSync(CONTROL_SOCKET);
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      void (async () => {
        try {
          const { cmd, args } = JSON.parse(line) as { cmd: string; args?: { num?: number } };
          const data = await handleControlCommand(host, cmd, args);
          sock.end(JSON.stringify({ ok: true, data }) + "\n");
        } catch (err) {
          sock.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
        }
      })();
    });
    sock.on("error", () => sock.destroy());
  });
  server.listen(CONTROL_SOCKET, () => chmodSync(CONTROL_SOCKET, 0o600));
  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/control.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the server into the daemon lifecycle**

In `src/index.ts`, import and manage the server. Add near the top imports:

```ts
import { startControlServer, CONTROL_SOCKET } from "./control.js";
import { existsSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
```

Add a module-scope handle and start it inside the `ClientReady` handler (after command registration):

```ts
let control: Server | undefined;
```

```ts
  control = startControlServer(app);
  console.log(`control socket listening at ${CONTROL_SOCKET}`);
```

Update the signal handler to close it and remove the socket file:

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} — shutting down`);
    control?.close();
    if (existsSync(CONTROL_SOCKET)) unlinkSync(CONTROL_SOCKET);
    void app.shutdown().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add src/control.ts src/control.test.ts src/index.ts
git commit -m "feat(control): add Unix-socket control server and daemon wiring"
```

---

## Task 5: CLI session-management subcommands

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-offline.test.ts` (create)

**Interfaces:**
- Consumes: `CONTROL_SOCKET` (Task 4); service functions + `SessionServiceHost` (Task 2); `Registry` (Task 1).
- Produces: CLI subcommands `sessions`, `end <n>`, `end --all`, `kill <n>`, `prune`; internal helpers `sendControl`, `offlineHost`.

- [ ] **Step 1: Write the failing offline-fallback test**

Create `src/cli-offline.test.ts`. This tests the offline host that the CLI falls back to when no daemon is running (it must reuse the service layer):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli-offline.test.ts`
Expected: FAIL — `offlineHost` is not exported from `./cli.js`.

- [ ] **Step 3: Implement helpers + subcommands in `src/cli.ts`**

Add imports near the top of `src/cli.ts`:

```ts
import { createConnection } from "node:net";
import { Registry } from "./registry.js";
import {
  listSessions, endSession, endAll, killSession, pruneEnded,
  type SessionServiceHost, type SessionSummary, type EndResult,
} from "./sessions.js";

const CONTROL_SOCKET = join(homedir(), ".claudecord", "control.sock");
```

Add the socket client, offline host, and formatting helpers (place above the `switch`):

```ts
function sendControl(cmd: string, args?: object): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(CONTROL_SOCKET);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("control socket timed out")); }, 5000);
    sock.on("connect", () => sock.write(JSON.stringify({ cmd, args }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        clearTimeout(timer);
        sock.end();
        try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function isDaemonDown(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export function offlineHost(): SessionServiceHost {
  return {
    registry: new Registry(),
    runtimeInfo: () => undefined,
    dropRuntime: async () => undefined,
    archiveSession: async () => undefined,
  };
}

function printSessions(list: SessionSummary[]): void {
  if (list.length === 0) return console.log("no sessions");
  for (const s of list) {
    const state = s.status === "ended" ? "ended " : s.busy ? "working" : s.live ? "idle  " : "dormant";
    const age = s.ageSec >= 3600 ? `${Math.floor(s.ageSec / 3600)}h` : `${Math.floor(s.ageSec / 60)}m`;
    console.log(`#${s.num}\t${state}\t$${s.costUsd.toFixed(2)}\t${age}\t${s.title}`);
  }
}

function printEnd(r: EndResult): void {
  if (r.error) console.log(`#${r.num}: ${r.error}`);
  else console.log(`#${r.num}: ended${r.forced ? " (forced)" : ""}`);
}
```

Add the command handlers:

```ts
async function cmdSessions(): Promise<void> {
  try {
    const res = await sendControl("list");
    printSessions((res.data as SessionSummary[]) ?? []);
  } catch (err) {
    if (!isDaemonDown(err)) throw err;
    printSessions(listSessions(offlineHost()));
  }
}

async function cmdEnd(num: number): Promise<void> {
  try {
    const res = await sendControl("end", { num });
    printEnd(res.data as EndResult);
  } catch (err) {
    if (!isDaemonDown(err)) throw err;
    printEnd(await endSession(offlineHost(), num));
    console.log("(daemon down — Discord thread not archived)");
  }
}

async function cmdEndAll(): Promise<void> {
  try {
    const res = await sendControl("endAll");
    (res.data as EndResult[]).forEach(printEnd);
  } catch (err) {
    if (!isDaemonDown(err)) throw err;
    (await endAll(offlineHost())).forEach(printEnd);
    console.log("(daemon down — Discord threads not archived)");
  }
}

async function cmdKill(num: number): Promise<void> {
  try {
    const res = await sendControl("kill", { num });
    printEnd(res.data as EndResult);
  } catch (err) {
    if (!isDaemonDown(err)) throw err;
    console.error("daemon not running — nothing to kill");
    process.exit(1);
  }
}

async function cmdPrune(): Promise<void> {
  try {
    const res = await sendControl("prune");
    console.log(`pruned ${(res.data as { removed: number }).removed} ended session(s)`);
  } catch (err) {
    if (!isDaemonDown(err)) throw err;
    console.log(`pruned ${pruneEnded(offlineHost()).removed} ended session(s)`);
  }
}
```

Add cases to the `switch (command)` block:

```ts
  case "sessions":
    await cmdSessions();
    break;
  case "end":
    if (process.argv[3] === "--all") await cmdEndAll();
    else await cmdEnd(Number(process.argv[3]));
    break;
  case "kill":
    await cmdKill(Number(process.argv[3]));
    break;
  case "prune":
    await cmdPrune();
    break;
```

Update the default usage string and the header comment to include the new commands:

```ts
    console.log(
      "claudecord <install|uninstall|start|stop|restart|status|logs|run|owner|sessions|end|kill|prune>",
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cli-offline.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add src/cli.ts src/cli-offline.test.ts
git commit -m "feat(cli): add sessions/end/kill/prune subcommands with offline fallback"
```

---

## Task 6: Discord commands (/sessions, /end-all, /kill) + /end refactor

**Files:**
- Modify: `src/format.ts` (add `sessionListEmbed`)
- Modify: `src/commands.ts`

**Interfaces:**
- Consumes: `listSessions`, `endSession`, `endAll`, `killSession`, `SessionSummary` (Task 2); existing `sessionThread` helper, `app.isOwner`.
- Produces: `sessionListEmbed(list: SessionSummary[]): EmbedBuilder`; command definitions `sessions`, `end-all`, `kill`; handlers `handleSessions`, `handleEndAll`, `handleKill`; `handleEnd` refactored onto `endSession`.

- [ ] **Step 1: Add `sessionListEmbed` to `src/format.ts`**

```ts
import type { SessionSummary } from "./sessions.js";
```

```ts
export function sessionListEmbed(list: SessionSummary[]): EmbedBuilder {
  const lines = list.length
    ? list
        .map((s) => {
          const state = s.status === "ended" ? "✅ ended" : s.busy ? "⚙️ working" : s.live ? "🟢 idle" : "💤 dormant";
          const age = s.ageSec >= 3600 ? `${Math.floor(s.ageSec / 3600)}h` : `${Math.floor(s.ageSec / 60)}m`;
          return `**#${s.num}** ${state} · $${s.costUsd.toFixed(2)} · ${age} — ${s.title}`;
        })
        .join("\n")
    : "_No sessions yet._";
  return new EmbedBuilder().setColor(Colors.Green).setTitle("Sessions").setDescription(lines).setTimestamp();
}
```

- [ ] **Step 2: Register the new command definitions in `src/commands.ts`**

Add to the `commandDefinitions` array (before the final `.map(...)`):

```ts
  new SlashCommandBuilder().setName("sessions").setDescription("List all Claude sessions with status, cost, and age"),
  new SlashCommandBuilder()
    .setName("end-all")
    .setDescription("End every active session (owner only)"),
  new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Force-end this session immediately, even mid-turn"),
```

Update imports at the top:

```ts
import { endedEmbed, errorEmbed, statusEmbed, sessionListEmbed } from "./format.js";
import { listSessions, endSession, endAll, killSession } from "./sessions.js";
```

- [ ] **Step 3: Add dispatch cases**

In the `switch (interaction.commandName)` block:

```ts
    case "sessions":
      return handleSessions(app, interaction);
    case "end-all":
      return handleEndAll(app, interaction);
    case "kill":
      return handleKill(app, interaction);
```

- [ ] **Step 4: Implement the handlers and refactor `handleEnd`**

Replace the body of `handleEnd` so it routes through the service (dedup):

```ts
async function handleEnd(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const res = await endSession(app, record.sessionNum);
  if (res.error) await interaction.editReply({ embeds: [errorEmbed(res.error)] });
  else await interaction.editReply({ embeds: [endedEmbed(app.registry.get(thread.id)!)] });
}
```

Add the new handlers:

```ts
async function handleSessions(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ embeds: [sessionListEmbed(listSessions(app))] });
}

async function handleEndAll(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!app.isOwner(interaction.user.id)) {
    await interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const results = await endAll(app);
  const summary = results.length
    ? results.map((r) => `#${r.num}: ${r.error ?? (r.forced ? "ended (forced)" : "ended")}`).join("\n")
    : "No active sessions.";
  await interaction.editReply(summary);
}

async function handleKill(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const res = await killSession(app, record.sessionNum);
  await interaction.editReply(res.error ? `Could not kill: ${res.error}` : `Killed session #${res.num}.`);
}
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/format.ts src/commands.ts
git commit -m "feat(discord): add /sessions, /end-all, /kill; route /end through service"
```

---

## Task 7: Full-suite verification + live end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: PASS — all tests from Tasks 1, 2, 4, 5 green.

- [ ] **Step 2: Typecheck the whole project**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Restart the daemon so the control socket comes up**

Run: `bun src/cli.ts restart`
Then confirm the socket exists: `ls -l ~/.claudecord/control.sock`
Expected: a socket file, mode `srw-------`.

- [ ] **Step 4: Exercise the CLI against the live daemon**

Run: `bun src/cli.ts sessions`
Expected: a table of current sessions (or "no sessions").

Create a throwaway session from Discord (`/new` or a post), then:
Run: `bun src/cli.ts sessions` → the new session appears as `working`/`idle`.
Run: `bun src/cli.ts end <n>` → prints `#<n>: ended`; the Discord thread is archived with an ended embed; the menu-bar count drops.
Run: `bun src/cli.ts prune` → prints the removed count; ended sessions disappear from `sessions`.

- [ ] **Step 5: Verify the offline fallback**

Run: `bun src/cli.ts stop`
Run: `bun src/cli.ts sessions` → still lists sessions (from the registry file).
Run: `bun src/cli.ts kill 1` → prints "daemon not running — nothing to kill", exits non-zero.
Run: `bun src/cli.ts start`

- [ ] **Step 6: Final commit if any verification tweaks were needed**

```bash
git add -A && git commit -m "test: verify session-management end-to-end"
```

---

## Self-Review

**Spec coverage:**
- List/inspect → Task 2 `listSessions`, Task 5 `sessions`, Task 6 `/sessions`. ✓
- End one / end all → Task 2 `endSession`/`endAll`, Task 5 `end`/`end --all`, Task 6 `/end`(refactor)/`/end-all`. ✓
- Prune ended → Task 2 `pruneEnded`, Task 5 `prune`. ✓
- Force kill → Task 2 `killSession`, Task 5 `kill`, Task 6 `/kill`. ✓
- Control socket (protocol, 0600, unlink stale, shutdown close) → Task 4. ✓
- Down-daemon fallback → Task 5 (`offlineHost`, `isDaemonDown`). ✓
- Error handling (structured results, unknown/malformed cmd, endAll isolation) → Tasks 2 & 4 tests. ✓
- Testing (service unit, socket round-trip, CLI fallback, e2e) → Tasks 2, 4, 5, 7. ✓

**Type consistency:** `SessionServiceHost`, `RuntimeInfo`, `SessionSummary`, `EndResult` defined in Task 2 and consumed unchanged in Tasks 3–6. `endSession(host, num, opts?)`, `killSession(host, num)`, `endAll(host, opts?)`, `pruneEnded(host)`, `listSessions(host, now?)` signatures match across control server, CLI, and Discord callers. Control commands (`list`/`end`/`endAll`/`kill`/`prune`) match between `handleControlCommand` (Task 4) and `sendControl` callers (Task 5). ✓

**Placeholder scan:** none — every code step contains full code. ✓
