# Restart Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give claudecord a clean restart that keeps all conversation context — triggerable via `/restart`, `claudecord restart`, and an in-session `restart` MCP tool — with no double-fork/Python hack.

**Architecture:** All three surfaces call one method, `Claudecord.requestRestart`, which typecheck-gates, posts a "restarting" note, writes a marker file, and `process.exit(0)`. launchd (`KeepAlive=true`) respawns the daemon on new code; sessions resume from their persisted `sdkSessionId` on the next message (already how resume works). On boot the daemon reads the marker and posts a "back online" confirmation to the requesting thread.

**Tech Stack:** Bun, TypeScript, discord.js, `@anthropic-ai/claude-agent-sdk`, macOS launchd, `bun:test`.

## Global Constraints

- Runtime is **Bun**; tests use `bun:test`. Run the suite with `bun test`, typecheck with `bun run typecheck` (`tsc --noEmit`).
- **Never restart/kill the daemon from inside a claudecord Discord session** to verify — it ends the session mid-turn. Daemon-level exit + launchd revive is verified by the owner in a terminal. Inside a session, verify only via `bun test` and `bun run typecheck`.
- Config/state files live under `process.env.CLAUDECORD_HOME ?? CONFIG_DIR`; write atomically (tmp + rename), matching `registry.ts`.
- launchd label is `com.christianfurr.claudecord`; job runs `KeepAlive=true` + `RunAtLoad=true` (cli.ts:92-93) — a plain `process.exit(0)` is respawned automatically. Do NOT reintroduce `launchctl kickstart` for self-restart.
- Match existing code style: focused files, comments explain WHY, no commented-out code.

---

### Task 1: `restart.ts` — marker + preflight + sha helpers

**Files:**
- Create: `src/restart.ts`
- Test: `src/restart.test.ts`

**Interfaces:**
- Consumes: `CONFIG_DIR` from `./config.js`.
- Produces:
  - `interface RestartMarker { threadId?: string; sha: string; requestedAt: string }`
  - `interface RestartResult { ok: boolean; sha: string; error?: string }`
  - `interface RestartOptions { threadId?: string; skipPreflight?: boolean; exitDelayMs?: number }`
  - `writeRestartMarker(marker: RestartMarker): void`
  - `readRestartMarker(): RestartMarker | undefined`
  - `clearRestartMarker(): void`
  - `currentSha(repoRoot: string): string`
  - `runPreflight(repoRoot: string, cmd?: string[]): { ok: boolean; output: string }`

- [ ] **Step 1: Write the failing test**

```ts
// src/restart.test.ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-restart-"));
const {
  writeRestartMarker,
  readRestartMarker,
  clearRestartMarker,
  currentSha,
  runPreflight,
} = await import("./restart.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-restart-"));
  process.env.CLAUDECORD_HOME = home;
});

test("marker round-trips write -> read", () => {
  writeRestartMarker({ threadId: "t-1", sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
  expect(readRestartMarker()).toEqual({ threadId: "t-1", sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
});

test("read returns undefined when no marker exists", () => {
  expect(readRestartMarker()).toBeUndefined();
});

test("write leaves no .tmp file behind", () => {
  writeRestartMarker({ sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
  expect(readdirSync(home).some((f) => f.endsWith(".tmp"))).toBe(false);
});

test("clear removes the marker", () => {
  writeRestartMarker({ sha: "abc1234", requestedAt: "2026-07-17T00:00:00Z" });
  clearRestartMarker();
  expect(readRestartMarker()).toBeUndefined();
  clearRestartMarker(); // idempotent — no throw when already gone
});

test("runPreflight maps a zero exit to ok and captures output", () => {
  const res = runPreflight(home, ["bash", "-lc", "echo hello; exit 0"]);
  expect(res.ok).toBe(true);
  expect(res.output).toContain("hello");
});

test("runPreflight maps a non-zero exit to failure and captures output", () => {
  const res = runPreflight(home, ["bash", "-lc", "echo boom 1>&2; exit 1"]);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("boom");
});

test("currentSha returns 'unknown' outside a git repo", () => {
  expect(currentSha(home)).toBe("unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/restart.test.ts`
