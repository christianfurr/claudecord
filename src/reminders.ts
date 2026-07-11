import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { CONFIG_DIR } from "./config.js";

function remindersFile(): string {
  return join(process.env.CLAUDECORD_HOME ?? CONFIG_DIR, "reminders.json");
}

export type ReminderKind = "nudge" | "task";

/**
 * When a reminder fires. An object rather than a bare timestamp so recurring
 * schedules ("cron" / "interval") can be added later without a data migration.
 */
export interface ReminderSchedule {
  type: "once";
  /** ISO 8601 with offset — an absolute instant, e.g. "2026-07-12T09:00:00+06:00". */
  fireAt: string;
  /** IANA zone the time was expressed in, e.g. "Asia/Dhaka". For display + future recurring. */
  tz: string;
}

export interface Reminder {
  id: string;
  /** Origin session — where a `task` reminder resumes and where the post lands. */
  threadId: string;
  /** Agent SDK session id captured at creation, for resuming a `task` reminder. */
  sdkSessionId?: string;
  /** Working directory carried so a woken session runs in the right place. */
  cwd?: string;
  kind: ReminderKind;
  /** nudge: the message to deliver. task: the prompt to inject into the session. */
  text: string;
  schedule: ReminderSchedule;
  createdAt: string;
  /** Set when fired; kept briefly for debuggability, then pruned. */
  firedAt?: string;
}

export interface ReminderInput {
  threadId: string;
  sdkSessionId?: string;
  cwd?: string;
  kind: ReminderKind;
  text: string;
  fireAt: string;
  tz: string;
}

interface RemindersFile {
  nextId: number;
  reminders: Reminder[];
}

/** One-line human-readable description of a reminder, timed in its own zone. */
export function formatReminder(r: Reminder): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: r.schedule.tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(r.schedule.fireAt));
  return `${r.id} · ${when} (${r.schedule.tz}) · ${r.kind} · ${r.text}`;
}

function load(file: string): RemindersFile {
  if (!existsSync(file)) return { nextId: 1, reminders: [] };
  return JSON.parse(readFileSync(file, "utf8")) as RemindersFile;
}

function save(file: string, data: RemindersFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * Persistent store of scheduled reminders. CRUD only — no timers, no Discord.
 * The scheduler polls `due()`; the host handles delivery. Atomic writes
 * (tmp + rename) mirror `Registry`, so a crash mid-write can't corrupt the file.
 */
export class ReminderStore {
  private readonly file: string;
  private data: RemindersFile;

  constructor() {
    this.file = remindersFile();
    this.data = load(this.file);
  }

  add(input: ReminderInput): Reminder {
    const reminder: Reminder = {
      id: `r${this.data.nextId++}`,
      threadId: input.threadId,
      ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      kind: input.kind,
      text: input.text,
      schedule: { type: "once", fireAt: input.fireAt, tz: input.tz },
      createdAt: new Date().toISOString(),
    };
    this.data.reminders.push(reminder);
    save(this.file, this.data);
    return reminder;
  }

  /** Pending reminders (not yet fired), soonest first. */
  all(): Reminder[] {
    return this.data.reminders
      .filter((r) => !r.firedAt)
      .sort((a, b) => a.schedule.fireAt.localeCompare(b.schedule.fireAt));
  }

  get(id: string): Reminder | undefined {
    return this.data.reminders.find((r) => r.id === id);
  }

  /** Pending reminders whose fire time has arrived. */
  due(now: Date): Reminder[] {
    const nowMs = now.getTime();
    return this.data.reminders.filter(
      (r) => !r.firedAt && new Date(r.schedule.fireAt).getTime() <= nowMs,
    );
  }

  markFired(id: string, at: Date = new Date()): void {
    const reminder = this.data.reminders.find((r) => r.id === id);
    if (!reminder) return;
    reminder.firedAt = at.toISOString();
    save(this.file, this.data);
  }

  remove(id: string): boolean {
    const before = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter((r) => r.id !== id);
    if (this.data.reminders.length === before) return false;
    save(this.file, this.data);
    return true;
  }

  /** Drop fired reminders whose fire time is older than `before`. */
  prune(before: Date): void {
    const beforeMs = before.getTime();
    const kept = this.data.reminders.filter(
      (r) => !r.firedAt || new Date(r.firedAt).getTime() >= beforeMs,
    );
    if (kept.length === this.data.reminders.length) return;
    this.data.reminders = kept;
    save(this.file, this.data);
  }
}
