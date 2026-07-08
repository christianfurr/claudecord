# Discord handoff — design

**Date:** 2026-07-08
**Status:** approved for planning

## Problem

A Claude Code session started in a terminal (`claude`) has no way to continue in
Discord. If the user needs to leave their machine, the conversation is stranded.
Claudecord already runs sessions through the Agent SDK and can resume by session
id — but only for sessions it started itself. This feature lets a *terminal*
session be handed off to Discord mid-conversation.

## Scope

- **In scope:** one-way baton pass. The user invokes an MCP tool from the terminal
  session; a Discord forum post appears that continues that conversation's history.
- **Out of scope (for now):** round-trip (coming *back* to the terminal after Discord
  changed things). The terminal session is considered abandoned once handed off.

## Mechanism this hinges on (verified)

Terminal `claude` and claudecord's SDK read/write the same session store:
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, keyed by working directory.

- The SDK `resume` option **continues the same session id** (appends to the same
  `.jsonl`) by default — `sdk.d.ts:1761`.
- `forkSession: true` makes a resumed session **branch to a new session id** rather
  than continuing the previous one — `sdk.d.ts:1457`.

**Decision:** handoff uses `resume: <terminalSessionId>` **with `forkSession: true`**.
Discord gets a fresh session id branched from the terminal's history; the terminal's
original `.jsonl` is never written to. This removes any shared-file write conflict,
even if the terminal process is still alive when the Discord side starts.

Session-id discovery: an MCP tool is **not** reliably handed the calling session's id
(no confirmed `CLAUDE_SESSION_ID` env var for stdio MCP servers). Instead the MCP
server finds the **most-recently-modified `.jsonl`** in the current cwd's project dir,
which is the live session. This is verifiable and needs no undocumented plumbing.

## Architecture

Three components.

### 1. `claudecord mcp` — standalone stdio MCP server

A new subcommand/bin that runs an MCP stdio server (via `@modelcontextprotocol/sdk`).
Registered once in the user's Claude Code config so every terminal session loads it.

Exposes one tool:

```
handoff_to_discord(title?: string)
```

On call:
1. `cwd = process.env.CLAUDECORD_HANDOFF_CWD ?? process.cwd()`.
2. Encode cwd the way Claude Code does (`/` → `-`) to locate
   `~/.claude/projects/<encoded-cwd>/`.
3. Pick the newest `*.jsonl` there → `sessionId` = filename without extension.
   If none found, return an error telling the user to run a turn first.
4. `title = title ?? "<cwd basename> (handoff)"`.
5. Write `~/.claudecord/handoffs/<sessionId>.json`:
   `{ sessionId, cwd, title, createdAt }` (write to `.tmp` then rename, like the
   registry does, so the watcher never sees a partial file).
6. Return: "Handoff queued — a Discord post will appear shortly. You can leave;
   continue the conversation from Discord."

Paths come from `config.ts` (`CONFIG_DIR`), so the server and bot agree on locations.

### 2. Handoff watcher in the bot

The persistent bot (`Claudecord`) watches `~/.claudecord/handoffs/`:
- **On startup:** process any pending files (a handoff fired while the bot was down
  still lands).
- **On new file** (`fs.watch`): read + validate it, then:
  1. Create a forum post — same path as `createSessionPost` (bot.ts:119):
     `forum.threads.create({ name: title, message: { content: <intro> } })`, apply
     the active tag.
  2. `registry.create(thread.id, title)`, then `registry.update` to set
     `sdkSessionId = <terminal sessionId>` and `cwd = <handoff cwd>`.
  3. Spin a `SessionRuntime` with `resumeSessionId = sessionId` and the new
     `forkSession: true` flag (see component 3).
  4. Post an intro line in the thread: "↩ Continued from your terminal session.
     Send a message to pick up where you left off."
  5. Delete the handoff file.

  Do **not** feed a prompt automatically — the user's first Discord message becomes
  the next turn (the existing `messageCreate` handler already does this once the
  record + runtime exist).

Errors (missing forum config, thread create fails) are logged and the handoff file
is moved to `handoffs/failed/` rather than silently deleted, so nothing is lost.

### 3. Per-session cwd + fork support

Small changes so a resumed session runs in the terminal's directory and forks:

- `registry.ts`: add optional `cwd?: string` to `SessionRecord`.
- `session.ts`: 
  - `SessionRuntime` gains a `forkSession` option (defaults false).
  - SDK `options.cwd = record.cwd ?? settings.workDir`.
  - When resuming, pass `forkSession: this.forkSession` alongside `resume`.
- `bot.ts` `ensureRuntime`: thread the `forkSession` flag through for handoff-created
  runtimes (normal sessions keep `forkSession` false — claudecord's own revival
  should continue the same id, as today).

## Data flow (baton pass)

```
terminal `claude` session (cwd = /Users/.../proj, session S)
  │  user: "hand this off"
  │  Claude calls handoff_to_discord()
  ▼
claudecord mcp server (child of terminal claude)
  │  finds newest .jsonl in ~/.claude/projects/<enc>/ → S
  │  writes ~/.claudecord/handoffs/S.json {S, cwd, title}
  ▼
claudecord bot (persistent, watching handoffs/)
  │  creates forum post, registers session (sdkSessionId=S, cwd)
  │  SessionRuntime(resume=S, forkSession=true) → new id S'
  │  posts "↩ Continued from your terminal session"
  ▼
Discord post is live; user sends a message → turn runs on S' (history from S)
terminal session S is abandoned; its .jsonl is untouched
```

## Setup / registration

- `claudecord mcp` documented in the README as a one-time `claude mcp add` (or a
  user-settings snippet) so terminal sessions load the server.
- The bot needs `forumChannelId` configured (`/setup`) — same prerequisite as `/new`.

## Edge cases

| Case | Handling |
|------|----------|
| No `.jsonl` in cwd (no turn run yet) | MCP tool returns an error; no file written. |
| Bot down when handoff fires | File waits; processed on next bot startup. |
| Forum not configured | Handoff file moved to `handoffs/failed/`, logged; MCP tool already returned success, so surface nothing to terminal. |
| Duplicate handoff for same session id | Filename keyed by session id; a second write overwrites. Watcher processes once. |
| Terminal session still running after handoff | `forkSession: true` → no shared write; the two diverge harmlessly. |
| cwd's project dir uses a different encoding than assumed | Encoding is verified against a real path during implementation; fall back to erroring rather than guessing a wrong session. |

## Testing

- **Unit:** newest-`.jsonl` discovery (empty dir, one file, several with different
  mtimes); cwd→project-dir encoding; handoff-file read/validate (malformed JSON,
  missing fields).
- **Behavior:** watcher creates a post + runtime from a dropped file; startup drains
  pending files; failed handoffs land in `failed/`.
- **Integration (manual):** run a real terminal `claude` turn, invoke
  `handoff_to_discord`, confirm a Discord post appears and continues the conversation;
  confirm the terminal `.jsonl` is unchanged (fork worked).

## New/changed files

- `src/mcp.ts` (new) — the stdio MCP server + `handoff_to_discord` tool.
- `src/handoffs.ts` (new) — watcher + handoff-file read/write/validate (keeps `bot.ts`
  focused).
- `src/cli.ts` — wire up the `claudecord mcp` subcommand.
- `src/registry.ts` — add `cwd?` to `SessionRecord`.
- `src/session.ts` — `forkSession` option + per-session cwd.
- `src/bot.ts` — construct/watch the handoff queue; thread `forkSession` through.
- `package.json` — add `@modelcontextprotocol/sdk`.
- `README.md` — setup + usage.
