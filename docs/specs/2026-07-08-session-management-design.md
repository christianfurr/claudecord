# Session management — CLI + Discord via control socket

Date: 2026-07-08
Status: approved

## Problem

Session lifecycle is only manageable from inside a Discord thread, one session at a
time (`/end`, `/clear`, `/rename`). The host CLI can only *count* sessions
(`claudecord status`). To end sessions from the host you must stop the daemon,
hand-edit `~/.claudecord/sessions.json`, and restart — which is racy, skips runtime
teardown, and never archives the Discord thread or posts the ended embed.

## Goal

Give both the host CLI and Discord first-class session management: list/inspect, end
one, end all, force-kill a stuck session, and prune ended records. One implementation
behind two front doors.

## Why a control socket

The daemon is a separate process that owns the live in-memory `SessionRuntime` map
*and* the `Registry`. A CLI that edits `sessions.json` directly races the daemon and
cannot drop live runtimes or drive Discord side effects. So runtime-affecting CLI
commands must be executed *by the daemon*.

Chosen approach: the daemon exposes a **Unix domain socket** control channel. The CLI
is a thin client that sends one JSON command and prints the reply. Rejected: a
localhost HTTP port (needs a port + auth token, more surface, no benefit for a
local-only tool) and file-watch reconciliation (async, racy, daemon saves clobber CLI
edits, Discord side effects awkward).

## Components

### 1. Session-service layer — `src/sessions.ts` (new)

The single source of truth. Async functions that take the running `Claudecord` app and
perform the real work. Both the socket handler and the Discord commands call these, so
logic is not duplicated. Each returns a structured result (never throws across the
socket boundary).

- `listSessions(app)` → `SessionSummary[]`, where `SessionSummary` =
  `{ num, title, status, model, busy, live, ageSec, costUsd }`.
  `live` = a runtime is loaded in memory; `busy` = a turn is in flight.
- `endSession(app, num)` → **graceful**. If the session is busy, wait for the current
  turn to drain (bounded by `END_DRAIN_MS = 30_000`; on timeout, fall back to force).
  Then: `dropRuntime` → registry `status: "ended"` → apply "done" tag → post ended
  embed → archive thread. Returns `{ num, ended: true, forced: boolean }`.
- `endAll(app)` → run `endSession` over every active session; return the per-session
  result array. Errors on one session do not abort the others.
- `killSession(app, num)` → **force**. Interrupt the in-flight turn immediately
  (`dropRuntime` already calls `runtime.dispose()`, which interrupts), mark `ended`,
  tag, archive. Does not wait for a drain. For stuck/hung turns.
- `pruneEnded(app)` → remove every `status: "ended"` record from the registry; return
  `{ removed: number }`. Does not touch active sessions or Discord.

Registry support needed: `Registry.remove(threadId)` (new) and `Registry.all()` (exists)
for prune and list. `endSession`/`killSession` locate a session by `sessionNum` via a
new `Registry.getByNum(num)` helper.

### 2. Control socket — `src/control.ts` (new)

- `startControlServer(app)` — called from `index.ts` after the bot logs in. Opens a
  `net` server on `~/.claudecord/control.sock`. Unlinks any stale socket file first,
  `chmod 0600` after bind. Returns the server so `index.ts` can close it on shutdown.
- Protocol: newline-delimited JSON. Request `{ cmd: string, args?: object }`. Response
  `{ ok: true, data }` or `{ ok: false, error: string }`, one line, then the connection
  closes.
- `cmd` dispatch table maps to the service layer:
  `list` → `listSessions`, `end` → `endSession(args.num)`, `endAll` → `endAll`,
  `kill` → `killSession(args.num)`, `prune` → `pruneEnded`.
- Unknown `cmd` → `{ ok: false, error }`. Handler wraps the service call in try/catch so
  a thrown error becomes a structured error response, never a crash.
- No auth token: filesystem permissions (owner-only, local-only) are the boundary,
  consistent with how the token-bearing plist is already `chmod 0600`.

### 3. CLI client — extend `src/cli.ts`

New subcommands (thin socket clients unless noted):

| Command | Behavior |
|---|---|
| `claudecord sessions` | `list` → formatted table (num, status, title, model, cost, age) |
| `claudecord end <n>` | `end` |
| `claudecord end --all` | `endAll` |
| `claudecord kill <n>` | `kill` |
| `claudecord prune` | `prune` |

A `sendControl(cmd, args)` helper connects to the socket, writes one JSON line, reads
one reply line, resolves/rejects. Timeout guard so a wedged daemon can't hang the CLI.

**Down-daemon fallback** (socket missing / `ECONNREFUSED`):
- `sessions`, `prune` — run directly against `sessions.json` (safe; no live runtimes
  exist when the daemon is down).
- `end`, `end --all` — direct registry mark-ended, printing a note that Discord threads
  were not archived (no daemon to do it).
- `kill` — requires the daemon; print "daemon not running — nothing to kill" and exit
  non-zero.

The direct-registry logic is shared with the service layer where possible (registry
mutation helpers live in `registry.ts`, not duplicated in the CLI).

Update the CLI usage/help string and the header comment to list the new commands.

### 4. Discord commands — extend `src/commands.ts`

- `/sessions` — richer list embed (num, title, status, model, cost, age) built from
  `listSessions`. Complements the existing `/status` (which stays as the bot-health +
  terse list view).
- `/end-all` — owner-gated (`app.settings.ownerId`), calls `endAll`, replies with a
  one-line-per-session summary.
- `/kill` — run inside a session thread, calls `killSession` for that thread's session.
  For stuck turns where `/end` would hang on the drain.

All three call the service layer in-process (no socket hop). Register the new command
definitions in `commandDefinitions` and the dispatch switch.

## Error handling

- Service functions validate inputs (session exists; is active for end/kill) and return
  `{ ok: false, error }`-shaped results rather than throwing.
- Socket handler try/catches every dispatch; a thrown error → structured error reply.
- CLI maps connection errors to the fallback path or a clear message; a malformed reply
  or timeout prints an actionable error and exits non-zero.
- `endAll` isolates per-session failures so one bad session doesn't abort the sweep.

## Testing

- **Service layer unit tests** (`scripts/` harness style or a test file): fake
  `Claudecord` app with an in-memory registry and a mock thread/runtime. Cover:
  end active, end already-ended (error), end busy (drains then ends), kill busy
  (immediate), endAll over a mix, prune removes only ended, list shape.
- **Socket round-trip test**: start the control server against a fake app, connect a
  client, assert request→response for each `cmd`, including unknown-cmd and
  malformed-input error paths.
- **CLI fallback test**: with no socket present, `sessions` and `prune` operate on a
  temp `sessions.json`; `kill` exits non-zero.
- **End-to-end verify**: against a real running daemon, create sessions, run
  `claudecord sessions`, `end`, `end --all`, confirm registry + menu-bar count reflect
  the change and the Discord thread is archived.

## Out of scope

- Reviving/creating sessions from the CLI (use Discord `/new`).
- Per-session `clear`/`model`/`rename` from the CLI (stay Discord-only for now).
- Remote/networked control (socket is local-only by design).
