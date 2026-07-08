# claudecord

A Discord **forum channel** as your Claude Code interface. Every forum post is a
persistent Claude session: hit *New Post*, give it a title, describe what you want —
Claude works in the post, streaming its tool activity live, and keeps context for as
long as the post lives.

Powered by [discord.js](https://discord.js.org) and the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) in a single Node process.
No tmux, no HTTP relay, no shell hooks.

Inspired by [yamkz/claude-discord-bridge](https://github.com/yamkz/claude-discord-bridge) (MIT).

## How it works

```
Discord forum post ⇄ claudecord (discord.js) ⇄ Agent SDK session (cwd = your workDir)
```

- **New post → new session.** The post title names the session; the first message is
  the first prompt. Sessions are numbered and tracked in `~/.claudecord/sessions.json`.
- **Live activity feed.** Thinking summaries (💭) and every tool call (⏺) stream into
  the post as a quoted feed message that updates in place.
- **Reaction acks.** 🤔 while a message is being worked on, ✅ when the turn finishes,
  ❌ on failure. No ack spam.
- **Tags.** 🟢 Active / ✅ Done forum tags reflect session state.
- **Revival.** Posting in an ended/archived session revives it — context resumes via
  the SDK session id.
- **Images.** Attach images to any message; they're passed to Claude inline.

## Commands

| Command | Where | What |
|---|---|---|
| `/setup` | anywhere | One-time: creates the `#claude-sessions` forum + tags |
| `/status` | anywhere | All sessions, live/busy state, uptime |
| `/clear` | in a post | Fresh context, same post |
| `/end` | in a post | End the session, tag ✅ Done, archive |
| `/rename title:` | in a post | Rename the post |

## Setup

1. **Bot:** create one at the [Discord developer portal](https://discord.com/developers/applications),
   enable the **Message Content** intent, and invite it with the `bot` +
   `applications.commands` scopes and these permissions: Manage Channels, Manage
   Threads, Send Messages, Send Messages in Threads, Add Reactions, Embed Links,
   Read Message History.
2. **Token:** put `DISCORD_TOKEN=...` in a `.env` file next to `package.json`
   (or export it).
3. **Auth for Claude:** claudecord uses your existing Claude Code login — if
   `claude` works in your terminal, you're set. (An `ANTHROPIC_API_KEY` env var
   also works.)
4. Run it:

```bash
npm install
npm run dev        # or: npm run build && npm start
```

5. In your server, run `/setup`, then create a post in **#claude-sessions**.

## Configuration

`~/.claudecord/config.json` (created by `/setup`):

```json
{
  "forumChannelId": "...",
  "tagActiveId": "...",
  "tagDoneId": "...",
  "workDir": "/Users/you/Code",
  "model": "claude-opus-4-8"
}
```

- `workDir` — the directory Claude sessions operate in (default `~/Code`).
- `model` — optional; omit to use your Claude Code default.

Sessions run with permissions bypassed (the SDK equivalent of
`claude --dangerously-skip-permissions`) — run this only on a machine you trust the
bot's users with, in a server where only you can post.

## License

MIT — see [LICENSE](LICENSE).