Expected: FAIL — cannot resolve `./restart.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/restart.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface RestartMarker {
  threadId?: string;
  sha: string;
  requestedAt: string;
}

export interface RestartResult {
  ok: boolean;
  sha: string;
  error?: string;
}

export interface RestartOptions {
  threadId?: string;
  /** Skip the typecheck gate (CLI --force). */
  skipPreflight?: boolean;
  /** Delay before process.exit so replies/tool results flush first. */
  exitDelayMs?: number;
}

function markerFile(): string {
  return join(process.env.CLAUDECORD_HOME ?? CONFIG_DIR, "restart.json");
}

export function writeRestartMarker(marker: RestartMarker): void {
  const file = markerFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, file);
}

export function readRestartMarker(): RestartMarker | undefined {
  const file = markerFile();
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RestartMarker;
  } catch {
    return undefined; // partial write in flight — treat as absent
  }
}

export function clearRestartMarker(): void {
  const file = markerFile();
  if (existsSync(file)) unlinkSync(file);
}

/** Short git SHA of the repo, best-effort — "unknown" if git is unavailable. */
export function currentSha(repoRoot: string): string {
  const res = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  const sha = res.stdout?.trim();
  return res.status === 0 && sha ? sha : "unknown";
}

/**
 * Preflight gate before a restart: run the typecheck and report pass/fail with
 * combined output. Blocking (spawnSync) — a restart is disruptive anyway and the
 * typecheck is ~0.5s. `cmd` is injectable for tests.
 */
export function runPreflight(
  repoRoot: string,
  cmd: string[] = ["bun", "run", "typecheck"],
): { ok: boolean; output: string } {
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd: repoRoot, encoding: "utf8" });
  const output = ((res.stdout ?? "") + (res.stderr ?? "")).trim();
  return { ok: res.status === 0, output };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/restart.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/restart.ts src/restart.test.ts
git commit -m "feat(restart): marker, preflight, and sha helpers"
```

---

### Task 2: `requestRestart` + boot consumption on the app; interface conformance

**Files:**
- Modify: `src/sessions.ts` (add `requestRestart` to `SessionServiceHost`)
- Modify: `src/bot.ts` (add `REPO_ROOT`, `requestRestart`, `consumeRestartMarker`)
- Modify: `src/cli.ts:235-242` (`offlineHost` stub)
- Modify: `src/control.test.ts:13-21` (`makeHost` stub)

**Interfaces:**
- Consumes: `RestartOptions`, `RestartResult`, `currentSha`, `runPreflight`, `writeRestartMarker`, `readRestartMarker`, `clearRestartMarker` from `./restart.js`.
- Produces:
  - `SessionServiceHost.requestRestart(opts: RestartOptions): Promise<RestartResult>`
  - `Claudecord.requestRestart(opts?: RestartOptions): Promise<RestartResult>`
  - `Claudecord.consumeRestartMarker(): Promise<void>`

This task has no new unit test — `requestRestart` calls `process.exit` and Discord, so it is verified by `bun run typecheck` (all implementors satisfy the interface), the still-green `bun test` suite, and the owner's terminal daemon test. Later tasks (3, 5, 6) test the surfaces that call it.

- [ ] **Step 1: Add the method to the host interface**

In `src/sessions.ts`, add the import at the top and the method to `SessionServiceHost`:

```ts
import type { Registry } from "./registry.js";
import type { RestartOptions, RestartResult } from "./restart.js";
```

```ts
export interface SessionServiceHost {
  registry: Registry;
  runtimeInfo(threadId: string): RuntimeInfo | undefined;
  dropRuntime(threadId: string): Promise<void>;
  archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void>;
  requestRestart(opts: RestartOptions): Promise<RestartResult>;
}
```

- [ ] **Step 2: Implement on `Claudecord`**

In `src/bot.ts`, add imports (top of file):

```ts
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentSha,
  runPreflight,
  writeRestartMarker,
  readRestartMarker,
  clearRestartMarker,
  type RestartOptions,
  type RestartResult,
} from "./restart.js";
```

Note: `join` and `mkdirSync` are already imported in `bot.ts` — do not duplicate them. Add a module-level constant after the imports:

```ts
// src/bot.ts is at <repo>/src/bot.ts, so up two dirs is the repo root.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
```

Add these two methods to the `Claudecord` class (e.g. just before `shutdown`):

