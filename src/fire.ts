import type { Reminder } from "./reminders.js";

/**
 * Host-provided seams for firing a reminder. Keeping the branching logic pure
 * (this function) separate from the Discord/session plumbing (the hooks) makes
 * the fire flow unit-testable without a live client.
 */
export interface FireHooks {
  /** Mark the reminder fired + persist. Called first, for at-most-once delivery. */
  markFired(id: string): void;
  /** Deliver a notification: DM the owner + post a mentioning line in the thread. */
  nudge(threadId: string, text: string): Promise<void>;
  /** Resume the origin session and inject the text as a prompt. False if the session is gone. */
  wakeSession(reminder: Reminder): Promise<boolean>;
}

/**
 * Fire one due reminder. `nudge` reminders notify; `task` reminders wake the
 * origin session, degrading to a nudge (with a note) if it can't be revived.
 * markFired runs first so an overlapping tick or a crash can't double-send.
 */
export async function dispatchReminder(reminder: Reminder, hooks: FireHooks): Promise<void> {
  hooks.markFired(reminder.id);
  if (reminder.kind === "nudge") {
    await hooks.nudge(reminder.threadId, reminder.text);
    return;
  }
  const woke = await hooks.wakeSession(reminder);
  if (!woke) {
    await hooks.nudge(
      reminder.threadId,
      `${reminder.text}\n(couldn't revive the original session to run this automatically)`,
    );
  }
}
