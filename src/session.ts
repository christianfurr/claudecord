import { query, type Query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AnyThreadChannel, Message } from "discord.js";
import type { Registry, SessionRecord } from "./registry.js";
import type { Settings } from "./config.js";
import { activityLine, chunk, errorEmbed, sessionInfoEmbed, truncate, type SessionStats } from "./format.js";
import { createDiscordMcpServer, type ReminderServices } from "./send-file.js";

/** Push-based async iterable — the SDK's streaming input reads from this. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

/**
 * One Discord message that accumulates quoted activity lines (thinking + tool
 * calls) for the current turn, edited in place with a debounce so a busy
 * session doesn't flood the channel or trip rate limits.
 */
class ActivityFeed {
  private lines: string[] = [];
  private message: Message | undefined;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(private thread: AnyThreadChannel) {}

  add(line: string): void {
    const quoted = `> ${line}`;
    const wouldBe = [...this.lines, quoted].join("\n");
    if (wouldBe.length > 1900) {
      // Current message is full — freeze it and start a new one.
      this.message = undefined;
      this.lines = [quoted];
    } else {
      this.lines.push(quoted);
    }
    this.schedule();
  }

  /** Start a fresh feed message for the next turn. */
  reset(): void {
    if (this.timer) void this.flush();
    this.message = undefined;
    this.lines = [];
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), 1200);
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.flushing || this.lines.length === 0) return;
    this.flushing = true;
    const content = this.lines.join("\n");
    try {
      if (this.message) await this.message.edit(content);
      else this.message = await this.thread.send(content);
    } catch (err) {
      console.error("activity flush failed:", err);
    } finally {
      this.flushing = false;
      // Content may have grown while we were flushing.
      if (this.lines.join("\n") !== content) this.schedule();
    }
  }
}

interface PendingTurn {
  /** The user's Discord message that triggered this turn (for reaction acks). */
  trigger: Message | undefined;
}

export type UserContent = SDKUserMessage["message"]["content"];

/** Build the Agent SDK options for a session. Pure — safe to unit test. */
export function buildQueryOptions(
  record: SessionRecord,
  settings: Settings,
  resumeSessionId?: string,
  forkSession = false,
): Options {
  const model = record.model ?? settings.model;
  return {
    cwd: record.cwd ?? settings.workDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // "project" would load the workDir's CLAUDE.md — which on this machine still
    // carries the legacy tmux-bridge reply rules (dp commands). Claudecord owns
    // message delivery itself, so only user-level settings are loaded.
    settingSources: ["user"],
    ...(model ? { model } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId, forkSession } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        `You are connected to Discord through claudecord. This conversation is a Discord ` +
        `forum post titled "${record.title}". Everything you write is delivered to the post ` +
        `automatically. You cannot post messages or embeds yourself, but you CAN attach a ` +
        `local file to the post by calling the send_file tool (it refuses secret files, paths ` +
        `outside the home directory, and files over 10 MB). Discord renders markdown but not ` +
        `tables-heavy layouts; keep replies conversational and reasonably concise. Your tool ` +
        `activity is mirrored to the post as a live feed. ` +
        `You can get the owner's attention: call ping_me to DM and mention them right now — use it ` +
        `autonomously when something is genuinely worth interrupting for (you're blocked and need ` +
        `input, a long task finished, or you hit an error they'd want to know about), not for routine ` +
        `updates. Call remind_me to schedule a one-shot reminder for later; resolve the time to a ` +
        `concrete fireAt (ISO 8601 with offset) and an IANA tz, defaulting to the host machine's zone ` +
        `unless the user names one. A "nudge" reminder just notifies them at that time; a "task" ` +
        `reminder wakes this session later and hands you the text as a prompt so you can do the thing. ` +
        `list_reminders and cancel_reminder manage pending ones.`,
    },
  };
}

export class SessionRuntime {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q: Query;
  private feed: ActivityFeed;
  private pendingTurns: PendingTurn[] = [];
  private disposed = false;
  private infoMessage: Message | undefined;
  busy = false;
  readonly stats: SessionStats = {
    totalCostUsd: 0,
    userTurns: 0,
    wallMs: 0,
    contextTokens: 0,
    contextWindow: 0,
    startedAt: Date.now(),
  };

