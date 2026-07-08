import { query, type Query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AnyThreadChannel, Message } from "discord.js";
import type { Registry, SessionRecord } from "./registry.js";
import type { Settings } from "./config.js";
import { activityLine, chunk, errorEmbed, truncate } from "./format.js";

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

export class SessionRuntime {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q: Query;
  private feed: ActivityFeed;
  private pendingTurns: PendingTurn[] = [];
  private disposed = false;
  busy = false;

  constructor(
    private thread: AnyThreadChannel,
    private record: SessionRecord,
    private registry: Registry,
    settings: Settings,
    resumeSessionId?: string,
  ) {
    this.feed = new ActivityFeed(thread);
    const options: Options = {
      cwd: settings.workDir,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // "project" would load the workDir's CLAUDE.md — which on this machine still
      // carries the legacy tmux-bridge reply rules (dp commands). Claudecord owns
      // message delivery itself, so only user-level settings are loaded.
      settingSources: ["user"],
      ...(settings.model ? { model: settings.model } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          `You are connected to Discord through claudecord. This conversation is a Discord ` +
        `forum post titled "${record.title}". Everything you write is delivered to the post ` +
        `automatically — never try to send Discord messages yourself. Discord renders ` +
          `markdown but not tables-heavy layouts; keep replies conversational and reasonably ` +
          `concise. Your tool activity is mirrored to the post as a live feed.`,
      },
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
            }
            break;

          case "assistant": {
            if (msg.error) {
              await this.failTurn(`Claude API error: ${msg.error}`);
              break;
            }
            const isSubagent = msg.parent_tool_use_id !== null;
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