```ts
  /**
   * Clean restart shared by /restart, the CLI, and the in-session `restart` tool.
   * Typecheck-gates (unless skipped), posts a note to the requesting thread, writes
   * a marker for the boot confirmation, then exits — launchd (KeepAlive) revives the
   * daemon on the new code. Context survives: sessions resume from sdkSessionId on
   * their next message. The exit is delayed so the caller's reply/tool result flushes.
   */
  async requestRestart(opts: RestartOptions = {}): Promise<RestartResult> {
    const sha = currentSha(REPO_ROOT);
    if (!opts.skipPreflight) {
      const pre = runPreflight(REPO_ROOT);
      if (!pre.ok) return { ok: false, sha, error: pre.output || "typecheck failed" };
    }
    if (opts.threadId) {
      const channel = await this.client.channels.fetch(opts.threadId).catch(() => null);
      if (channel?.isThread()) {
        await channel.send(`🔄 restarting on \`${sha}\`…`).catch(() => undefined);
      }
    }
    try {
      writeRestartMarker({ threadId: opts.threadId, sha, requestedAt: new Date().toISOString() });
    } catch (err) {
      console.error("restart marker write failed:", err); // restart matters more than the confirmation
    }
    setTimeout(() => process.exit(0), opts.exitDelayMs ?? 300).unref();
    return { ok: true, sha };
  }

  /**
   * On boot: if a restart marker is present, post a "back online" confirmation to
   * the thread that requested the restart, then clear it. If the daemon never
   * reaches here (broken new code), the missing confirmation is the health signal.
   */
  async consumeRestartMarker(): Promise<void> {
    const marker = readRestartMarker();
    if (!marker) return;
    clearRestartMarker();
    if (!marker.threadId) return;
    const channel = await this.client.channels.fetch(marker.threadId).catch(() => null);
    if (channel?.isThread()) {
      await channel.send(`✅ back online — running \`${marker.sha}\``).catch(() => undefined);
    }
  }
```

- [ ] **Step 3: Add conformance stubs so typecheck stays green**

In `src/cli.ts`, update `offlineHost` (the CLI never restarts through this path — daemon-down falls back to `start()`):

```ts
export function offlineHost(): SessionServiceHost {
  return {
    registry: new Registry(),
    runtimeInfo: () => undefined,
    dropRuntime: async () => undefined,
    archiveSession: async () => undefined,
    requestRestart: async () => ({ ok: false, sha: "unknown", error: "daemon not running" }),
  };
}
```

In `src/control.test.ts`, update `makeHost` so it records calls and, crucially, does NOT exit:

```ts
type Host = import("./sessions.js").SessionServiceHost;

const restartCalls: any[] = [];
function makeHost(): Host {
  const registry = new Registry();
  return {
    registry,
    runtimeInfo: () => undefined,
    dropRuntime: async () => {},
    archiveSession: async () => {},
    requestRestart: async (opts) => {
      restartCalls.push(opts);
      return { ok: true, sha: "test-sha" };
    },
  };
}
```

Also clear `restartCalls` in the existing `beforeEach` (add `restartCalls.length = 0;`).

- [ ] **Step 4: Verify typecheck and existing tests still pass**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; all existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/bot.ts src/cli.ts src/control.test.ts
git commit -m "feat(restart): requestRestart + boot marker consumption on the app"
```

---

### Task 3: `restart` control command

**Files:**
- Modify: `src/control.ts` (add `restart` case; widen `args` type)
- Test: `src/control.test.ts` (new test)

**Interfaces:**
- Consumes: `SessionServiceHost.requestRestart`.
- Produces: control command `{ cmd: "restart", args?: { force?: boolean } }` → `RestartResult`.

- [ ] **Step 1: Write the failing test**

Add to `src/control.test.ts`:

```ts
test("restart dispatches to the host and reports its result", async () => {
  const res = await request({ cmd: "restart", args: { force: true } });
  expect(res).toMatchObject({ ok: true, data: { ok: true, sha: "test-sha" } });
  expect(restartCalls).toEqual([{ skipPreflight: true, exitDelayMs: 300 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/control.test.ts`
Expected: FAIL — `unknown command: restart`.

- [ ] **Step 3: Implement**

In `src/control.ts`, widen the args type in both `handleControlCommand`'s signature and the `JSON.parse` cast in `startControlServer`, from `{ num?: number }` to `{ num?: number; force?: boolean }`. Then add the case:

```ts
    case "restart":
      return host.requestRestart({ skipPreflight: args?.force, exitDelayMs: 300 });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/control.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control.ts src/control.test.ts
git commit -m "feat(restart): restart command over the control socket"
```

---

### Task 4: Post the confirmation on boot

**Files:**
- Modify: `src/index.ts` (call `consumeRestartMarker` in `ClientReady`)

**Interfaces:**
- Consumes: `Claudecord.consumeRestartMarker`.

No unit test — `ClientReady` needs a live Discord client. Verified by typecheck and the owner's terminal restart test.

- [ ] **Step 1: Add the call**

In `src/index.ts`, inside the `ClientReady` handler, after `app.startScheduler();` and its log line, add:

