import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AnyThreadChannel,
} from "discord.js";
import type { Claudecord } from "./bot.js";
import { endedEmbed, errorEmbed, statusEmbed } from "./format.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Create the claude-sessions forum channel and wire claudecord to it")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
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
    .setName("rename")
    .setDescription("Rename this session's post")
    .addStringOption((opt) =>
      opt.setName("title").setDescription("New title").setRequired(true).setMaxLength(100),
    ),
].map((builder) => builder.toJSON());

export async function handleCommand(app: Claudecord, interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case "setup":
      return handleSetup(app, interaction);
    case "status":
      return handleStatus(app, interaction);
    case "clear":
      return handleClear(app, interaction);
    case "end":
      return handleEnd(app, interaction);
    case "rename":
      return handleRename(app, interaction);
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
  app.ensureRuntime(thread, app.registry.get(thread.id)!, true);
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
  await app.dropRuntime(thread.id);
  const updated = app.registry.update(thread.id, { status: "ended" });
  await app.applyTag(thread, "done");
  await interaction.editReply({ embeds: [endedEmbed(updated)] });
  await thread.setArchived(true).catch(() => undefined);
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
