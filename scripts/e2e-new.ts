// End-to-end test of the /new pipeline: creates a real session post, feeds it a
// prompt, and verifies Claude's reply lands in the thread. Run with the daemon
// STOPPED (two clients sharing the registry file will fight).
import { Events } from "discord.js";
import { Claudecord } from "../src/bot.js";
import { getDiscordToken } from "../src/config.js";

const app = new Claudecord();
const replies: string[] = [];
let threadId = "";

app.client.on(Events.MessageCreate, (message) => {
  if (message.channelId === threadId && message.author.id === app.client.user?.id) {
    replies.push(message.content || "(embed/feed)");
    console.log("posted to thread:", (message.content || "(embed/feed)").slice(0, 120));
  }
});

await app.client.login(getDiscordToken());
await new Promise<void>((resolve) => app.client.once(Events.ClientReady, () => resolve()));
console.log("client ready — creating session post via the /new code path");

const thread = await app.createSessionPost(
  "e2e: pipeline check",
  "Reply with exactly this text and nothing else: E2E OK. Do not use any tools.",
);
threadId = thread.id;
console.log("post created:", thread.id);

const runtime = app.runtimes.get(thread.id);
if (!runtime) throw new Error("no runtime started");

const deadline = Date.now() + 180_000;
while (runtime.busy && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
}

const ok = !runtime.busy && replies.some((r) => r.includes("E2E OK"));
console.log(ok ? "✅ E2E PASS — reply delivered to Discord" : `❌ E2E FAIL — busy=${runtime.busy}, replies=${JSON.stringify(replies)}`);

await app.shutdown();
process.exit(ok ? 0 : 1);
