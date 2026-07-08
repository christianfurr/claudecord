import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
// No dotenv needed — Bun loads .env automatically.

export const CONFIG_DIR = join(homedir(), ".claudecord");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Mutable settings written by /setup and editable by hand.
const settingsSchema = z.object({
  forumChannelId: z.string().optional(),
  tagActiveId: z.string().optional(),
  tagDoneId: z.string().optional(),
  workDir: z.string().default(join(homedir(), "Code")),
  model: z.string().optional(),
  /** App used by /open. "Ghostty" or "Terminal" (or any app that can run a .command file). */
  terminal: z.string().default("Ghostty"),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  if (!existsSync(CONFIG_FILE)) return settingsSchema.parse({});
  return settingsSchema.parse(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
}

export function saveSettings(settings: Settings): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2) + "\n");
}

// Secrets come from the environment (or a local .env).
export function getDiscordToken(): string {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error(
      "DISCORD_TOKEN is not set. Export it or put it in a .env file next to package.json (Bun loads .env automatically).",
    );
  }
  return token;
}
