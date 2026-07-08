import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { AttachmentBuilder, type AnyThreadChannel } from "discord.js";
import { z } from "zod";
import { basename } from "node:path";
import { validateOutboundFile } from "./files.js";

/** Fully-qualified name of the tool as Claude sees it (server "discord" + tool "send_file"). */
export const SEND_FILE_TOOL = "mcp__discord__send_file";

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
            const attachment = new AttachmentBuilder(check.path, { name: basename(check.path) });
            await thread.send({
              ...(comment ? { content: comment } : {}),
              files: [attachment],
            });
            const kb = (check.size / 1024).toFixed(0);
            return { content: [{ type: "text", text: `Attached ${basename(check.path)} (${kb} KB) to the post.` }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { isError: true, content: [{ type: "text", text: `Discord rejected the upload: ${msg}` }] };
          }
        },
      ),
    ],
  });
}
