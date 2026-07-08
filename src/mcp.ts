import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findLatestSessionId, writeHandoff, HANDOFF_DIR } from "./handoffs.js";

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

  await server.connect(new StdioServerTransport());
}
