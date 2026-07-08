# claudecord — Design Spec

Date: 2026-07-09
Status: approved (design discussed and approved in planning session)

## What it is

A single TypeScript process that bridges Discord and Claude Code sessions using the
Claude Agent SDK. A Discord **forum channel** is the entire interface: each forum post
is one persistent Claude session. Inspired by yamkz/claude-discord-bridge (MIT), but a
ground-up rewrite with a different architecture — no tmux, no Flask, no shell hooks.

## Core model

- **Forum channel = session list.** One configured forum channel. Discord's native
  "New Post" button creates a session: post title = session title, first message =
  first prompt. The bot detects thread creation, spawns an SDK session, replies in
  the post.
- **Post = session.** All messages in a post route to that post's Claude session.
  Sessions are numbered (auto-increment, never reused) and persisted in a registry
  (`~/.claudecord/sessions.json`) mapping threadId → { sessionNum, sdkSessionId,
  title, status, createdAt }.
- **Agent SDK engine.** Each session is a long-lived Agent SDK query (streaming input
  mode) running in the configured working directory with permissions bypassed —
  matching how the user ran `claude --dangerously-skip-permissions` before. The
  process streams every event to Discord:
  - 💭 thinking (summarized) — quoted line(s)
  - `> ⏺ Tool: summary` — one line per tool call
  - assistant text — posted as messages; final result as the reply
- **Streaming presentation.** Per turn, the bot maintains one progress message it
  edits/appends (rate-limit friendly) rather than one Discord message per event.
  Final text posts as normal message(s), chunked to Discord's 2000-char limit.

## Discord surface

- **Reaction acks**: 🤔 on receipt of a user message, ✅ when the turn completes,
  ❌ on error. No text acks.
- **Tags**: 🟢 Active / ✅ Done forum tags, applied by the bot.
- **Slash commands** (guild-scoped):
  - `/setup` — one-time: creates the forum channel + tags, saves IDs to config
  - `/clear` — resets the session's context (fresh SDK session, same post)
  - `/end` — ends the session, tags Done, archives the post
  - `/rename title:` — renames the post
  - `/status` — embed: all sessions, alive/idle state, uptime, model
- **Embeds**: welcome embed on session create; status embed; red error embeds;
  session-ended summary embed (turns, cost if available).
- **Revival**: posting in an archived/ended post un-archives and resumes (via the
  SDK resume/session id if available, else fresh session with a note).
- **Attachments**: images downloaded to a temp dir and passed to the session.

## Components

| File | Responsibility |
|---|---|
| `src/index.ts` | boot: config, client login, wire handlers |
| `src/config.ts` | env-based config (token, guild, forum id, work dir, model) with validation |
| `src/registry.ts` | session registry persistence (~/.claudecord/sessions.json) |
| `src/bot.ts` | discord.js client + event handlers (ThreadCreate, MessageCreate, interactions) |
| `src/session.ts` | SessionManager: SDK query lifecycle, per-thread message queue, event → Discord streaming |
| `src/commands.ts` | slash command definitions + handlers |
| `src/format.ts` | embeds, activity lines, 2000-char chunking, truncation |

## Decisions

- Forum-only: the old channel-session model is not carried over.
- New post = new session (no /new command needed).
- Reaction ack replaces text acks.
- discord.js v14, Node 22, plain npm. MIT license, credit to yamkz in README.
- One turn at a time per session; messages arriving mid-turn are queued.
- Auth: uses the machine's existing Claude Code login via the Agent SDK.

## Out of scope (deliberately)

- Multiple forums / multi-guild support
- Web dashboard
- Per-session working-directory override (config default only, revisit if needed)
