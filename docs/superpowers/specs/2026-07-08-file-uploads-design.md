# File uploads (bidirectional) — design

**Date:** 2026-07-08
**Branch:** `feat/file-uploads`
**Status:** approved

## Problem

claudecord bridges a Discord forum post to a Claude Code session. Today file
handling is one-directional and partial:

- **Inbound:** only images are usable. `buildContent()` (`bot.ts`) fetches image
  attachments and inlines them as `image` blocks. Any other type (PDF, docx, txt)
  is dropped — Claude only gets a text note with the CDN URL, which it cannot open.
- **Outbound:** nonexistent. Claude's `text` blocks are chunked and posted
  (`session.ts`); there is no path for Claude to attach a local file to the post.
  The system prompt explicitly says "never try to send Discord messages yourself."

Motivating case: a user asks Claude to find local documents and return them. Claude
can locate the files but has no safe way to deliver them, and cannot read a
non-image file the user attaches.

## Goals

1. **Outbound:** Claude can attach a local file to the post via an explicit tool.
2. **Inbound:** Claude can read any attached file type, not just images.
3. Outbound is guardrailed — it is a new data-egress channel and must not become an
   exfiltration hole for secrets.

## Non-goals

- No streaming/chunked upload of files larger than Discord's per-file limit.
- No change to how images are handled inbound (already works, stays inlined).
- No remote/URL fetching by the outbound tool — local filesystem paths only.

## Design

### Outbound: `send_file` SDK MCP tool

Register a per-session in-process MCP server named `discord` exposing one tool,
`send_file`, via the SDK's `createSdkMcpServer` / `tool` helpers. The tool is added
to `options.mcpServers` and `options.allowedTools` (`mcp__discord__send_file`) when
each `SessionRuntime` builds its `query` options. The handler closes over that
runtime's `thread`, so a call posts to the correct post.

**Tool input:** `{ path: string, comment?: string }` — `path` is the local file to
attach; `comment` is optional message text sent alongside it.

**Handler flow:**
1. Expand a leading `~`, resolve to an absolute path, then `realpathSync` to
   collapse symlinks (so a link can't escape the allowed scope).
2. Run `validateOutboundFile()` (pure, tested — see `files.ts`). Rejects when:
   - resolved path is not under `$HOME`;
   - the basename matches a secret pattern: `.env`, `.env.*`, `*.key`, `*.pem`,
     `*.secret`, `*.keystore`;
   - the path does not exist or is not a regular file;
   - size exceeds `MAX_UPLOAD_BYTES` (10 MB — Discord's common unboosted per-file
     limit).
3. On failure, return `{ isError: true, content: [text: <reason>] }` so Claude sees
   why and can tell the user, rather than silently dropping.
4. On success, `thread.send({ content: comment, files: [new AttachmentBuilder(path)] })`
   and return a short success confirmation. Discord upload errors are caught and
   returned as `isError`.

**System prompt change (`session.ts`):** the "never send Discord messages yourself"
line is amended to note that Claude *can* attach a local file with the `send_file`
tool, and that the tool refuses secrets, paths outside the home directory, and files
over the size limit.

**Access control:** unchanged and already sufficient — `onMessage` (`bot.ts`) only
lets the owner/allowlist drive a session, so an outsider cannot trigger a send. The
secret deny-list defends against a prompt-injected send (e.g. a malicious file that
tells Claude to attach `~/.ssh/id_rsa`).

### Inbound: non-image files → disk + path

Extend `buildContent()` (`bot.ts`). For any attachment that is not an inlineable
image (non-image type, or an image over `MAX_IMAGE_BYTES`):
1. Download the bytes (guarded by `MAX_INBOUND_BYTES`, 25 MB — above Discord's
   uploader limit, so it only trips on pathological cases).
2. Save under `${CONFIG_DIR}/inbox/<threadId>/<sanitized-filename>`.
   `sanitizeFilename()` (pure, tested) strips path separators and leading dots so a
   crafted attachment name can't write outside the inbox.
3. Add a text block: `[User attached <name> (<type>, <size>) — saved to <abspath>.
   Use your Read tool to open it.]`

Images stay inlined exactly as today. If a download fails, fall back to the current
URL-note behavior so the turn still proceeds.

### Feed formatting (`format.ts`)

Add an `activityLine` case so `mcp__discord__send_file` renders as
`⏺ send_file · <basename>` instead of the raw tool name. Every file that leaves is
therefore visible in the live activity feed.

## Components

| Unit | File | Responsibility | Tested |
|------|------|----------------|--------|
| `validateOutboundFile`, `sanitizeFilename`, secret matcher, byte constants | `src/files.ts` (new) | Pure validation/sanitization logic | Yes (unit) |
| `createDiscordFileServer(thread)` | `src/send-file.ts` (new) | SDK MCP server + `send_file` handler (I/O) | Boundary-mocked / manual |
| Wire `mcpServers` + `allowedTools` + system prompt | `src/session.ts` (edit) | Expose the tool per session | Via typecheck + manual |
| Inbound download-to-disk | `src/bot.ts` (edit) | Persist non-image attachments, pass path | Via helper unit tests + manual |
| `send_file` feed line | `src/format.ts` (edit) | Human-readable activity line | Yes (unit) |

## Error handling

- Outbound validation failures return `isError` results to Claude with a specific
  reason — never throw into the SDK loop.
- Inbound download failures degrade to the existing URL-note block; the turn
  continues.
- Oversized files (either direction) are reported, not truncated or silently
  skipped.

## Testing

Behavior-focused unit tests in `src/files.test.ts`:
- `validateOutboundFile`: rejects `.env`/`.key`/`.pem`; rejects paths outside
  `$HOME`; rejects symlink-escape; rejects missing/oversized; accepts a valid file
  under home.
- `sanitizeFilename`: strips `/`, `..`, leading dots; preserves a normal name.
- `activityLine` for `mcp__discord__send_file` renders the basename.

I/O paths (actual Discord upload, actual download) are verified manually against a
live session — mock the filesystem/network boundary only, not the logic.

## Open risks

- Discord's per-file limit varies by server boost tier; `MAX_UPLOAD_BYTES` targets
  the common 10 MB floor. Uploads that pass the size check but still exceed a
  stricter server limit are caught at send time and returned as `isError`.
