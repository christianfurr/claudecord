// Smoke test: verify the Agent SDK runs with this machine's existing auth and
// that thinking/tool blocks appear in the stream.
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "What is 17 * 23? Reply with just the number.",
  options: { maxTurns: 1 },
});

for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("INIT ok — apiKeySource:", msg.apiKeySource, "| model:", msg.model);
  } else if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      console.log("BLOCK:", block.type, block.type === "text" ? block.text : "");
    }
  } else if (msg.type === "result") {
    console.log("RESULT:", msg.subtype, "| turns:", msg.num_turns, "| cost:", msg.total_cost_usd);
  }
}
