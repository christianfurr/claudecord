import { EmbedBuilder, Colors } from "discord.js";
import type { SessionRecord } from "./registry.js";

const DISCORD_MESSAGE_LIMIT = 2000;

/** Split text into Discord-sized chunks, preferring newline boundaries. */
export function chunk(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit; // no good newline — hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

/** One-line summary of a tool call, for the live activity feed. */
export function activityLine(toolName: string, input: Record<string, unknown>): string {
  const detail = (() => {
    switch (toolName) {
      case "Bash":
        return String(input.description ?? input.command ?? "");
      case "Read":
      case "Write":
      case "Edit":
      case "NotebookEdit":
        return basename(String(input.file_path ?? ""));
      case "Glob":
      case "Grep":
        return String(input.pattern ?? "");
      case "WebFetch":
        return String(input.url ?? "");
      case "WebSearch":
        return String(input.query ?? "");
      case "Task":
      case "Agent":
        return String(input.description ?? "");
      case "TodoWrite":
        return ""; // filtered out by caller
      default:
        return "";
    }
  })();
  return detail ? `⏺ **${toolName}** · ${truncate(detail, 120)}` : `⏺ **${toolName}**`;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function welcomeEmbed(record: SessionRecord, workDir: string, model?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`Session ${record.sessionNum} started`)
    .setDescription("Claude is on it — activity streams below as it works.")
    .addFields(
      { name: "Working directory", value: `\`${workDir}\``, inline: true },
      ...(model ? [{ name: "Model", value: model, inline: true }] : []),
    )
    .setTimestamp();
}

export function endedEmbed(record: SessionRecord, extra?: { turns?: number; costUsd?: number }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`Session ${record.sessionNum} ended`)
    .setDescription(`**${record.title}** — thanks for the chat. Post again to revive it.`)
    .setTimestamp();
  if (extra?.turns !== undefined) embed.addFields({ name: "Turns", value: String(extra.turns), inline: true });
  if (extra?.costUsd !== undefined)
    embed.addFields({ name: "Cost", value: `$${extra.costUsd.toFixed(2)}`, inline: true });
  return embed;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("Something went wrong")
    .setDescription(truncate(message, 1000))
    .setTimestamp();
}

export function statusEmbed(
  rows: Array<{ record: SessionRecord; live: boolean; busy: boolean }>,
  meta: { workDir: string; model?: string; uptimeSec: number },
): EmbedBuilder {
  const lines = rows.length
    ? rows
        .map(({ record, live, busy }) => {
          const state =
            record.status === "ended" ? "✅ done" : busy ? "⚙️ working" : live ? "🟢 idle" : "💤 dormant";
          return `**#${record.sessionNum}** <#${record.threadId}> — ${state}`;
        })
        .join("\n")
    : "_No sessions yet — create a post to start one._";
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("claudecord status")
    .setDescription(lines)
    .addFields(
      { name: "Working directory", value: `\`${meta.workDir}\``, inline: true },
      { name: "Model", value: meta.model ?? "default", inline: true },
      { name: "Uptime", value: formatUptime(meta.uptimeSec), inline: true },
    )
    .setTimestamp();
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
