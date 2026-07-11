# Reminders & Pings — Design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan
**Branch:** `worktree-feat+reminders-and-pings`

## Summary

Let a claudecord session get the owner's attention: ping them immediately when
something is worth interrupting for, and schedule reminders that fire later —
even across daemon restarts and even when the session is idle. Every
notification is delivered as **a DM to the owner plus a line in the origin
post**. Scheduled reminders come in two flavors the model picks per reminder: a
plain `nudge` (notify only) or a `task` (wake the session and act).

One-shot reminders only in v1. The store and schedule shape are designed so
recurring reminders can be added later without a data migration.

## Goals

- Claude can autonomously ping the owner mid-turn (blocked, finished a long
  task, hit an error) — DM + `<@owner>` post.
- Claude can schedule a one-shot reminder from natural-language time, resolved
  to a concrete instant, that fires later regardless of session state.
- A fired reminder can either notify (`nudge`) or resume the session and inject
  a prompt (`task`).
- Reminders survive daemon restarts; anything overdue fires on the next tick
  after boot.
- Owner can list and cancel pending reminders, from chat (tools) and from
  Discord slash commands — one shared source of truth.

## Non-goals (v1)

- Recurring reminders. The `schedule` field is an object (`type: "once"`) so
  recurring (`type: "cron"` / `"interval"`) slots in later, but no recurring
  logic ships now.
- Re-localizing a one-shot when the machine's timezone changes after it is set
  (see Timezones). One-shot fires at its absolute instant.
- Reminders addressed to anyone other than the owner.

## Behavior

### Immediate ping (`ping_me`)

Claude calls `ping_me(text)` the moment something is worth the owner's
attention. Full model judgment — the system prompt tells it to reserve pings for
genuinely interrupt-worthy states (blocked and needs input, long task done,
error), not routine progress. Delivery: DM the owner + post `⏺ <@owner> text`
in the current thread.

### Scheduled reminder (`remind_me`)

Claude resolves a natural-language time to a concrete `fireAt` (ISO 8601 with
offset) plus an IANA `tz`, and stores it with a `kind`:

- `nudge` — at fire time: DM the owner + post the text. Pure notification.
- `task` — at fire time: DM the owner that it is starting, then resume the
  origin session by `sdkSessionId` and inject the stored text as a prompt, so
  Claude actually does the thing and reports back in the thread. Its autonomous
  `ping_me` covers the "done" notification.

## Architecture

Dependency direction stays one-way: **store ← scheduler ← host → notify**, and
the MCP tools only ever see a narrow store interface.

### New — `src/reminders.ts` (store)

Mirrors `Registry`: atomic JSON at `~/.claudecord/reminders.json`, written
tmp+rename. CRUD only — no timers, no Discord.

```
class ReminderStore {
  add(input): Reminder      // assigns id, persists
  all(): Reminder[]         // pending (firedAt unset)
  get(id): Reminder | undefined
  remove(id): boolean
  due(now: Date): Reminder[] // firedAt unset && fireAt <= now
  markFired(id, at): void
  prune(before: Date): void  // drop fired reminders older than `before`
}
```

Pure and unit-testable; no Discord or clock dependencies beyond `now` passed in.

### New — `src/scheduler.ts` (the tick)

One `setInterval` (~20s). Each tick asks the store for due reminders and calls
the `fire(reminder)` callback it was constructed with, then prunes old fired
reminders. Knows nothing about Discord — just store + callback + clock. Clock is
injectable for tests.

```
class Scheduler {
  constructor(store, fire: (r: Reminder) => Promise<void>, opts?: { intervalMs, now })
  start(): void
  stop(): void
  tick(): Promise<void>   // exposed for tests
}
```

### New — `src/notify.ts` (delivery)

Thin helpers over the Discord client, isolating all DM/mention logic in one
place:

- `dmOwner(client, ownerId, text)` — open/reuse the DM channel and send.
- `postToThread(client, threadId, text)` — fetch the thread, unarchive if
  needed, send with `<@ownerId>` and `allowedMentions: { users: [ownerId] }` so
  it actually pings.

### Changed — `Claudecord` host (`bot.ts`)

Owns the `ReminderStore` and `Scheduler`, and implements the concrete
`fire(reminder)`:

1. `markFired(id)` immediately and persist — a crash mid-fire can't double-send,
   and a still-overdue reminder isn't re-fired next tick.
2. `nudge` → `dmOwner(text)` + `postToThread(threadId, "⏰ " + text)`. Both
   best-effort; a deleted thread does not block the DM.
3. `task` → `dmOwner("⏰ starting: " + text)`, resolve the `SessionRecord`,
   `ensureRuntime(thread, record)`, `runtime.send([{ type: "text", text }])` —
   reusing the exact resume path `/new` and handoffs already use. If the thread
   or record is gone, fall back to `nudge` delivery plus a note that the session
   couldn't be revived.

Also exposes the narrow `ReminderServices` interface (below) that the MCP tools
use, and passes it down to `SessionRuntime`.

### Changed — `SessionRuntime` / MCP factory (`session.ts`, `send-file.ts`)

`createDiscordFileServer(thread)` becomes `createDiscordMcpServer(thread,
services)`, where `services: ReminderServices` provides everything the new tools
need without exposing the client or scheduler:

```
interface ReminderServices {
  ownerId: string | undefined;
  threadId: string;
  sdkSessionId(): string | undefined;   // current, for task reminders
  cwd(): string | undefined;
  schedule(input): Reminder;             // -> store.add
  list(): Reminder[];
  cancel(id): boolean;
  pingOwner(text): Promise<void>;        // immediate DM + post
}
```

