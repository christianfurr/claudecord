import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Message,
} from "discord.js";
import { Registry, type SessionRecord } from "./registry.js";
import { loadSettings, saveSettings, type Settings } from "./config.js";
import { SessionRuntime, type UserContent } from "./session.js";
import { welcomeEmbed } from "./format.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class Claudecord {
  readonly client: Client;
  readonly registry = new Registry();
  readonly runtimes = new Map<string, SessionRuntime>();
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

  ensureRuntime(thread: AnyThreadChannel, record: SessionRecord, fresh = false): SessionRuntime {
    const existing = this.runtimes.get(thread.id);
    if (existing && !fresh) return existing;
    const runtime = new SessionRuntime(
      thread,
      record,
      this.registry,
      this.settings,
      fresh ? undefined : record.sdkSessionId,
    );
    this.runtimes.set(thread.id, runtime);
    return runtime;
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

  private async buildContent(message: Message): Promise<UserContent> {
    const blocks: Exclude<UserContent, string> = [];
    const text = message.content.trim();
    if (text) blocks.push({ type: "text", text });

    for (const attachment of message.attachments.values()) {
      const mediaType = attachment.contentType?.split(";")[0] ?? "";
      if (!IMAGE_TYPES.has(mediaType) || attachment.size > MAX_IMAGE_BYTES) {
        blocks.push({
          type: "text",
          text: `[The user attached a file that couldn't be inlined: ${attachment.name} (${mediaType || "unknown type"}, ${attachment.size} bytes) — ${attachment.url}]`,
        });
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

  async applyTag(thread: AnyThreadChannel, tag: "active" | "done"): Promise<void> {
    const tagId = tag === "active" ? this.settings.tagActiveId : this.settings.tagDoneId;
    if (!tagId) return;
    try {
      await thread.setAppliedTags([tagId]);
    } catch (err) {
      console.error("failed to apply tag:", err);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.dispose()));
    await this.client.destroy();
  }
}

export function forumChannelTypeGuard(type: ChannelType): boolean {
  return type === ChannelType.GuildForum;
}
