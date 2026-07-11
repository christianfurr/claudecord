import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { AttachmentBuilder, type AnyThreadChannel } from "discord.js";
import { z } from "zod";
import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isDatalessStat, validateOutboundFile } from "./files.js";
import { formatReminder, type Reminder, type ReminderKind } from "./reminders.js";

/** Fully-qualified name of the tool as Claude sees it (server "discord" + tool "send_file"). */
export const SEND_FILE_TOOL = "mcp__discord__send_file";

/** Per-session reminder args passed by the `remind_me` tool. */
export interface ScheduleArgs {
  kind: ReminderKind;
  text: string;
  fireAt: string;
  tz: string;
}

/**
 * Narrow surface the reminder/ping tools use. The host implements it per-thread,
 * closing over the owner id, the session's thread/record, the store, and the
 * Discord client — so the tools never touch the client or scheduler directly.
 */
export interface ReminderServices {
  ownerId: string | undefined;
  schedule(args: ScheduleArgs): Reminder;
  list(): Reminder[];
  cancel(id: string): boolean;
  pingOwner(text: string): Promise<void>;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const READ_RETRIES = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the file provider to download a dataless file and wait for its data to land. */
async function materialize(path: string): Promise<void> {
  spawnSync("brctl", ["download", path]);
  for (let i = 0; i < 30; i++) {
    if (!isDatalessStat(statSync(path))) return;
    await delay(500);
  }
}

/**
 * Read a file for upload, coping with two macOS failure modes that both surface as
 * EDEADLK: iCloud-evicted (dataless) files, which must be downloaded first, and
 * transient threadpool contention under concurrent reads, which clears on retry.
 */
async function readForUpload(path: string): Promise<Buffer> {
  if (isDatalessStat(statSync(path))) await materialize(path);
  let lastErr: unknown;
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      return Buffer.from(readFileSync(path));
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== "EDEADLK") throw err;
      if (isDatalessStat(statSync(path))) await materialize(path);
      await delay(250);
    }
  }
  throw lastErr;
}

/**
 * Per-session in-process MCP server exposing `send_file`, which attaches a local
 * file to this post. The handler closes over `thread`, so a call always lands in
 * the right forum post. All validation lives in `validateOutboundFile`.
 */
export function createDiscordMcpServer(thread: AnyThreadChannel, services: ReminderServices) {
  return createSdkMcpServer({
    name: "discord",
    version: "1.0.0",
    tools: [
      tool(
        "send_file",
        "Attach a local file to this Discord post so the user can download it. " +
          "Give an absolute path (or ~/…). Refuses secret files (.env, keys, etc.), " +
          "paths outside the home directory, and files over 10 MB.",
        {
          path: z.string().describe("Absolute path (or ~/…) to the local file to attach."),
          comment: z.string().optional().describe("Optional message to post alongside the file."),
        },
        async ({ path, comment }) => {
          const check = validateOutboundFile(path);
          if (!check.ok) {
            return { isError: true, content: [{ type: "text", text: check.reason }] };
          }
          try {
            // Read the bytes ourselves (materializing iCloud files, retrying on
            // EDEADLK) and hand discord.js a Buffer, so it never does its own read.
            const data = await readForUpload(check.path);
            const attachment = new AttachmentBuilder(data, { name: basename(check.path) });
            await thread.send({
              ...(comment ? { content: comment } : {}),
              files: [attachment],
            });
            const kb = (check.size / 1024).toFixed(0);
            return { content: [{ type: "text", text: `Attached ${basename(check.path)} (${kb} KB) to the post.` }] };
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            const msg =
              e.code === "EDEADLK"
                ? `Couldn't read ${basename(check.path)} — it appears to be stored in iCloud and failed to download. Open it once in Finder, then try again.`
                : `Couldn't send the file: ${e.message ?? String(err)}`;
            return { isError: true, content: [{ type: "text", text: msg }] };
          }
        },
      ),
      tool(
        "ping_me",
        "Ping the owner right now — a Discord DM plus a mention in this post. Use this " +
          "autonomously when something is genuinely worth interrupting them for: you're blocked " +
          "and need input, a long task just finished, or you hit an error they'd want to know " +
          "about. Do not use it for routine progress updates.",
        { text: z.string().describe("The short message to send the owner.") },
        async ({ text }) => {
          if (!services.ownerId) {
            return { isError: true, content: [{ type: "text", text: "No owner is configured, so there's no one to ping." }] };
          }
          await services.pingOwner(text);
          return { content: [{ type: "text", text: "Pinged the owner (DM + mention in this post)." }] };
        },
      ),
      tool(
        "remind_me",
        "Schedule a one-shot reminder for later. Resolve the user's natural-language time to a " +
          "concrete `fireAt` (ISO 8601 WITH offset, e.g. 2026-07-12T09:00:00+06:00) and an IANA " +
          "`tz` (e.g. Asia/Dhaka). Default `tz` to the host machine's zone unless the user names a " +
          'specific zone, which you must honor. `kind` = "nudge" just notifies the owner at that ' +
          'time; "task" wakes this session and hands you the text as a prompt so you can do the ' +
          "thing and report back. The reminder fires at its absolute instant even if the machine's " +
          "timezone changes before then.",
        {
          text: z.string().describe("nudge: the message to deliver. task: the prompt to run later."),
          fireAt: z.string().describe("When to fire — ISO 8601 with offset, e.g. 2026-07-12T09:00:00+06:00."),
          tz: z.string().describe("IANA timezone the time was expressed in, e.g. Asia/Dhaka."),
          kind: z.enum(["nudge", "task"]).describe('"nudge" to notify only, "task" to wake this session and act.'),
        },
        async ({ text, fireAt, tz, kind }) => {
          const at = new Date(fireAt);
          if (Number.isNaN(at.getTime())) {
            return {
              isError: true,
              content: [{ type: "text", text: `Couldn't parse fireAt "${fireAt}" — use ISO 8601 with an offset, e.g. 2026-07-12T09:00:00+06:00.` }],
            };
          }
          if (at.getTime() <= Date.now()) {
            return { isError: true, content: [{ type: "text", text: `That time (${fireAt}) is in the past.` }] };
          }
          if (!isValidTimeZone(tz)) {
            return {
              isError: true,
              content: [{ type: "text", text: `"${tz}" isn't a valid IANA timezone (e.g. Asia/Dhaka, America/Denver).` }],
            };
          }
          const reminder = services.schedule({ kind, text, fireAt, tz });
          return { content: [{ type: "text", text: `Reminder set — ${formatReminder(reminder)}.` }] };
        },
      ),
      tool(
        "list_reminders",
        "List the owner's pending reminders (id, when, timezone, kind, text).",
        {},
        async () => {
          const items = services.list();
          if (items.length === 0) return { content: [{ type: "text", text: "No reminders scheduled." }] };
          return { content: [{ type: "text", text: items.map(formatReminder).join("\n") }] };
        },
      ),
      tool(
        "cancel_reminder",
        "Cancel a pending reminder by its id (e.g. r3).",
        { id: z.string().describe("The reminder id to cancel, e.g. r3.") },
        async ({ id }) => {
          const ok = services.cancel(id);
          return ok
            ? { content: [{ type: "text", text: `Canceled reminder ${id}.` }] }
            : { isError: true, content: [{ type: "text", text: `No reminder with id ${id}.` }] };
        },
      ),
    ],
  });
}
