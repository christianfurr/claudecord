import { Events, REST, Routes } from "discord.js";
import { existsSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { Claudecord } from "./bot.js";
import { commandDefinitions, handleCommand } from "./commands.js";
import { getDiscordToken } from "./config.js";
import { startControlServer, CONTROL_SOCKET } from "./control.js";

const token = getDiscordToken();
const app = new Claudecord();
let control: Server | undefined;

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

  control = startControlServer(app);
  console.log(`control socket listening at ${CONTROL_SOCKET}`);
});

app.client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.isChatInputCommand()) {
    void handleCommand(app, interaction).catch(console.error);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} — shutting down`);
    control?.close();
    if (existsSync(CONTROL_SOCKET)) unlinkSync(CONTROL_SOCKET);
    void app.shutdown().finally(() => process.exit(0));
  });
}

await app.client.login(token);
