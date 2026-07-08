import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { AttachmentBuilder, type AnyThreadChannel } from "discord.js";
import { z } from "zod";
import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isDatalessStat, validateOutboundFile } from "./files.js";

/** Fully-qualified name of the tool as Claude sees it (server "discord" + tool "send_file"). */
export const SEND_FILE_TOOL = "mcp__discord__send_file";

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
export function createDiscordFileServer(thread: AnyThreadChannel) {
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
    ],
  });
}
