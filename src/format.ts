import { EmbedBuilder, Colors } from "discord.js";
import type { SessionRecord } from "./registry.js";
import type { SessionSummary } from "./sessions.js";

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
      case "mcp__discord__send_file":
        return basename(String(input.path ?? ""));
      case "TodoWrite":
        return ""; // filtered out by caller
      default:
        return "";
    }
  })();
  const label = toolName === "mcp__discord__send_file" ? "send_file" : toolName;
  return detail ? `⏺ **${label}** · ${truncate(detail, 120)}` : `⏺ **${label}**`;
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

export function sessionListEmbed(list: SessionSummary[]): EmbedBuilder {
  const lines = list.length
    ? list
        .map((s) => {
          const state =
            s.status === "ended" ? "✅ ended" : s.busy ? "⚙️ working" : s.live ? "🟢 idle" : "💤 dormant";
          const age = s.ageSec >= 3600 ? `${Math.floor(s.ageSec / 3600)}h` : `${Math.floor(s.ageSec / 60)}m`;
          return `**#${s.num}** ${state} · $${s.costUsd.toFixed(2)} · ${age} — ${s.title}`;
        })
        .join("\n")
    : "_No sessions yet._";
  return new EmbedBuilder().setColor(Colors.Green).setTitle("Sessions").setDescription(lines).setTimestamp();
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export interface SessionStats {
  model?: string;
  totalCostUsd: number;
  userTurns: number;
  wallMs: number;
  contextTokens: number;
  contextWindow: number;
  startedAt: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 90 ? `${min}m ${sec % 60}s` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** Live per-session dashboard, edited in place after every turn. */
export function sessionInfoEmbed(stats: SessionStats): EmbedBuilder {
  const pct = stats.contextWindow > 0 ? (stats.contextTokens / stats.contextWindow) * 100 : 0;
  const color = pct >= 85 ? Colors.Red : pct >= 60 ? Colors.Yellow : Colors.Green;
  const bars = Math.min(10, Math.round(pct / 10));
  const meter = "▰".repeat(bars) + "▱".repeat(10 - bars);
  const context =
    stats.contextWindow > 0
      ? `${meter} ${pct.toFixed(0)}%\n${fmtTokens(stats.contextTokens)} / ${fmtTokens(stats.contextWindow)} tokens`
      : "—";
  return new EmbedBuilder()
    .setColor(color)
    .setTitle("📊 Session info")
    .addFields(
      { name: "Model", value: stats.model ?? "default", inline: true },
      { name: "Cost", value: fmtCost(stats.totalCostUsd), inline: true },
      { name: "Turns", value: String(stats.userTurns), inline: true },
      { name: "Context", value: context, inline: true },
      { name: "Time working", value: fmtDuration(stats.wallMs), inline: true },
      { name: "Session age", value: formatUptime((Date.now() - stats.startedAt) / 1000), inline: true },
    )
    .setFooter({ text: "updates after each turn" })
    .setTimestamp();
}