```ts
  await app.consumeRestartMarker();
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(restart): post back-online confirmation on boot"
```

---

### Task 5: `/restart` slash command

**Files:**
- Modify: `src/commands.ts` (definition + handler + dispatch)

**Interfaces:**
- Consumes: `Claudecord.requestRestart`, `sessionThread` (existing helper).

No unit test — slash handlers need a live interaction. Verified by typecheck; behavior verified by the owner in Discord after the daemon test.

- [ ] **Step 1: Add the command definition**

In `src/commands.ts`, add to the `commandDefinitions` array (after the `kill` command builder):

```ts
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the bot on the latest code (typechecks first; this post resumes automatically)"),
```

- [ ] **Step 2: Add the dispatch case**

In the `switch` inside `handleCommand`, add:

```ts
    case "restart":
      return handleRestart(app, interaction);
```

- [ ] **Step 3: Add the handler**

Add near the other handlers:

```ts
async function handleRestart(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  await interaction.reply({
    content: "🔄 Typechecking, then restarting…",
    flags: MessageFlags.Ephemeral,
  });
  const res = await app.requestRestart({ threadId: thread?.id });
  if (!res.ok) {
    await interaction.editReply(
      `❌ Preflight failed — not restarting:\n\`\`\`\n${res.error?.slice(0, 1800) ?? "typecheck failed"}\n\`\`\``,
    );
    return;
  }
  await interaction.editReply(`✅ Preflight passed. Restarting on \`${res.sha}\` — back in a couple seconds.`);
}
```

Note: on success the daemon exits ~300ms after `requestRestart` returns; the `editReply` above is awaited before that fires, so it lands.

- [ ] **Step 4: Verify typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts
git commit -m "feat(restart): /restart slash command"
```

---

### Task 6: In-session `restart` MCP tool

**Files:**
- Modify: `src/send-file.ts` (add `restart` to `ReminderServices` + a `restart` tool)
- Modify: `src/bot.ts` (wire `restart` in `reminderServices`)
- Modify: `src/session.ts` (mention the tool in the system-prompt append)

**Interfaces:**
- Consumes: `Claudecord.requestRestart`, `RestartResult`.
- Produces: MCP tool `mcp__discord__restart`; `ReminderServices.restart(): Promise<RestartResult>`.

No unit test — the tool calls into the live app and defers a `process.exit`. Verified by typecheck; behavior verified by the owner (ask the in-session Claude to restart after an edit).

- [ ] **Step 1: Extend `ReminderServices`**

In `src/send-file.ts`, add the import and the method:

```ts
import type { RestartResult } from "./restart.js";
```

```ts
export interface ReminderServices {
  ownerId: string | undefined;
  schedule(args: ScheduleArgs): Reminder;
  list(): Reminder[];
  cancel(id: string): boolean;
  pingOwner(text: string): Promise<void>;
  restart(): Promise<RestartResult>;
}
```

- [ ] **Step 2: Add the tool**

In `createDiscordMcpServer`, add to the `tools` array (after `cancel_reminder`):

```ts
      tool(
        "restart",
        "Restart the claudecord bot so your code changes take effect, then resume this " +
          "conversation. Call this ONLY when the user explicitly asks you to restart after you've " +
          "edited claudecord's own source. It typechecks first and refuses to restart if that fails. " +
          "The bot goes down for a couple seconds and comes back on the new code; this post resumes " +
          "automatically and posts a confirmation. Your current turn ends when the restart fires.",
        {},
        async () => {
          const res = await services.restart();
          if (!res.ok) {
            return {
              isError: true,
              content: [{ type: "text", text: `Preflight failed — not restarting:\n${res.error ?? "typecheck failed"}` }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Preflight passed. Restarting on ${res.sha} — back in a couple seconds; this post picks up where we left off.`,
              },
            ],
          };
        },
      ),
```

- [ ] **Step 3: Wire it in `bot.ts`**

In `src/bot.ts`, inside `reminderServices(thread, record)`'s returned object, add:

```ts
      restart: () => this.requestRestart({ threadId: thread.id, exitDelayMs: 1500 }),
```

The 1500ms delay lets the current SDK turn reach its `result` (a ✅ and the `.jsonl` flush recording the edit + restart) before the process exits.

- [ ] **Step 4: Document the tool in the system prompt**

In `src/session.ts`, in `buildQueryOptions`'s `append` string, add one sentence at the end (before the closing backtick):

```ts
        `Call restart to restart the bot on new code after you've edited claudecord's own source and ` +
        `the user asks for it — it typechecks first and this post resumes automatically once it's back.`,