`SessionRuntime` receives `services` and forwards it into the factory. Immediate
`ping_me` goes through `services.pingOwner`, which the host wires to
`notify.ts`.

### Changed — startup (`index.ts`)

Construct the scheduler after the client is ready and call `scheduler.start()`
alongside `startHandoffWatcher()`. Stop it on shutdown.

## Data schema

`reminders.json` is `{ nextId: number, reminders: Reminder[] }`.

```
Reminder {
  id: string             // "r7" — short, hand-cancelable
  threadId: string       // origin session (for task-wake + post)
  sdkSessionId?: string  // captured at creation, for resume
  cwd?: string           // carried so a woken session runs in the right dir
  kind: "nudge" | "task"
  text: string           // nudge: the message | task: the prompt to inject
  schedule: {
    type: "once"         // v1 only value; "cron"/"interval" later
    fireAt: string       // ISO 8601 WITH offset, e.g. 2026-07-12T09:00:00+06:00
    tz: string           // IANA zone, e.g. Asia/Dhaka
  }
  createdAt: string
  firedAt?: string       // set when fired; pruned ~1h later
}
```

`store.due(now)` = reminders with `firedAt` unset and `schedule.fireAt <= now`.

## Fire flow

Host `fire(reminder)`, called by the tick:

1. `markFired` + persist first (idempotency guard).
2. `nudge`: `dmOwner` + `postToThread`.
3. `task`: `dmOwner("⏰ starting: …")` → resolve record → `ensureRuntime` →
   `runtime.send([prompt])`. Missing thread/record → nudge fallback + note.
4. Fired once-reminders pruned on a later tick (kept ~1h for debuggability).

**Restart catch-up:** nothing special. On boot the store loads and the first
tick fires everything with `fireAt <= now`, so a reminder due while the daemon
was down goes off within one tick of startup.

## Timezones

The owner deliberately changes the machine's system timezone (e.g. to
Asia/Dhaka) to get around local time restrictions, so the host zone is not
stable between a reminder's creation and its firing. Therefore:

- `fireAt` stores an **absolute instant** (the offset pins it). The tick
  compares absolute-now to absolute-`fireAt`, so flipping the machine's timezone
  after a reminder is set does **not** move when it fires. "Remind me in 2h" is
  always 2 real hours later.
- `tz` (IANA) is stored explicitly for **display** ("9:00 AM Asia/Dhaka") and so
  **recurring** (future) can recompute each occurrence in the intended zone.
- The `remind_me` handler stamps `tz` from the daemon host's current zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) unless the user names an
  explicit zone ("9am Dhaka time"), which Claude honors when resolving `fireAt`.
- **One-shot semantics are absolute, not re-localized.** A reminder set as
  "tomorrow 9am" in Denver, when the machine later flips to Dhaka before it
  fires, still fires at the original Denver-9am instant. Re-localization is a
  recurring concern and is out of scope for v1.

## Tool surface

Added to the per-thread `discord` MCP server (`send-file.ts`), which is renamed
`createDiscordMcpServer(thread, services)`:

| Tool | Args | Behavior |
|---|---|---|
| `ping_me` | `text` | DM + `<@owner>` post now. Autonomous. |
| `remind_me` | `text`, `fireAt` (ISO+offset), `tz` (IANA), `kind` (`nudge`\|`task`) | Validate, `store.add`, return id + human-readable confirmation. |
| `list_reminders` | — | Pending reminders: id, when, tz, kind, text. |
| `cancel_reminder` | `id` | `store.remove`; clear error on unknown id. |

Tool descriptions state: resolve times to a concrete `fireAt` with offset; `tz`
defaults to host zone unless the user names one; `ping_me` is for
genuinely interrupt-worthy moments only.

## Slash commands (`commands.ts`, owner-gated)

- `/reminders` — list pending reminders in an embed.
- `/cancel <id>` — cancel one.

Thin wrappers over the same `ReminderStore` the tools use.

## System prompt (`session.ts`)

Append one paragraph: Claude can ping the owner (`ping_me`) and schedule
reminders (`remind_me`); reserve `ping_me` for genuinely interrupt-worthy
moments; resolve times to `fireAt` + `tz`; `task` reminders wake this session
later, `nudge` reminders just notify.

## Error handling

- Delivery is best-effort and isolated: a deleted thread never blocks the DM, a
  closed DM never blocks the post.
- `remind_me` rejects a `fireAt` that fails to parse or is in the past, with an
  actionable message.
- `cancel_reminder` / `/cancel` return a clear "no reminder with id X" on miss.
- `task` reminder whose session can't be revived degrades to a `nudge` with a
  note, rather than failing silently.
- `markFired`-before-send guarantees at-most-once delivery across crashes.

## Testing (bun, matching existing `*.test.ts`)

- `reminders.test.ts` — CRUD, atomic write, `due(now)` boundary (exactly-now
  fires, future does not), unknown-id removal, prune.
- `scheduler.test.ts` — injected fake clock + spy `fire`: due fires once not
  twice; overdue-on-boot fires immediately; not-yet-due does not fire; prune
  runs.
- `notify.test.ts` — mention string + `allowedMentions` built correctly;
  archived-thread unarchive path (client mocked at the notify boundary).
- Fire flow — `nudge` calls both delivery paths; `task` resolves record and
  sends the prompt; missing thread falls back to nudge.

No live Discord in tests; the client is mocked at the `notify.ts` boundary,
matching how the repo already isolates Discord.
