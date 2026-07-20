# Restart Process — Design

**Date:** 2026-07-17
**Status:** Approved, ready for implementation plan
**Branch:** `feat/restart-process`

## Summary

Give claudecord a clean, non-hacky way to restart the daemon on new code while
keeping every conversation's context. Conversation context is already durable —
each session's `sdkSessionId` is persisted to `sessions.json` and the Agent SDK
keeps full history in its `.jsonl` files, so a session resumes from
`sdkSessionId` on its next message (session.ts:130, bot.ts:115). What's missing
is a clean *mechanism*: today the only safe self-restart is a detached
double-fork Python script that `os.setsid()`s, sleeps 6s, then
`launchctl kickstart -k`. That hack exists only because a restart command
spawned as a child of the daemon dies with the daemon before it can relaunch it.

The launchd job already runs with `KeepAlive=true` + `RunAtLoad=true`
(cli.ts:92-93). So the daemon can simply `process.exit(0)` and launchd respawns
it on the new code within ~1-3s. No double-fork, no Python, no sleep, no
self-`kickstart`. That hack is deleted.

## Goals

- One shared restart path triggerable three ways: `/restart` slash command,
  `claudecord restart` CLI, and an in-session `restart` MCP tool the model can
  call after editing code when the user tells it to.
- Deterministic flush of a "restarting…" note before exit (await the send, no
  `sleep`).
- launchd revives the daemon; conversations resume with full context on their
  next message (already how resume works).
- A boot-time confirmation posted back to the thread that requested the restart
  ("✅ back online — running `<sha>`"), doubling as a health signal.
- A preflight typecheck gate so a broken edit can't brick the bot into a launchd
  crash-loop.

## Non-goals

- Automatic file-watch restart. Restart is always explicitly requested (v1).
- Zero-downtime / hot code swap. The daemon hosts live objects (Discord client,
  SDK query streams); restart-and-resume is the model, since context is durable
  on disk.
- Preserving *in-flight turns* in other sessions. Per decision below, a restart
  kills any other session mid-turn without a ✅. Accepted.
- Recovering a bricked boot automatically beyond launchd's own retry throttle.

## Decisions

- **Busy-session handling: option A — restart immediately.** Other sessions
  mid-turn at exit die without a ✅. The owner is almost always the only active
  session, so wait-for-idle / refuse-if-busy machinery guards a case that
  effectively never happens.
- **Preflight typecheck gate: included.** `/restart` and the `restart` tool both
  run `bun run typecheck` (`tsc --noEmit`) and abort with the errors if it
  fails. CLI gets `--force` to skip.

## Behavior

### Shared mechanism — `Claudecord.requestRestart`

One method on the app: `requestRestart({ threadId?, reason?, skipPreflight? })`.

1. **Preflight** (unless `skipPreflight`): run `bun run typecheck` in the repo
   root. On non-zero exit, do **not** restart — return/report the compiler
   output and stop.
2. **Notify:** if `threadId` is set, post `🔄 restarting on \`<sha>\`…` to that
   thread and `await` the send (deterministic flush). `<sha>` is the current
   short git SHA of the repo.
3. **Marker:** write `~/.claudecord/restart.json` →
   `{ threadId, sha, requestedAt }` atomically (tmp + rename, matching
   registry.ts).
4. **Exit:** `process.exit(0)`. launchd (`KeepAlive=true`) respawns on new code.

### Boot confirmation

In `ClientReady` (index.ts), after the client is up: read `restart.json` if
present. If it has a `threadId`, post `✅ back online — running \`<sha>\`` to
that thread, then delete the marker. If the marker never gets consumed (bot
never reached `ClientReady`), that's the health signal the new code failed to
boot.

### Three surfaces

| Surface | Path | Notes |
|---|---|---|
| `/restart` slash command | interaction → `requestRestart({ threadId })` | preflight-gated; posts to current thread |
| `claudecord restart` CLI | control socket `{cmd:"restart", args:{force?}}` → daemon self-exits | CLI polls the daemon status and prints when it's back; replaces `kickstart -k`. `--force` skips preflight |
| `restart` MCP tool | in-session Claude → `requestRestart({ threadId })` | preflight-gated. Tool returns first; exit is deferred ~1.5s so the current turn completes with a ✅ and the SDK flushes the "edited & restarted" turn to `.jsonl` before exit |

### Deferred exit for the MCP tool

The in-session `restart` tool must not `process.exit` synchronously inside the
tool handler — that kills the SDK query mid-turn, so no ✅ and the turn (which
recorded the edits + the restart intent) may not flush to the session `.jsonl`.
Instead the tool: runs preflight, posts the "restarting" note, writes the
marker, returns a success result to the model, and schedules the exit via
`setTimeout(() => process.exit(0), ~1500ms)`. That window lets the turn reach
its `result` (✅ + `.jsonl` flush) before exit. If preflight fails the tool
returns an error result and schedules nothing.

## What survives vs. what's lost

- **Survives:** all conversation context — every session resumes from
  `sdkSessionId` on its next message (unchanged behavior). The boot marker
  restores the "back online" line to the requesting thread.
- **Lost (accepted):** any *other* session mid-turn at exit ends without a ✅.
  The triggering session's turn is handled cleanly by the deferred-exit trick
  for the MCP tool; `/restart` and CLI aren't SDK turns so nothing is mid-flight
  there.

## Components

- **`restart.ts`** (new, pure/testable): marker read/write/clear
  (`writeRestartMarker`, `readRestartMarker`, `clearRestartMarker`) and a
  `currentSha()` helper (spawn `git rev-parse --short HEAD`, best-effort).
  Preflight runner `runPreflight()` returning `{ ok, output }`.
- **`bot.ts`**: `requestRestart` method; boot-marker consumption helper used by
  `index.ts`.
- **`index.ts`**: in `ClientReady`, consume the marker and post the confirmation.
- **`control.ts`**: add `restart` command to `handleControlCommand`.
- **`commands.ts`**: `/restart` slash command definition + handler.
- **`send-file.ts`**: `restart` tool on the in-process Discord MCP server
  (alongside `send_file` / `ping_me` / `remind_me`), with deferred exit.
- **`cli.ts`**: `restart` subcommand → control socket + status poll; drop the
  double-fork/kickstart path.

## Error handling

- Preflight failure → abort, surface `tsc` output; nothing exits.
- Marker write failure → log and still exit (restart is more important than the
  confirmation; the health-signal degrades gracefully).
- `git rev-parse` failure → `sha` is `"unknown"`; restart proceeds.
- Broken new code → launchd throttled retry (~10s); no confirmation ever
  arrives, which is the signal to check logs.

## Testing

- `restart.ts`: marker round-trip (write → read → clear), missing-file read
  returns undefined, atomic write leaves no `.tmp`. `currentSha` and
  `runPreflight` shell out — test the pure marker logic directly; exercise the
  shell paths against a throwaway `CLAUDECORD_HOME`.
- `control.ts`: `restart` command dispatches to the host hook (mock the host,
  assert it's called; do not actually exit in tests).
- Daemon-level exit + launchd revive is verified by the owner in a terminal per
  the self-restart-hazard rule — not from inside a live session.
