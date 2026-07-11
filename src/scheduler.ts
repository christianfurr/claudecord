import type { Reminder, ReminderStore } from "./reminders.js";

export interface SchedulerOptions {
  /** How often the tick scans for due reminders. */
  intervalMs?: number;
  /** Fired reminders older than this are pruned from the store. */
  pruneAfterMs?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
}

/**
 * Polls the reminder store on an interval and fires anything due. Deliberately
 * poll-based rather than one timer per reminder: it handles arbitrarily long
 * delays, and reminders that came due while the daemon was down fire on the
 * first tick after boot. Knows nothing about Discord — just store + callback +
 * clock. The `fire` callback is responsible for marking the reminder fired
 * (before its first await) so an overlapping tick can't double-send.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly intervalMs: number;
  private readonly pruneAfterMs: number;
  private readonly now: () => Date;

  constructor(
    private store: ReminderStore,
    private fire: (reminder: Reminder) => Promise<void>,
    opts: SchedulerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 20_000;
    this.pruneAfterMs = opts.pruneAfterMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scan: fire everything due, then prune old fired reminders. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const reminder of this.store.due(now)) {
        try {
          await this.fire(reminder);
        } catch (err) {
          console.error(`reminder ${reminder.id} fire failed:`, err);
        }
      }
      this.store.prune(new Date(now.getTime() - this.pruneAfterMs));
    } finally {
      this.ticking = false;
    }
  }
}
