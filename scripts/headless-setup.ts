// Headless equivalent of /setup — creates the forum channel + tags and saves config.
// Useful for testing and for servers where you'd rather run setup from the shell.
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import { getDiscordToken, loadSettings, saveSettings } from "../src/config.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(getDiscordToken());
await new Promise<void>((resolve) => client.once("clientReady", () => resolve()));

const guild = client.guilds.cache.first();
if (!guild) throw new Error("bot is not in any guild");

const forum = await guild.channels.create({
  name: "claude-sessions",
  type: ChannelType.GuildForum,
  topic:
    "Each post is a Claude Code session. Hit “New Post”, give it a title, and describe what you want — Claude answers right in the post.",
  availableTags: [
    { name: "Active", emoji: { id: null, name: "🟢" } },
    { name: "Done", emoji: { id: null, name: "✅" } },
  ],
});

const settings = loadSettings();
settings.forumChannelId = forum.id;
settings.tagActiveId = forum.availableTags.find((t) => t.name === "Active")?.id;
settings.tagDoneId = forum.availableTags.find((t) => t.name === "Done")?.id;
saveSettings(settings);

console.log(`created forum #claude-sessions (${forum.id}) in ${guild.name}; config saved`);
await client.destroy();
