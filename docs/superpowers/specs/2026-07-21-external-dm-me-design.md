# Design: `dm_me` — let external agents DM the owner

**Date:** 2026-07-21
**Status:** Approved, ready for implementation plan

## Problem

`ping_me` already DMs the owner, but it lives in the in-process SDK MCP server
(`src/send-file.ts`, server name `discord`) and needs the live Discord client +
per-session services. It is only reachable from inside a running claudecord
session. Agents running *outside* claudecord (other Claude Code sessions,
cron/build agents on the same Mac) have no way to get the owner's attention.

`handoff_to_discord` already solves the "outside process → daemon" problem:
a standalone stdio MCP tool drops a file into a watched directory, and the
daemon acts on it. We reuse that exact pattern for DMs.

## Scope

- **In scope:** a `dm_me` tool on the standalone stdio server that sends the
  owner a Discord DM, via a file drop the daemon watches.
- **Out of scope:** remote agents (HTTP/tunnel/auth). Same-machine only —
  filesystem permissions are the trust boundary. Can be layered on later over
  the same daemon action. Also out: creating posts, waking sessions, running
  turns, `task`-style reminders. `dm_me` can only send a DM.

## Mechanism (twin of handoff)

1. Add a `dm_me` tool to the standalone stdio server in `src/mcp.ts` (the
   `claudecord` server external agents register alongside `handoff_to_discord`).
2. The tool writes a **notification file** into a new watched dir
   `~/.claudecord/notifications/`, atomically (tmp + rename), exactly like
   `writeHandoff`.
3. The daemon watches that dir with a new `startNotificationWatcher` (twin of
   `startHandoffWatcher` in `bot.ts`): drain existing files on boot, then
   `watch()` for new ones. Each file is read + validated, delivered via
   `dmOwner`, then deleted. On error the file is quarantined to
   `notifications/failed/` — never silently dropped.

Reuses the existing `dmOwner` in `src/notify.ts`. No new Discord delivery code.

## Tool shape

```
dm_me(message: string, from?: string)
```

- Delivered DM text: `📨 <from>: <message>`, or plain `<message>` if `from`
  is omitted.
- **Fire-and-forget**, like handoff: returns `"Notification queued — you'll
  get a DM shortly."`. The file drop is async; the tool does not block on
  Discord delivery and does not report delivery success/failure back to the
  calling agent. (A same-machine agent that needs confirmation is a future
  round-trip-file feature, out of scope.)

## New module: `src/notifications.ts`

Twin of `src/handoffs.ts`. Keeps `mcp.ts` and `bot.ts` thin and the logic
unit-testable in isolation.

- `NOTIFY_DIR = join(CONFIG_DIR, "notifications")`
- `NOTIFY_FAILED_DIR = join(NOTIFY_DIR, "failed")`
- `notifySchema` (zod):
  - `message`: string, min 1, **max 2000** (Discord DM limit)
  - `from`: string, max 100, optional
  - `createdAt`: string, min 1
- `type NotificationRequest = z.infer<typeof notifySchema>`
- `writeNotification(req, dir?)` — atomic tmp+rename; returns path. Filename
  must be unique per drop (handoff keys on `sessionId`; notifications have no
  natural key, so use a timestamp + counter or random suffix to avoid
  collisions when several land close together).
- `readNotification(path)` — read + zod-validate; throws on malformed.
- `quarantineNotification(path, now?)` — move to `NOTIFY_FAILED_DIR`.
- `formatDm(req): string` — pure function producing `📨 <from>: <message>` or
  `<message>`.

## Daemon wiring (`src/bot.ts`)

- `startNotificationWatcher()` — mirror `startHandoffWatcher`: `mkdirSync`,
  drain `readdirSync`, then `watch()`; each `.json` → `processNotificationFile`.
- `processNotificationFile(path)` — `readNotification`; on parse failure return
  (partial write in flight); on success `dmOwner(client, ownerId, formatDm(req))`
  then `unlinkSync`; on delivery throw quarantine to failed dir.
- Call `startNotificationWatcher()` wherever `startHandoffWatcher()` is called.

## Security / trust model

- **Filesystem is the trust boundary.** Any local process that can write to
  `~/.claudecord/notifications/` can DM the owner — same as handoff today.
  Single-user Mac, same machine only, no token.
- **Strictly less powerful than handoff.** `dm_me` only sends a DM: no mention
  parsing (`dmOwner` sends plain text to the owner's own DM channel), no thread
  posting, no session waking, no turn execution.
- **Input is validated and bounded.** Zod caps `message` at 2000 and `from` at
  100 chars; malformed files quarantine rather than crash the watcher.
- **No rate limiting in v1** — matches handoff; a same-machine agent under the
  user's control is not an adversary. Revisit if ever exposed beyond localhost.

## Testing

Mirrors the `handoffs.test.ts` / `notify.test.ts` split:

- **`notifications.test.ts`**
  - write → read round-trip
  - atomic rename (no partial reads)
  - schema rejection: missing `message`, oversized `message`/`from`
  - unique filenames when multiple drops occur
  - `quarantineNotification` moves malformed files to `failed/`
  - `formatDm`: `📨 <from>: <msg>` with `from`; plain `<msg>` without
- **`mcp.test.ts`** — extend: `dm_me` returns the queued message and writes a
  file that `readNotification` accepts.
- Watcher drain/quarantine follows the already-covered handoff watcher.

## Files touched

- `src/notifications.ts` (new)
- `src/notifications.test.ts` (new)
- `src/mcp.ts` — register `dm_me`
- `src/mcp.test.ts` — cover `dm_me`
- `src/bot.ts` — `startNotificationWatcher` + `processNotificationFile`, wired
  in next to the handoff watcher
- `README.md` — document `dm_me` for external agents (how to register the
  stdio server + example)
