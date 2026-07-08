# Discord Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a terminal `claude` session be continued in Discord via an MCP tool — a one-way baton pass that spins up a claudecord forum post resuming that conversation's history.

**Architecture:** A standalone stdio MCP server (`claudecord mcp`) runs as a child of the terminal session; its `handoff_to_discord` tool locates the live session's `.jsonl` and drops a request file in `~/.claudecord/handoffs/`. The persistent bot watches that directory, creates a forum post, and spins a `SessionRuntime` that resumes the terminal session id with `forkSession: true` (branches a new id, leaves the terminal's file untouched).

**Tech Stack:** Bun, TypeScript (strict), discord.js v14, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, zod, `bun:test`.

## Global Constraints

- Runtime is **Bun**; tests use `bun:test` and run with `bun test <file>`.
- Config/state root is `CONFIG_DIR` from `src/config.ts` (`~/.claudecord`, overridable via `CLAUDECORD_HOME`). Never hardcode the path — import `CONFIG_DIR`.
- All persistent files are written atomically (write `<file>.tmp`, then `renameSync`), matching `registry.ts`.
- Modules are ESM with `.js` import specifiers (e.g. `import { CONFIG_DIR } from "./config.js"`).
- TypeScript is strict; `bun run typecheck` (`tsc --noEmit`) must pass with zero errors.
- The Claude Code session store lives at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` is the absolute cwd with `/` and `.` replaced by `-`.
- `forkSession: true` is used **only** for the initial handoff runtime. Normal session revival keeps `forkSession` false (continues the same id, unchanged from today).

---

## File Structure

- `src/registry.ts` — **modify.** Add optional `cwd` to `SessionRecord`.
- `src/session.ts` — **modify.** Extract `buildQueryOptions` (pure, testable); add `forkSession` + per-session cwd.
- `src/session-options.test.ts` — **create.** Unit tests for `buildQueryOptions`.
- `src/handoffs.ts` — **create.** Handoff types, cwd encoding, latest-session discovery, atomic read/write.
- `src/handoffs.test.ts` — **create.** Unit tests for the above.
- `src/mcp.ts` — **create.** The stdio MCP server and the testable `runHandoff` core.
- `src/mcp.test.ts` — **create.** Unit tests for `runHandoff`.
- `src/cli.ts` — **modify.** Add the `mcp` subcommand.
- `src/bot.ts` — **modify.** `forkSession`-aware `ensureRuntime`; `createHandoffPost`; `startHandoffWatcher` (startup drain + `fs.watch`).
- `src/index.ts` — **modify.** Start the handoff watcher after login.
- `package.json` — **modify.** Add `@modelcontextprotocol/sdk`.
- `README.md` — **modify.** Setup + usage.

---

### Task 1: Add `cwd` to the session record

**Files:**
- Modify: `src/registry.ts:9-20`
- Test: `src/registry.test.ts` (existing)

**Interfaces:**
- Produces: `SessionRecord.cwd?: string` — the working directory a handed-off session must run in. Consumed by Task 2 (`buildQueryOptions`) and Task 5 (`createHandoffPost`).

- [ ] **Step 1: Write the failing test**

Add to `src/registry.test.ts`:

```typescript
test("update stores a per-session cwd", () => {
  reg.create("t-a", "alpha");
  const updated = reg.update("t-a", { cwd: "/Users/me/proj" });
  expect(updated.cwd).toBe("/Users/me/proj");
  expect(reg.get("t-a")?.cwd).toBe("/Users/me/proj");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/registry.test.ts`
Expected: FAIL — TypeScript rejects `cwd` as it's not on `SessionRecord` (the `update` patch type excludes unknown keys).

- [ ] **Step 3: Add the field**

In `src/registry.ts`, add to the `SessionRecord` interface after the `model` field (line 18):

```typescript
  /** Per-session working directory (set for handed-off terminal sessions); falls back to settings.workDir. */
  cwd?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/registry.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts src/registry.test.ts
git commit -m "feat(registry): add per-session cwd field"
```

---

### Task 2: Make the SDK options pure, add forkSession + per-session cwd

**Files:**
- Modify: `src/session.ts:118-151`
- Create: `src/session-options.test.ts`

**Interfaces:**
- Consumes: `SessionRecord.cwd` (Task 1).
- Produces:
  - `buildQueryOptions(record: SessionRecord, settings: Settings, resumeSessionId?: string, forkSession?: boolean): Options` — pure builder for the Agent SDK options. Uses `record.cwd ?? settings.workDir` as `cwd`; when `resumeSessionId` is set, includes `resume: resumeSessionId` and `forkSession`.
  - `SessionRuntime` constructor gains a 6th parameter `forkSession = false`. Consumed by Task 5 via `ensureRuntime`.

- [ ] **Step 1: Write the failing test**

Create `src/session-options.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/session-options.test.ts`
Expected: FAIL — `buildQueryOptions` is not exported from `session.js`.

- [ ] **Step 3: Extract the builder and thread forkSession through**

In `src/session.ts`, add this exported function above the `SessionRuntime` class (after the imports / `UserContent` type, around line 100):

```typescript
/** Build the Agent SDK options for a session. Pure — safe to unit test. */
export function buildQueryOptions(
  record: SessionRecord,
  settings: Settings,
  resumeSessionId?: string,
  forkSession = false,
): Options {
  const model = record.model ?? settings.model;
  return {
    cwd: record.cwd ?? settings.workDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user"],
    ...(model ? { model } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId, forkSession } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        `You are connected to Discord through claudecord. This conversation is a Discord ` +
        `forum post titled "${record.title}". Everything you write is delivered to the post ` +
        `automatically — never try to send Discord messages yourself. Discord renders ` +
        `markdown but not tables-heavy layouts; keep replies conversational and reasonably ` +
        `concise. Your tool activity is mirrored to the post as a live feed.`,
    },
  };
}
```

Then replace the constructor's inline options block. Change the constructor signature (line 118-124) to add `forkSession`:

```typescript
  constructor(
    private thread: AnyThreadChannel,
    private record: SessionRecord,
    private registry: Registry,
    settings: Settings,
    resumeSessionId?: string,
    forkSession = false,
  ) {
    this.feed = new ActivityFeed(thread);
    const model = record.model ?? settings.model;
    this.stats.model = model;
    const options = buildQueryOptions(record, settings, resumeSessionId, forkSession);
    this.q = query({ prompt: this.queue, options });
    void this.consume();
  }
```

(Delete the old inline `const options: Options = { ... }` block — `buildQueryOptions` replaces it. Keep the `this.stats.model = model;` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/session-options.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/session.ts src/session-options.test.ts
git commit -m "feat(session): extract buildQueryOptions, add forkSession + per-session cwd"
```

---

### Task 3: Handoff module — types, cwd encoding, session discovery, atomic I/O

**Files:**
- Create: `src/handoffs.ts`
- Create: `src/handoffs.test.ts`

**Interfaces:**
- Produces (all consumed by Tasks 4 and 5):
  - `HandoffRequest = { sessionId: string; cwd: string; title: string; createdAt: string }`
  - `HANDOFF_DIR: string`, `HANDOFF_FAILED_DIR: string`
  - `encodeProjectDir(cwd: string): string`
  - `findLatestSessionId(cwd: string, home?: string): string` — throws if the project dir or any `.jsonl` is missing.
  - `writeHandoff(req: HandoffRequest, dir?: string): string` — atomic write, returns the file path.
  - `readHandoff(path: string): HandoffRequest` — throws on malformed/invalid JSON.

- [ ] **Step 1: Write the failing test**

Create `src/handoffs.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-ho-"));
const {
  encodeProjectDir,
  findLatestSessionId,
  writeHandoff,
  readHandoff,
} = await import("./handoffs.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-home-"));
});

test("encodeProjectDir replaces slashes and dots with dashes", () => {
  expect(encodeProjectDir("/Users/me/Code/proj")).toBe("-Users-me-Code-proj");
  expect(encodeProjectDir("/Users/me/.config/x")).toBe("-Users-me--config-x");
});

test("findLatestSessionId returns the newest jsonl's id", () => {
  const cwd = "/Users/me/proj";
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "{}");
  writeFileSync(join(dir, "new.jsonl"), "{}");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "old.jsonl"), past, past);
  expect(findLatestSessionId(cwd, home)).toBe("new");
});

test("findLatestSessionId throws when the project dir is absent", () => {
  expect(() => findLatestSessionId("/nope/missing", home)).toThrow();
});

test("findLatestSessionId throws when there are no jsonl files", () => {
  const cwd = "/Users/me/empty";
  mkdirSync(join(home, ".claude", "projects", encodeProjectDir(cwd)), { recursive: true });
  expect(() => findLatestSessionId(cwd, home)).toThrow();
});

test("writeHandoff then readHandoff round-trips", () => {
  const dir = join(home, "handoffs");
  const req = { sessionId: "s1", cwd: "/x", title: "t", createdAt: "now" };
  const path = writeHandoff(req, dir);
  expect(existsSync(path)).toBe(true);
  expect(readHandoff(path)).toEqual(req);
});

test("readHandoff throws on malformed JSON", () => {
  const dir = join(home, "handoffs");
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  expect(() => readHandoff(bad)).toThrow();
});

test("readHandoff throws when a required field is missing", () => {
  const dir = join(home, "handoffs");
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "partial.json");
  writeFileSync(bad, JSON.stringify({ sessionId: "s1" }));
  expect(() => readHandoff(bad)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/handoffs.test.ts`
Expected: FAIL — cannot import from `./handoffs.js` (module does not exist).

- [ ] **Step 3: Implement the module**

Create `src/handoffs.ts`:

```typescript
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
} from "node:fs";
import { z } from "zod";
import { CONFIG_DIR } from "./config.js";

export const HANDOFF_DIR = join(CONFIG_DIR, "handoffs");
export const HANDOFF_FAILED_DIR = join(HANDOFF_DIR, "failed");

const handoffSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().min(1),
});

export type HandoffRequest = z.infer<typeof handoffSchema>;

/** Encode an absolute cwd the way Claude Code names its project dir: "/" and "." → "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Return the session id of the most-recently-modified `.jsonl` in the Claude Code
 * project dir for `cwd` — i.e. the live session. Throws if the dir or any jsonl
 * is missing (nothing to hand off).
 */
export function findLatestSessionId(cwd: string, home = homedir()): string {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  if (!existsSync(dir)) {
    throw new Error(`No Claude project directory for ${cwd} (looked in ${dir}). Run a turn first.`);
  }
  const jsonl = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (jsonl.length === 0) {
    throw new Error(`No session files in ${dir}. Run a turn first.`);
  }
  return jsonl[0].f.replace(/\.jsonl$/, "");
}

/** Atomically write a handoff request; returns the file path. */
export function writeHandoff(req: HandoffRequest, dir = HANDOFF_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${req.sessionId}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(req, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

/** Read + validate a handoff file. Throws on malformed JSON or missing fields. */
export function readHandoff(path: string): HandoffRequest {
  return handoffSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Move a handoff file into the failed/ subdir (never silently drop a request). */
export function quarantineHandoff(path: string): void {
  mkdirSync(HANDOFF_FAILED_DIR, { recursive: true });
  renameSync(path, join(HANDOFF_FAILED_DIR, `${Date.now()}-${basenameOf(path)}`));
}

function basenameOf(path: string): string {
  return path.slice(dirname(path).length + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/handoffs.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/handoffs.ts src/handoffs.test.ts
git commit -m "feat(handoffs): session discovery + atomic handoff-file I/O"
```

---

### Task 4: MCP server + `claudecord mcp` subcommand

**Files:**
- Modify: `package.json` (add `@modelcontextprotocol/sdk`)
- Create: `src/mcp.ts`
- Create: `src/mcp.test.ts`
- Modify: `src/cli.ts` (add `mcp` case + usage line)

**Interfaces:**
- Consumes: `findLatestSessionId`, `writeHandoff`, `HandoffRequest` (Task 3).
- Produces:
  - `runHandoff(opts: { cwd: string; title?: string; home?: string; now?: string }): { message: string; path: string }` — pure-ish core: discovers the session, writes the handoff file, returns the user-facing message. Consumed by the MCP tool and unit-tested directly.
  - `startMcpServer(): Promise<void>` — wires `runHandoff` into a stdio MCP server.

- [ ] **Step 1: Add the dependency**

Run:

```bash
cd /Users/christianfurr/Code/claudecord && bun add @modelcontextprotocol/sdk
```

Expected: `package.json` gains `@modelcontextprotocol/sdk` under `dependencies`; `bun.lock` updates.

- [ ] **Step 2: Write the failing test**

Create `src/mcp.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDECORD_HOME = mkdtempSync(join(tmpdir(), "cc-mcp-"));
const { runHandoff } = await import("./mcp.js");
const { encodeProjectDir, readHandoff } = await import("./handoffs.js");

let home: string;
let handoffDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-home-"));
  handoffDir = mkdtempSync(join(tmpdir(), "cc-hdir-"));
});

function seedSession(cwd: string): void {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "abc-123.jsonl"), "{}");
}

test("runHandoff writes a handoff file for the live session", () => {
  const cwd = "/Users/me/proj";
  seedSession(cwd);
  const res = runHandoff({ cwd, title: "my task", home, now: "T", dir: handoffDir });
  expect(existsSync(res.path)).toBe(true);
  const req = readHandoff(res.path);
  expect(req.sessionId).toBe("abc-123");
  expect(req.cwd).toBe(cwd);
  expect(req.title).toBe("my task");
  expect(res.message).toContain("Discord");
});

test("runHandoff derives a title from the cwd basename when none given", () => {
  const cwd = "/Users/me/proj";
  seedSession(cwd);
  const res = runHandoff({ cwd, home, now: "T", dir: handoffDir });
  expect(readHandoff(res.path).title).toBe("proj (handoff)");
});

test("runHandoff throws when there is no session to hand off", () => {
  expect(() => runHandoff({ cwd: "/nope", home, now: "T", dir: handoffDir })).toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/mcp.test.ts`
Expected: FAIL — cannot import from `./mcp.js`.

- [ ] **Step 4: Implement the MCP server**

Create `src/mcp.ts`:

```typescript
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findLatestSessionId, writeHandoff, HANDOFF_DIR } from "./handoffs.js";

interface RunHandoffOpts {
  cwd: string;
  title?: string;
  home?: string;
  now?: string;
  dir?: string;
}

/** Core of the handoff tool: find the live session, queue a handoff file. */
export function runHandoff(opts: RunHandoffOpts): { message: string; path: string } {
  const cwd = opts.cwd;
  const home = opts.home ?? homedir();
  const sessionId = findLatestSessionId(cwd, home);
  const title = opts.title?.trim() || `${cwd.split("/").filter(Boolean).pop() ?? "session"} (handoff)`;
  const path = writeHandoff(
    { sessionId, cwd, title, createdAt: opts.now ?? new Date().toISOString() },
    opts.dir ?? HANDOFF_DIR,
  );
  return {
    message:
      "Handoff queued — a Discord post will appear shortly and continue this conversation. " +
      "You can leave; pick it back up from Discord.",
    path,
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "claudecord", version: "0.1.0" });

  server.tool(
    "handoff_to_discord",
    "Continue this Claude Code session in Discord (claudecord). Call when the user wants to " +
      "leave their machine and keep the conversation going from Discord. Creates a Discord " +
      "forum post that resumes this conversation's history.",
    { title: z.string().optional().describe("Optional title for the Discord post.") },
    async ({ title }) => {
      try {
        const { message } = runHandoff({ cwd: process.env.CLAUDECORD_HANDOFF_CWD ?? process.cwd(), title });
        return { content: [{ type: "text", text: message }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Handoff failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/mcp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the CLI subcommand**

In `src/cli.ts`, add a case to the switch (after the `run` case, around line 341):

```typescript
    case "mcp": {
      const { startMcpServer } = await import("./mcp.js");
      await startMcpServer();
      break;
    }
```

And update the usage string (line 359-361) to include `mcp`:

```typescript
      console.log(
        "claudecord <install|uninstall|start|stop|restart|status|logs|run|mcp|owner|sessions|end|kill|prune>",
      );
```

- [ ] **Step 7: Verify the server starts and speaks MCP**

Run:

```bash
cd /Users/christianfurr/Code/claudecord && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | bun src/cli.ts mcp
```

Expected: a single JSON-RPC response line containing `"serverInfo"` with `"name":"claudecord"`, then the process waits on stdin (Ctrl-C to exit).

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock src/mcp.ts src/mcp.test.ts src/cli.ts
git commit -m "feat(mcp): handoff_to_discord tool + claudecord mcp subcommand"
```

---

### Task 5: Bot watcher — create the post and resume with fork

**Files:**
- Modify: `src/bot.ts` (`ensureRuntime`, new `createHandoffPost`, new `startHandoffWatcher`)
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `HandoffRequest`, `readHandoff`, `quarantineHandoff`, `HANDOFF_DIR` (Task 3); `SessionRecord.cwd` (Task 1); `forkSession` param of `SessionRuntime` (Task 2); existing `createSessionPost` pattern (`bot.ts:119`).
- Produces:
  - `ensureRuntime(thread, record, opts?: { fresh?: boolean; forkSession?: boolean })` — signature change (callers updated below).
  - `createHandoffPost(req: HandoffRequest): Promise<void>` — creates the forum post, registers the session with the terminal id + cwd, and pre-creates a forked runtime.
  - `startHandoffWatcher(): void` — drains pending files on startup, then watches `HANDOFF_DIR`.

- [ ] **Step 1: Update `ensureRuntime` to accept a forkSession option**

In `src/bot.ts`, replace `ensureRuntime` (lines 92-104) with:

```typescript
  ensureRuntime(
    thread: AnyThreadChannel,
    record: SessionRecord,
    opts: { fresh?: boolean; forkSession?: boolean } = {},
  ): SessionRuntime {
    const existing = this.runtimes.get(thread.id);
    if (existing && !opts.fresh) return existing;
    const runtime = new SessionRuntime(
      thread,
      record,
      this.registry,
      this.settings,
      opts.fresh ? undefined : record.sdkSessionId,
      opts.forkSession ?? false,
    );
    this.runtimes.set(thread.id, runtime);
    return runtime;
  }
```

Then fix the one existing caller that passed `fresh` positionally. Search for `ensureRuntime(` — if any call site passes `true` as the third argument (e.g. in `commands.ts` for a `/clear`-style fresh restart), change it to `{ fresh: true }`. Run:

```bash
grep -rn "ensureRuntime(" src/
```

Update every call that passed a positional `true` to `{ fresh: true }`. Calls with two arguments need no change.

- [ ] **Step 2: Typecheck to confirm all callers are updated**

Run: `bun run typecheck`
Expected: no errors. If any `ensureRuntime` call still passes a boolean, fix it to `{ fresh: true }`.

- [ ] **Step 3: Add `createHandoffPost` and `startHandoffWatcher`**

In `src/bot.ts`, add imports at the top (extend the existing `node:fs` import and add the handoffs import):

```typescript
import { chmodSync, mkdirSync, writeFileSync, readdirSync, watch } from "node:fs";
```
```typescript
import { readHandoff, quarantineHandoff, HANDOFF_DIR, type HandoffRequest } from "./handoffs.js";
```

Add these two methods to the `Claudecord` class (after `createSessionPost`, around line 136):

```typescript
  /**
   * Create a session post that resumes a terminal Claude session (handoff).
   * Forks a new session id from the terminal's history so the terminal's own
   * .jsonl is never written to. No prompt is sent — the user's first Discord
   * message becomes the next turn.
   */
  async createHandoffPost(req: HandoffRequest): Promise<void> {
    if (!this.settings.forumChannelId) throw new Error("No forum configured — run /setup first.");
    const forum = await this.client.channels.fetch(this.settings.forumChannelId);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      throw new Error("Configured forum channel is missing — re-run /setup.");
    }
    const thread = await forum.threads.create({
      name: req.title.slice(0, 100),
      message: { content: "↩ Continued from your terminal session. Send a message to pick up where you left off." },
      appliedTags: this.settings.tagActiveId ? [this.settings.tagActiveId] : [],
    });
    this.registry.get(thread.id) ?? this.registry.create(thread.id, req.title);
    const record = this.registry.update(thread.id, { sdkSessionId: req.sessionId, cwd: req.cwd });
    // Pre-create the runtime with forkSession so the resume branches a new id
    // (recorded via system:init) before any turn touches the terminal's file.
    this.ensureRuntime(thread, record, { forkSession: true });
  }

  /** Drain any pending handoff files, then watch the directory for new ones. */
  startHandoffWatcher(): void {
    mkdirSync(HANDOFF_DIR, { recursive: true });
    for (const name of readdirSync(HANDOFF_DIR)) {
      if (name.endsWith(".json")) void this.processHandoffFile(join(HANDOFF_DIR, name));
    }
    watch(HANDOFF_DIR, (_event, filename) => {
      if (filename && filename.endsWith(".json")) {
        void this.processHandoffFile(join(HANDOFF_DIR, filename));
      }
    });
  }

  private async processHandoffFile(path: string): Promise<void> {
    let req: HandoffRequest;
    try {
      req = readHandoff(path);
    } catch {
      return; // partial write / .tmp rename in flight, or already processed — ignore
    }
    try {
      await this.createHandoffPost(req);
      unlinkSync(path);
    } catch (err) {
      console.error("handoff failed:", err);
      try {
        quarantineHandoff(path);
      } catch {
        /* file may already be gone */
      }
    }
  }
```

Add `unlinkSync` to the `node:fs` import from Step 3:

```typescript
import { chmodSync, mkdirSync, writeFileSync, readdirSync, watch, unlinkSync } from "node:fs";
```

- [ ] **Step 4: Start the watcher after login**

In `src/index.ts`, find where the bot logs in and is marked ready. After the client is ready (the `once("ready", ...)` / post-login block), call `bot.startHandoffWatcher()`. Open the file to place it correctly:

Run: `grep -n "ready\|login\|new Claudecord\|startControl" src/index.ts`

Add `bot.startHandoffWatcher();` immediately after the bot has logged in and the control socket / ready handling is set up (same place other post-login startup runs). Example shape:

```typescript
await bot.client.login(getDiscordToken());
bot.startHandoffWatcher();
```

Match the actual variable name used in `index.ts` (likely `bot` or `app`).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: all tests pass (registry, session-options, handoffs, mcp, plus existing control/sessions/cli-offline).

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts src/index.ts
git commit -m "feat(bot): watch handoff queue and resume terminal sessions with fork"
```

---

### Task 6: End-to-end manual verification + README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Register the MCP server for terminal sessions**

Run:

```bash
claude mcp add --scope user claudecord -- claudecord mcp
```

(Assumes `bun link` has put `claudecord` on PATH, per the README quick start. If not, use the absolute form: `claude mcp add --scope user claudecord -- bun /Users/christianfurr/Code/claudecord/src/cli.ts mcp`.)

Verify: `claude mcp list` shows `claudecord`.

- [ ] **Step 2: Confirm the daemon is running with the new code**

Run:

```bash
claudecord restart && claudecord status
```

Expected: `● running (pid …)`.

- [ ] **Step 3: Drive the full handoff and confirm the fork**

1. In a terminal, `cd` into a project dir and run `claude`; complete one real turn (so a `.jsonl` exists).
2. Note the current session file: `ls -t ~/.claude/projects/<encoded-cwd>/*.jsonl | head -1` — record its name (this is the terminal session id) and its size.
3. In the `claude` session, ask it to call the `handoff_to_discord` tool.
4. Confirm a new Discord forum post appears in the configured channel with the "↩ Continued from your terminal session" message.
5. Send a message in the Discord post; confirm Claude responds *with the terminal conversation's context* (reference something said in the terminal).
6. Re-check the terminal session file from step 2: its size/mtime is **unchanged** (fork worked — Discord wrote to a new id). Confirm a *new* `.jsonl` appeared for the forked session.

Record the outcome (pass/fail with specifics) before proceeding.

- [ ] **Step 4: Document setup + usage in the README**

In `README.md`, add a section (place it after the Commands section):

```markdown
## Continue a terminal session in Discord

Hand off a Claude Code session running in your terminal to Discord — useful when you
need to leave your machine mid-task.

**One-time setup** — register claudecord's MCP server so every terminal session can reach it:

​```bash
claude mcp add --scope user claudecord -- claudecord mcp
​```

**Usage** — in any terminal `claude` session, ask Claude to hand off (it calls the
`handoff_to_discord` tool). A new forum post appears in your claudecord channel that
continues the same conversation. Send a message there to pick up where you left off.

The handoff is a one-way baton pass: it forks a new session id from your terminal
session's history, so the Discord side and your (now-abandoned) terminal session never
write to the same file. The bot must be running (`claudecord status`); a handoff fired
while it's down is processed when it next starts.
```

(The `​` before each triple-backtick above is a zero-width space to keep this fenced block intact — remove it; the README should contain plain ```` ```bash ```` fences.)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document Discord handoff (claudecord mcp)"
```

---

## Self-Review

**Spec coverage:**
- MCP server + `handoff_to_discord` tool → Task 4. ✓
- Newest-`.jsonl` discovery → Task 3 (`findLatestSessionId`). ✓
- Handoff file drop → Task 3 (`writeHandoff`), Task 4 (`runHandoff`). ✓
- Bot watcher + startup drain → Task 5 (`startHandoffWatcher`). ✓
- Forum post creation reusing `createSessionPost` pattern → Task 5 (`createHandoffPost`). ✓
- `resume` + `forkSession: true` → Task 2 (`buildQueryOptions`), Task 5 (`ensureRuntime({ forkSession: true })`). ✓
- Per-session cwd → Task 1 (`SessionRecord.cwd`), Task 2 (`buildQueryOptions`). ✓
- Failed handoffs quarantined → Task 3 (`quarantineHandoff`), Task 5 (`processHandoffFile`). ✓
- Setup/registration docs → Task 6. ✓
- Edge cases (no jsonl, bot down, forum unconfigured, terminal still alive) → covered across Tasks 3/5 and verified in Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one soft spot — the exact insertion point in `index.ts` (Task 5 Step 4) — is bounded by a `grep` and a concrete example, because the file wasn't read in full during planning; the implementer confirms the variable name and post-login location.

**Type consistency:** `HandoffRequest` shape identical across handoffs.ts, mcp.ts, bot.ts. `ensureRuntime(thread, record, { fresh?, forkSession? })` used consistently after Task 5 Step 1. `buildQueryOptions(record, settings, resumeSessionId?, forkSession?)` matches its call in the `SessionRuntime` constructor. `findLatestSessionId(cwd, home?)` and `runHandoff({ cwd, title?, home?, now?, dir? })` signatures match their tests.

**Known limitation (documented, not built):** if the bot crashes in the millisecond window between `createHandoffPost` creating the runtime and the SDK emitting `system:init` with the forked id, a restart would resume the terminal id without forking. Window is tiny and requires a crash mid-handoff; deferred rather than adding a persisted `forkPending` flag (YAGNI for v1).