```

- [ ] **Step 5: Verify typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: typecheck exits 0; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/send-file.ts src/bot.ts src/session.ts
git commit -m "feat(restart): in-session restart MCP tool"
```

---

### Task 7: CLI `claudecord restart` via the control socket

**Files:**
- Modify: `src/cli.ts` (rewrite `restart`, add `waitForRespawn`, `--force`, dispatch)

**Interfaces:**
- Consumes: `sendControl`, `daemonPid` (existing), control `restart` command.

No unit test — `cli-offline.test.ts` covers side-effect-free import; the restart path drives launchd. Verified by the owner in a terminal.

- [ ] **Step 1: Replace the `restart` function**

In `src/cli.ts`, replace the existing `restart()` (cli.ts:155-159) with:

```ts
async function restart(force: boolean): Promise<void> {
  try {
    const before = daemonPid();
    const res = await sendControl("restart", { force });
    const data = res.data as { ok: boolean; sha: string; error?: string } | undefined;
    if (!res.ok || !data?.ok) {
      console.error(`preflight failed — not restarting:\n${data?.error ?? res.error ?? "unknown error"}`);
      console.error("re-run with --force to skip the typecheck");
      process.exit(1);
    }
    console.log(`restarting on ${data.sha}… (launchd will bring it back)`);
    await waitForRespawn(before);
    console.log("back up");
  } catch (err) {
    if (!isDaemonDown(err)) throw err;
    console.log("daemon not running — starting it");
    start();
  }
}

/** Poll until launchd hands the daemon a new pid (or we give up). */
function waitForRespawn(oldPid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + 20_000;
    const tick = (): void => {
      const pid = daemonPid();
      if ((pid && pid !== oldPid) || Date.now() > deadline) return resolve();
      setTimeout(tick, 500);
    };
    setTimeout(tick, 800); // wait past the daemon's ~300ms exit delay before polling
  });
}
```

- [ ] **Step 2: Update the dispatch**

In the `if (import.meta.main)` switch, replace the `restart` case:

```ts
    case "restart":
      await restart(process.argv.includes("--force"));
      break;
```

- [ ] **Step 3: Verify typecheck and offline test**

Run: `bun run typecheck && bun test src/cli-offline.test.ts`
Expected: typecheck exits 0; offline test PASSES.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(restart): CLI restart via control socket + --force"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Document the three restart surfaces**

In `README.md`, add a short "Restart" subsection near the CLI command reference and the slash-command list. Cover: `/restart` (in Discord), `claudecord restart` (`--force` to skip the typecheck), and that the in-session assistant can restart itself with the `restart` tool after editing code when you ask. State that conversations resume automatically (context is preserved via `sdkSessionId`) and that a broken typecheck blocks the restart. Keep it to a few lines matching the existing README voice.

- [ ] **Step 2: Verify docs render**

Run: `grep -n "restart" README.md`
Expected: the new subsection appears.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the restart surfaces"
```

---

## Post-implementation (owner, in a terminal — NOT from a live session)

1. `bun run typecheck && bun test` — full green.
2. From a terminal, `claudecord restart` — confirm it typechecks, the daemon gets a new pid, and it reports "back up".
3. In Discord, in a session post, run `/restart` — confirm the "🔄 restarting" and "✅ back online" messages appear and the conversation still has context on the next message.
4. In a session, edit a trivial comment in `src/`, ask the assistant to restart itself — confirm the `restart` tool runs, the post resumes, and the confirmation lands.
5. Update the memory note `claudecord-daemon-self-restart-hazard.md`: the detached double-fork/Python restarter is now obsolete — the clean path is `requestRestart` (self-exit + launchd `KeepAlive`).

## Self-Review

- **Spec coverage:** shared `requestRestart` (T2); preflight gate (T1 `runPreflight` + T2 gate, `--force` in T3/T7, tool/​slash gated); deterministic flush via awaited sends + exit delay (T2/T5/T6); marker + boot confirmation (T1/T2/T4); three surfaces (T3 CLI plumbing, T5 slash, T6 tool); double-fork removed (T7); busy-session option A = immediate exit, no drain logic added (by omission — matches decision). All spec sections map to a task.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `RestartResult { ok, sha, error? }` and `RestartOptions { threadId?, skipPreflight?, exitDelayMs? }` defined in T1 and used identically in `SessionServiceHost` (T2), control (T3), slash (T5), tool/`ReminderServices` (T6), CLI cast (T7). `requestRestart` signature identical across interface + impl + callers.
