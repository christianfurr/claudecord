import { join, basename } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { z } from "zod";
import { CONFIG_DIR } from "./config.js";

/**
 * File-drop channel that lets agents *outside* claudecord DM the owner. Mirrors
 * `handoffs.ts`: an external process (via the `dm_me` stdio MCP tool) drops a
 * validated JSON file here; the daemon watches the dir, delivers a DM, and
 * deletes it. Same trust model as handoffs — the filesystem is the boundary.
 */

export const NOTIFY_DIR = join(CONFIG_DIR, "notifications");
export const NOTIFY_FAILED_DIR = join(NOTIFY_DIR, "failed");

/** Discord DM length ceiling; keeps a runaway agent from sending a novel. */
export const MAX_MESSAGE_LEN = 2000;
export const MAX_FROM_LEN = 100;

const notifySchema = z.object({
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  from: z.string().max(MAX_FROM_LEN).optional(),
  createdAt: z.string().min(1),
});

export type NotificationRequest = z.infer<typeof notifySchema>;

let counter = 0;

/**
 * Atomically write a notification request; returns the file path. Notifications
 * have no natural key (unlike a handoff's sessionId), so the filename combines a
 * timestamp with a monotonic counter to avoid collisions when several land in
 * the same millisecond.
 */
export function writeNotification(req: NotificationRequest, dir = NOTIFY_DIR, now = Date.now()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${now}-${counter++}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(req, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

/** Read + validate a notification file. Throws on malformed JSON or bad fields. */
export function readNotification(path: string): NotificationRequest {
  return notifySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Move a notification file into failed/ (never silently drop a request). */
export function quarantineNotification(path: string, now = Date.now()): void {
  mkdirSync(NOTIFY_FAILED_DIR, { recursive: true });
  renameSync(path, join(NOTIFY_FAILED_DIR, `${now}-${basename(path)}`));
}
