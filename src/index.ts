import { Events, REST, Routes } from "discord.js";
import { Claudecord } from "./bot.js";
import { commandDefinitions, handleCommand } from "./commands.js";
import { getDiscordToken } from "./config.js";

const token = getDiscordToken();
const app = new Claudecord();

app.client.once(Events.ClientReady, async (client) => {
  console.log(`claudecord ready as ${client.user.tag}`);

  // Guild commands register instantly (global ones can take an hour).
  const rest = new REST().setToken(token);
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
      body: commandDefinitions,
    });
  }
  console.log(`registered ${commandDefinitions.length} slash commands in ${client.guilds.cache.size} guild(s)`);

  if (!app.settings.forumChannelId) {
    console.log("no forum configured yet — run /setup in your server");
  }
});

app.client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) {
    void handleCommand(app, interaction).catch(console.error);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} — shutting down`);
    void app.shutdown().finally(() => process.exit(0));
  });
}

await app.client.login(token);
