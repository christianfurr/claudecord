import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findLatestSessionId, writeHandoff, HANDOFF_DIR } from "./handoffs.js";
import { writeNotification, NOTIFY_DIR, MAX_MESSAGE_LEN, MAX_FROM_LEN } from "./notifications.js";

interface RunDmOpts {
  message: string;
  from?: string;
  now?: string;
  dir?: string;
}

/** Core of the dm_me tool: queue a notification file for the daemon to deliver. */
export function runDm(opts: RunDmOpts): { message: string; path: string } {
  const path = writeNotification(
    { message: opts.message, from: opts.from?.trim() || undefined, createdAt: opts.now ?? new Date().toISOString() },
    opts.dir ?? NOTIFY_DIR,
  );
  return {
    message: "Notification queued — the owner will get a DM shortly.",
    path,
  };
}

interface RunHandoffOpts {
  cwd: string;
  title?: string;
  home?: string;
  now?: string;
  dir?: string;
}

/** Core of the handoff tool: find the live session, queue a handoff file. */
export function runHandoff(opts: RunHandoffOpts): { message: string; path: string } {
  const cwd = opts.cwd;
  const home = opts.home ?? homedir();
  const sessionId = findLatestSessionId(cwd, home);
  const title = opts.title?.trim() || `${cwd.split("/").filter(Boolean).pop() ?? "session"} (handoff)`;
  const path = writeHandoff(
    { sessionId, cwd, title, createdAt: opts.now ?? new Date().toISOString() },
    opts.dir ?? HANDOFF_DIR,
  );
  return {
    message:
      "Handoff queued — a Discord post will appear shortly and continue this conversation. " +
      "You can leave; pick it back up from Discord.",
    path,
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "claudecord", version: "0.1.0" });

  server.tool(
    "handoff_to_discord",
    "Continue this Claude Code session in Discord (claudecord). Call when the user wants to " +
      "leave their machine and keep the conversation going from Discord. Creates a Discord " +
      "forum post that resumes this conversation's history.",
    { title: z.string().optional().describe("Optional title for the Discord post.") },
    async ({ title }) => {
      try {
        const { message } = runHandoff({
          cwd: process.env.CLAUDECORD_HANDOFF_CWD ?? process.cwd(),
          title,
        });
        return { content: [{ type: "text", text: message }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Handoff failed: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "dm_me",
    "Send the claudecord owner a Discord DM from outside claudecord. Use this from any agent " +
      "or Claude Code session on this machine to get the owner's attention — a build finished, a " +
      "job needs input, an error they'd want to know about. Delivery is a DM only: it cannot post " +
      "in a channel, run a turn, or wake a session. Pass `from` so the owner knows which agent " +
      "pinged them. The message is rendered in a Discord embed, so format it with Discord " +
      "markdown when it improves readability: **bold**, *italics*, `inline code`, ```code " +
      "blocks```, > quotes, - bullet lists, and [links](https://example.com).",
    {
      message: z
        .string()
        .max(MAX_MESSAGE_LEN)
        .describe(
          "The message to DM the owner. Supports Discord markdown (bold, italics, code, lists, " +
            "links) — use it for a cleaner view when the content warrants structure.",
        ),
      from: z
        .string()
        .max(MAX_FROM_LEN)
        .optional()
        .describe("Optional label for who is sending this, e.g. 'rust-academy build'."),
    },
    async ({ message, from }) => {
      try {
        const { message: reply } = runDm({ message, from });
        return { content: [{ type: "text", text: reply }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `DM failed: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
