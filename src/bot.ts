import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Attachment,
  type Message,
} from "discord.js";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, type SessionRecord } from "./registry.js";
import { CONFIG_DIR, loadSettings, saveSettings, type Settings } from "./config.js";
import { SessionRuntime, type UserContent } from "./session.js";
import { welcomeEmbed, endedEmbed } from "./format.js";
import { readHandoff, quarantineHandoff, HANDOFF_DIR, type HandoffRequest } from "./handoffs.js";
import { MAX_INBOUND_BYTES, sanitizeFilename } from "./files.js";
import type { RuntimeInfo, SessionServiceHost } from "./sessions.js";
import { ReminderStore, type Reminder } from "./reminders.js";
import { Scheduler } from "./scheduler.js";
import { dmOwner, postToThread } from "./notify.js";
import { dispatchReminder } from "./fire.js";
import type { ReminderServices } from "./send-file.js";
import {
  currentSha,
  runPreflight,
  writeRestartMarker,
  readRestartMarker,
  clearRestartMarker,
  type RestartOptions,
  type RestartResult,
} from "./restart.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// src/bot.ts is at <repo>/src/bot.ts, so up two dirs is the repo root.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class Claudecord implements SessionServiceHost {
  readonly client: Client;
  readonly registry = new Registry();
  readonly runtimes = new Map<string, SessionRuntime>();
  readonly reminders = new ReminderStore();
  private scheduler: Scheduler | undefined;
  settings: Settings;
  readonly startedAt = Date.now();

  constructor() {
    this.settings = loadSettings();
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    this.client.on("threadCreate", (thread, newlyCreated) => {
      if (newlyCreated) void this.onThreadCreate(thread).catch(console.error);
    });
    this.client.on("messageCreate", (message) => {
      void this.onMessage(message).catch(console.error);
    });
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
  }

  isOwner(userId: string): boolean {
    return this.settings.ownerId === userId;
  }

  isAllowed(userId: string): boolean {
    return this.isOwner(userId) || this.settings.allowlist.includes(userId);
  }

  isSessionThread(thread: AnyThreadChannel): boolean {
    return (
      this.settings.forumChannelId !== undefined &&
      thread.parentId === this.settings.forumChannelId
    );
  }

  private async onThreadCreate(thread: AnyThreadChannel): Promise<void> {
    if (!this.isSessionThread(thread)) return;
    const record = this.registry.get(thread.id) ?? this.registry.create(thread.id, thread.name);
    await this.applyTag(thread, "active");
    await thread.send({ embeds: [welcomeEmbed(record, this.settings.workDir, this.settings.model)] });
    // The starter message arrives via messageCreate and starts the first turn.
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.channel.isThread()) return;
    const thread = message.channel;
    if (!this.isSessionThread(thread)) return;
    if (message.content.startsWith("/")) return; // slash commands come via interactions
    if (!this.isAllowed(message.author.id)) {
      await message.react("🔒").catch(() => undefined);
      return;
    }

    let record = this.registry.get(thread.id);
    if (!record) record = this.registry.create(thread.id, thread.name);

    if (record.status === "ended") {
      record = this.registry.update(thread.id, { status: "active" });
      await this.applyTag(thread, "active");
      if (thread.archived) await thread.setArchived(false).catch(() => undefined);
    }

    await message.react("🤔").catch(() => undefined);
    const runtime = this.ensureRuntime(thread, record);
    runtime.send(await this.buildContent(message), message);
  }

  ensureRuntime(
    thread: AnyThreadChannel,
    record: SessionRecord,
    opts: { fresh?: boolean; forkSession?: boolean } = {},
  ): SessionRuntime {
    const existing = this.runtimes.get(thread.id);
    if (existing && !opts.fresh) return existing;
    const runtime = new SessionRuntime(
      thread,
      record,
      this.registry,
      this.settings,
      this.reminderServices(thread, record),
      opts.fresh ? undefined : record.sdkSessionId,
      opts.forkSession ?? false,
    );
    this.runtimes.set(thread.id, runtime);
    return runtime;
  }

  /**
   * Per-session reminder/ping surface handed to the MCP tools. Closes over the
   * thread + record so `remind_me` captures the origin session (for `task`
   * reminders) and `ping_me` lands in the right post. The store and client stay
   * hidden behind this narrow interface.
   */
  private reminderServices(thread: AnyThreadChannel, record: SessionRecord): ReminderServices {
    return {
      ownerId: this.settings.ownerId,
      schedule: (args) =>
        this.reminders.add({
          threadId: thread.id,
          sdkSessionId: this.registry.get(thread.id)?.sdkSessionId ?? record.sdkSessionId,
          cwd: record.cwd,
          ...args,
        }),
      list: () => this.reminders.all(),
      cancel: (id) => this.reminders.remove(id),
      pingOwner: (text) => this.pingOwner(thread.id, text),
    };
  }

  /** Start the reminder scheduler. Called once the client is ready. */
  startScheduler(): void {
    if (this.scheduler) return;
    this.scheduler = new Scheduler(this.reminders, (r) => this.fireReminder(r));
    this.scheduler.start();
  }

  /** DM the owner and post a mentioning line in a thread — the shared ping path. */
  private async pingOwner(threadId: string, text: string): Promise<void> {
    await Promise.allSettled([
      dmOwner(this.client, this.settings.ownerId, text),
      postToThread(this.client, threadId, text, this.settings.ownerId),
    ]);
  }

  /** Fire a due reminder. Branching logic lives in the pure `dispatchReminder`. */
  private fireReminder(reminder: Reminder): Promise<void> {
    return dispatchReminder(reminder, {
      markFired: (id) => this.reminders.markFired(id),
      nudge: (threadId, text) => this.fireNudge(threadId, text),
      wakeSession: (r) => this.wakeSession(r),
    });
  }

  /**
   * Resume the origin session for a `task` reminder and inject its text as a
   * prompt. Returns false if the session's thread/record is gone, so the caller
   * can degrade to a nudge.
   */
  private async wakeSession(reminder: Reminder): Promise<boolean> {
    const record = this.registry.get(reminder.threadId);
    const channel = await this.client.channels.fetch(reminder.threadId).catch(() => null);
    if (!record || !channel || !channel.isThread()) return false;
    await dmOwner(this.client, this.settings.ownerId, `⏰ starting: ${reminder.text}`);
    if (channel.archived) await channel.setArchived(false).catch(() => undefined);
    const runtime = this.ensureRuntime(channel, record);
    runtime.send([{ type: "text", text: reminder.text }]);
    return true;
  }

  private async fireNudge(threadId: string, text: string): Promise<void> {
    const line = `⏰ ${text}`;
    await Promise.allSettled([
      dmOwner(this.client, this.settings.ownerId, line),
      postToThread(this.client, threadId, line, this.settings.ownerId),
    ]);
  }

  async dropRuntime(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      this.runtimes.delete(threadId);
      await runtime.dispose();
    }
  }

  /**
   * Create a session post programmatically (used by /new). The starter message
   * is bot-authored, so the messageCreate handler ignores it — we feed the
   * prompt to the session directly and use the starter message for acks.
   */
  async createSessionPost(title: string, prompt: string): Promise<AnyThreadChannel> {
    if (!this.settings.forumChannelId) throw new Error("No forum configured — run /setup first.");
    const forum = await this.client.channels.fetch(this.settings.forumChannelId);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      throw new Error("Configured forum channel is missing — re-run /setup.");
    }
    const thread = await forum.threads.create({
      name: title.slice(0, 100),
      message: { content: prompt },
      appliedTags: this.settings.tagActiveId ? [this.settings.tagActiveId] : [],
    });
    const record = this.registry.get(thread.id) ?? this.registry.create(thread.id, thread.name);
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) await starter.react("🤔").catch(() => undefined);
    const runtime = this.ensureRuntime(thread, record);
    runtime.send([{ type: "text", text: prompt }], starter ?? undefined);
    return thread;
  }

  /**
   * Create a session post that resumes a terminal Claude session (handoff).
   * Forks a new session id from the terminal's history so the terminal's own
   * .jsonl is never written to. No prompt is sent — the user's first Discord
   * message becomes the next turn.
   */
  async createHandoffPost(req: HandoffRequest): Promise<void> {
    if (!this.settings.forumChannelId) throw new Error("No forum configured — run /setup first.");
    const forum = await this.client.channels.fetch(this.settings.forumChannelId);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      throw new Error("Configured forum channel is missing — re-run /setup.");
    }
    const thread = await forum.threads.create({
      name: req.title.slice(0, 100),
      message: {
        content: "↩ Continued from your terminal session. Send a message to pick up where you left off.",
      },
      appliedTags: this.settings.tagActiveId ? [this.settings.tagActiveId] : [],
    });
    this.registry.get(thread.id) ?? this.registry.create(thread.id, req.title);
    const record = this.registry.update(thread.id, { sdkSessionId: req.sessionId, cwd: req.cwd });
    // Pre-create the runtime with forkSession so the resume branches a new id
    // (recorded via system:init) before any turn touches the terminal's file.
    this.ensureRuntime(thread, record, { forkSession: true });
  }

  /** Drain any pending handoff files, then watch the directory for new ones. */
  startHandoffWatcher(): void {
    mkdirSync(HANDOFF_DIR, { recursive: true });
    for (const name of readdirSync(HANDOFF_DIR)) {
      if (name.endsWith(".json")) void this.processHandoffFile(join(HANDOFF_DIR, name));
    }
    watch(HANDOFF_DIR, (_event, filename) => {
      if (filename && filename.endsWith(".json")) {
        void this.processHandoffFile(join(HANDOFF_DIR, filename));
      }
    });
  }

  private async processHandoffFile(path: string): Promise<void> {
    let req: HandoffRequest;
    try {
      req = readHandoff(path);
    } catch {
      return; // partial write / .tmp rename in flight, or already processed — ignore
    }
    try {
      await this.createHandoffPost(req);
      unlinkSync(path);
    } catch (err) {
      console.error("handoff failed:", err);
      try {
        quarantineHandoff(path);
      } catch {
        /* file may already be gone */
      }
    }
  }

  /**
   * Open a session in Terminal.app on this machine via `claude --resume`.
   * A .command file avoids the macOS automation-permission prompt that
   * scripting Terminal with osascript would trigger.
   */
  openInTerminal(record: SessionRecord): void {
    if (!record.sdkSessionId) {
      throw new Error("This session hasn't completed a turn yet — nothing to resume.");
    }
    const dir = join(CONFIG_DIR, "open");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `session-${record.sessionNum}.command`);
    writeFileSync(
      file,
      `#!/bin/zsh\n` +
        `# claudecord: open session ${record.sessionNum} ("${record.title.replace(/"/g, "'")}")\n` +
        `cd "${this.settings.workDir}"\n` +
        `exec zsh -ic 'claude --resume "${record.sdkSessionId}"'\n`,
    );
    chmodSync(file, 0o755);
    if (this.settings.terminal === "Ghostty") {
      // Ghostty takes the command to run via --args -e; a new instance = a new window.
      spawn("open", ["-na", "Ghostty", "--args", "-e", file], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("open", ["-a", this.settings.terminal, file], { detached: true, stdio: "ignore" }).unref();
    }
  }

  private async buildContent(message: Message): Promise<UserContent> {
    const blocks: Exclude<UserContent, string> = [];
    const text = message.content.trim();
    if (text) blocks.push({ type: "text", text });

    for (const attachment of message.attachments.values()) {
      const mediaType = attachment.contentType?.split(";")[0] ?? "";
      if (!IMAGE_TYPES.has(mediaType) || attachment.size > MAX_IMAGE_BYTES) {
        // Non-image (or oversized image): save to disk and hand Claude the path
        // so it can open the file with its Read tool.
        blocks.push({ type: "text", text: await this.saveAttachment(message.channelId, attachment) });
        continue;
      }
      const res = await fetch(attachment.url);
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType as "image/png", data },
      });
    }

    if (blocks.length === 0) blocks.push({ type: "text", text: "(empty message)" });
    return blocks;
  }

  /**
   * Download a non-inlineable attachment into the session inbox and return a text
   * block telling Claude where it landed. Falls back to a URL note if the download
   * fails or the file is too large, so the turn still proceeds.
   */
  private async saveAttachment(threadId: string, attachment: Attachment): Promise<string> {
    const type = attachment.contentType?.split(";")[0] || "unknown type";
    if (attachment.size > MAX_INBOUND_BYTES) {
      return `[The user attached ${attachment.name} (${type}, ${attachment.size} bytes) — too large to download (limit ${MAX_INBOUND_BYTES} bytes). URL: ${attachment.url}]`;
    }
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dir = join(CONFIG_DIR, "inbox", threadId);
      mkdirSync(dir, { recursive: true });
      const name = sanitizeFilename(attachment.name ?? "file");
      const dest = join(dir, name);
      writeFileSync(dest, buf);
      return `[The user attached ${name} (${type}, ${buf.length} bytes) — saved to ${dest}. Use your Read tool to open it.]`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[The user attached ${attachment.name} but it couldn't be downloaded (${msg}). URL: ${attachment.url}]`;
    }
  }

  async applyTag(thread: AnyThreadChannel, tag: "active" | "done"): Promise<void> {
    const tagId = tag === "active" ? this.settings.tagActiveId : this.settings.tagDoneId;
    if (!tagId) return;
    try {
      await thread.setAppliedTags([tagId]);
    } catch (err) {
      console.error("failed to apply tag:", err);
    }
  }

  runtimeInfo(threadId: string): RuntimeInfo | undefined {
    const rt = this.runtimes.get(threadId);
    if (!rt) return undefined;
    return { busy: rt.busy, costUsd: rt.stats.totalCostUsd, turns: rt.stats.userTurns, model: rt.stats.model };
  }

  async archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void> {
    const record = this.registry.get(threadId);
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    if (!channel || !channel.isThread()) return;
    await this.applyTag(channel, "done");
    if (record) await channel.send({ embeds: [endedEmbed(record, summary)] }).catch(() => undefined);
    await channel.setArchived(true).catch(() => undefined);
  }

  /**
   * Clean restart shared by /restart, the CLI, and the in-session `restart` tool.
   * Typecheck-gates (unless skipped), posts a note to the requesting thread, writes
   * a marker for the boot confirmation, then exits — launchd (KeepAlive) revives the
   * daemon on the new code. Context survives: sessions resume from sdkSessionId on
   * their next message. The exit is delayed so the caller's reply/tool result flushes.
   */
  async requestRestart(opts: RestartOptions = {}): Promise<RestartResult> {
    const sha = currentSha(REPO_ROOT);
    if (!opts.skipPreflight) {
      const pre = runPreflight(REPO_ROOT);
      if (!pre.ok) return { ok: false, sha, error: pre.output || "typecheck failed" };
    }
    if (opts.threadId) {
      const channel = await this.client.channels.fetch(opts.threadId).catch(() => null);
      if (channel?.isThread()) {
        await channel.send(`🔄 restarting on \`${sha}\`…`).catch(() => undefined);
      }
    }
    try {
      writeRestartMarker({ threadId: opts.threadId, sha, requestedAt: new Date().toISOString() });
    } catch (err) {
      console.error("restart marker write failed:", err); // restart matters more than the confirmation
    }
    setTimeout(() => process.exit(0), opts.exitDelayMs ?? 300).unref();
    return { ok: true, sha };
  }

  /**
   * On boot: if a restart marker is present, post a "back online" confirmation to
   * the thread that requested the restart, then clear it. If the daemon never
   * reaches here (broken new code), the missing confirmation is the health signal.
   */
  async consumeRestartMarker(): Promise<void> {
    const marker = readRestartMarker();
    if (!marker) return;
    clearRestartMarker();
    if (!marker.threadId) return;
    const channel = await this.client.channels.fetch(marker.threadId).catch(() => null);
    if (channel?.isThread()) {
      await channel.send(`✅ back online — running \`${marker.sha}\``).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler?.stop();
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.dispose()));
    await this.client.destroy();
  }
}

export function forumChannelTypeGuard(type: ChannelType): boolean {
  return type === ChannelType.GuildForum;
}
