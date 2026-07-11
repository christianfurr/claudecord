import type { Client, MessageCreateOptions } from "discord.js";

/**
 * Delivery helpers over the Discord client, isolating all DM/mention logic in
 * one place so the host stays simple and the mention wiring is unit-testable.
 * Both helpers are best-effort: they swallow and log their own failures and
 * report success as a boolean, so a closed DM never blocks a thread post and a
 * deleted thread never blocks a DM.
 */

/** Build the send payload for a thread post, opting the owner into a real ping. */
export function mentionPayload(text: string, mentionUserId?: string): MessageCreateOptions {
  if (!mentionUserId) return { content: text };
  return {
    content: `<@${mentionUserId}> ${text}`,
    // Only the owner is pinged; nothing else in the text can trigger a mention.
    allowedMentions: { parse: [], users: [mentionUserId] },
  };
}

export async function dmOwner(client: Client, ownerId: string | undefined, text: string): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const user = await client.users.fetch(ownerId);
    await user.send(text);
    return true;
  } catch (err) {
    console.error("dmOwner failed:", err);
    return false;
  }
}

export async function postToThread(
  client: Client,
  threadId: string,
  text: string,
  mentionUserId?: string,
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) return false;
    if (channel.archived) await channel.setArchived(false).catch(() => undefined);
    await channel.send(mentionPayload(text, mentionUserId));
    return true;
  } catch (err) {
    console.error("postToThread failed:", err);
    return false;
  }
}