  constructor(
    private thread: AnyThreadChannel,
    private record: SessionRecord,
    private registry: Registry,
    settings: Settings,
    services: ReminderServices,
    resumeSessionId?: string,
    forkSession = false,
  ) {
    this.feed = new ActivityFeed(thread);
    this.stats.model = record.model ?? settings.model;
    // buildQueryOptions is pure/testable; mcpServers is thread-specific so it's
    // added here rather than inside the builder.
    const options: Options = {
      ...buildQueryOptions(record, settings, resumeSessionId, forkSession),
      mcpServers: { discord: createDiscordMcpServer(thread, services) },
    };
    this.q = query({ prompt: this.queue, options });
    void this.consume();
  }

  /** Queue a user turn. `trigger` is the Discord message to ack with reactions. */
  send(content: UserContent, trigger?: Message): void {
    if (this.disposed) throw new Error("session runtime is disposed");
    this.pendingTurns.push({ trigger });
    this.busy = true;
    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  /** Switch model mid-session (undefined = back to the Claude Code default). */
  async setModel(model?: string): Promise<void> {
    await this.q.setModel(model);
    this.stats.model = model;
    this.registry.update(this.record.threadId, { model });
    await this.updateInfo();
  }

  async interrupt(): Promise<void> {
    try {
      await this.q.interrupt();
    } catch {
      // Not running — fine.
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.close();
    await this.interrupt();
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.q) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") {
              this.registry.update(this.record.threadId, { sdkSessionId: msg.session_id });
              this.stats.model = msg.model;
            }
            break;

          case "assistant": {
            if (msg.error) {
              await this.failTurn(`Claude API error: ${msg.error}`);
              break;
            }
            const isSubagent = msg.parent_tool_use_id !== null;
            if (!isSubagent && msg.message.usage) {
              const u = msg.message.usage;
              this.stats.contextTokens =
                (u.input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) +
                (u.output_tokens ?? 0);
            }
            for (const block of msg.message.content) {
              if (block.type === "thinking" && !isSubagent) {
                const text = block.thinking?.trim();
                if (text) this.feed.add(`💭 ${truncate(text, 220)}`);
              } else if (block.type === "tool_use") {
                if (block.name === "TodoWrite") continue;
                const line = activityLine(block.name, block.input as Record<string, unknown>);
                this.feed.add(isSubagent ? `　↳ ${line}` : line);
              } else if (block.type === "text" && !isSubagent) {
                const text = block.text.trim();
                if (text) {
                  for (const part of chunk(text)) await this.thread.send(part);
                }
              }
            }
            break;
          }

          case "result": {
            const turn = this.pendingTurns.shift();
            this.busy = this.pendingTurns.length > 0;
            this.feed.reset();
            this.stats.totalCostUsd = msg.total_cost_usd;
            this.stats.userTurns += 1;
            this.stats.wallMs += msg.duration_ms;
            for (const usage of Object.values(msg.modelUsage ?? {})) {
              if (usage.contextWindow > this.stats.contextWindow) {
                this.stats.contextWindow = usage.contextWindow;
              }
            }
            await this.updateInfo();
            if (msg.subtype === "success") {
              await this.ack(turn, "✅");
            } else {
              await this.ack(turn, "❌");
              await this.thread.send({ embeds: [errorEmbed(`Turn ended with: ${msg.subtype}`)] });
            }
            this.registry.update(this.record.threadId, { sdkSessionId: msg.session_id });
            break;
          }

          default:
            break;
        }
      }
    } catch (err) {
      if (!this.disposed) {
        console.error(`session ${this.record.sessionNum} crashed:`, err);
        await this.failTurn(err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async failTurn(message: string): Promise<void> {
    const turn = this.pendingTurns.shift();
    this.busy = this.pendingTurns.length > 0;
    await this.ack(turn, "❌");
    try {
      await this.thread.send({ embeds: [errorEmbed(message)] });
    } catch {
      /* thread may be gone */
    }
  }

  private async updateInfo(): Promise<void> {
    try {
      const embed = sessionInfoEmbed(this.stats);
      if (this.infoMessage) await this.infoMessage.edit({ embeds: [embed] });
      else this.infoMessage = await this.thread.send({ embeds: [embed] });
    } catch (err) {
      console.error("session info update failed:", err);
      this.infoMessage = undefined; // recreate next time (message may have been deleted)
    }
  }

  private async ack(turn: PendingTurn | undefined, emoji: "✅" | "❌"): Promise<void> {
    if (!turn?.trigger) return;
    try {
      await turn.trigger.reactions.cache.get("🤔")?.users.remove(turn.trigger.client.user.id);
      await turn.trigger.react(emoji);
    } catch {
      /* reactions are best-effort */
    }
  }
}
