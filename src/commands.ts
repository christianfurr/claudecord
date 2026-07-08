import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AnyThreadChannel,
} from "discord.js";
import type { Claudecord } from "./bot.js";
import { endedEmbed, errorEmbed, statusEmbed, sessionListEmbed } from "./format.js";
import { listSessions, endSession, endAll, killSession } from "./sessions.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Create the claude-sessions forum channel and wire claudecord to it")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("allow")
    .setDescription("Manage who can use claudecord (owner only)")
    .addUserOption((opt) => opt.setName("user").setDescription("The user to allow or remove").setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Add (default) or remove")
        .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }),
    ),
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a new Claude session — creates a titled post and sends your prompt")
    .addStringOption((opt) =>
      opt.setName("prompt").setDescription("What do you want Claude to do?").setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName("title").setDescription("Post title (defaults to the prompt)").setMaxLength(100),
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show all Claude sessions and bot health"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Reset this session's context (fresh start, same post)"),
  new SlashCommandBuilder()
    .setName("end")
    .setDescription("End this session and archive the post"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Switch this session's model")
    .addStringOption((opt) =>
      opt
        .setName("model")
        .setDescription("Model to use from now on")
        .setRequired(true)
        .addChoices(
          { name: "Default (your Claude Code default)", value: "default" },
          { name: "Opus 4.8", value: "claude-opus-4-8" },
          { name: "Sonnet 5", value: "claude-sonnet-5" },
          { name: "Haiku 4.5", value: "claude-haiku-4-5" },
          { name: "Fable 5", value: "claude-fable-5" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("open")
    .setDescription("Open this session in Terminal on the host Mac (claude --resume)"),
  new SlashCommandBuilder()
    .setName("rename")
    .setDescription("Rename this session's post")
    .addStringOption((opt) =>
      opt.setName("title").setDescription("New title").setRequired(true).setMaxLength(100),
    ),
  new SlashCommandBuilder().setName("sessions").setDescription("List all Claude sessions with status, cost, and age"),
  new SlashCommandBuilder().setName("end-all").setDescription("End every active session (owner only)"),
  new SlashCommandBuilder().setName("kill").setDescription("Force-end this session immediately, even mid-turn"),
].map((builder) => builder.toJSON());

export async function handleCommand(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  // /setup bootstraps ownership when no owner exists yet; everything else is gated.
  const bootstrapping = interaction.commandName === "setup" && !app.settings.ownerId;
  if (!bootstrapping && !app.isAllowed(interaction.user.id)) {
    await interaction.reply({
      content: "🔒 You're not on this bot's allowlist. Ask the owner to run `/allow` for you.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  switch (interaction.commandName) {
    case "setup":
      return handleSetup(app, interaction);
    case "allow":
      return handleAllow(app, interaction);
    case "new":
      return handleNew(app, interaction);
    case "status":
      return handleStatus(app, interaction);
    case "clear":
      return handleClear(app, interaction);
    case "end":
      return handleEnd(app, interaction);
    case "open":
      return handleOpen(app, interaction);
    case "model":
      return handleModel(app, interaction);
    case "rename":
      return handleRename(app, interaction);
    case "sessions":
      return handleSessions(app, interaction);
    case "end-all":
      return handleEndAll(app, interaction);
    case "kill":
      return handleKill(app, interaction);
    default:
      await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
  }
}

async function handleSetup(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "Run this in a server.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!app.settings.ownerId) {
    // First /setup claims ownership — changeable later only via `claudecord owner <id>`.
    app.updateSettings({ ownerId: interaction.user.id });
  }
  try {
    const forum = await interaction.guild.channels.create({
      name: "claude-sessions",
      type: ChannelType.GuildForum,
      topic:
        "Each post is a Claude Code session. Hit “New Post”, give it a title, and describe what you want — Claude answers right in the post.",
      availableTags: [
        { name: "Active", emoji: { id: null, name: "🟢" } },
        { name: "Done", emoji: { id: null, name: "✅" } },
      ],
    });
    const active = forum.availableTags.find((t) => t.name === "Active");
    const done = forum.availableTags.find((t) => t.name === "Done");
    app.updateSettings({
      forumChannelId: forum.id,
      tagActiveId: active?.id,
      tagDoneId: done?.id,
    });
    await interaction.editReply(
      `✅ Created <#${forum.id}>. Create a post there to start your first session.`,
    );
  } catch (err) {
    await interaction.editReply({
      embeds: [errorEmbed(`Setup failed (does the bot have Manage Channels?): ${String(err)}`)],
    });
  }
}

async function handleAllow(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!app.isOwner(interaction.user.id)) {
    await interaction.reply({
      content: "🔒 Only the bot owner can manage the allowlist.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const user = interaction.options.getUser("user", true);
  const action = interaction.options.getString("action") ?? "add";
  const allowlist = new Set(app.settings.allowlist);
  if (action === "add") {
    if (user.bot) {
      await interaction.reply({ content: "Bots can't be allowlisted.", flags: MessageFlags.Ephemeral });
      return;
    }
    allowlist.add(user.id);
    app.updateSettings({ allowlist: [...allowlist] });
    await interaction.reply(`✅ <@${user.id}> can now use claudecord.`);
  } else {
    allowlist.delete(user.id);
    app.updateSettings({ allowlist: [...allowlist] });
    await interaction.reply(`🚫 <@${user.id}> removed from the allowlist.`);
  }
}

async function handleNew(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const title = interaction.options.getString("title") ?? deriveTitle(prompt);
  await interaction.deferReply();
  try {
    const thread = await app.createSessionPost(title, prompt);
    await interaction.editReply(`🧵 Session started: <#${thread.id}>`);
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(String(err))] });
  }
}

/** First sentence-ish of the prompt, cleaned up for a post title. */
function deriveTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const sentenceEnd = oneLine.search(/[.!?]\s/);
  const candidate = sentenceEnd > 8 && sentenceEnd < 90 ? oneLine.slice(0, sentenceEnd) : oneLine;
  return candidate.length <= 90 ? candidate : candidate.slice(0, 89) + "…";
}

async function handleStatus(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const rows = app.registry.all().map((record) => {
    const runtime = app.runtimes.get(record.threadId);
    return { record, live: runtime !== undefined, busy: runtime?.busy ?? false };
  });
  await interaction.reply({
    embeds: [
      statusEmbed(rows, {
        workDir: app.settings.workDir,
        model: app.settings.model,
        uptimeSec: (Date.now() - app.startedAt) / 1000,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

function sessionThread(app: Claudecord, interaction: ChatInputCommandInteraction): AnyThreadChannel | undefined {
  const channel = interaction.channel;
  if (channel?.isThread() && app.isSessionThread(channel)) return channel;
  return undefined;
}

async function handleClear(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  await app.dropRuntime(thread.id);
  app.registry.update(thread.id, { sdkSessionId: undefined, status: "active" });
  app.ensureRuntime(thread, app.registry.get(thread.id)!, { fresh: true });
  await interaction.editReply("🧹 Context cleared — this post now has a fresh session with no memory of the above.");
}

async function handleEnd(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const res = await endSession(app, record.sessionNum);
  if (res.error) {
    await interaction.editReply({ embeds: [errorEmbed(res.error)] });
    return;
  }
  await interaction.editReply({ embeds: [endedEmbed(app.registry.get(thread.id)!)] });
}

async function handleSessions(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ embeds: [sessionListEmbed(listSessions(app))] });
}

async function handleEndAll(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!app.isOwner(interaction.user.id)) {
    await interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const results = await endAll(app);
  const summary = results.length
    ? results.map((r) => `#${r.num}: ${r.error ?? (r.forced ? "ended (forced)" : "ended")}`).join("\n")
    : "No active sessions.";
  await interaction.editReply(summary);
}

async function handleKill(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const res = await killSession(app, record.sessionNum);
  await interaction.editReply(res.error ? `Could not kill: ${res.error}` : `Killed session #${res.num}.`);
}

async function handleModel(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  const choice = interaction.options.getString("model", true);
  const model = choice === "default" ? undefined : choice;
  await interaction.deferReply();
  try {
    const runtime = app.ensureRuntime(thread, record);
    await runtime.setModel(model);
    await interaction.editReply(`🧠 Model set to **${model ?? "default"}** for this session.`);
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(String(err))] });
  }
}

async function handleOpen(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    app.openInTerminal(record);
    await interaction.reply({
      content:
        "🖥️ Opened in Terminal on the host Mac (`claude --resume`). Heads up: it's a live " +
        "fork of this session — turns you take in the terminal won't show up here.",
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await interaction.reply({
      content: `❌ ${err instanceof Error ? err.message : String(err)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleRename(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  const thread = sessionThread(app, interaction);
  const record = thread && app.registry.get(thread.id);
  if (!thread || !record) {
    await interaction.reply({ content: "Run this inside a session post.", flags: MessageFlags.Ephemeral });
    return;
  }
  const title = interaction.options.getString("title", true);
  await thread.setName(title);
  app.registry.update(thread.id, { title });
  await interaction.reply(`✏️ Renamed to **${title}**.`);
}
