import type { Registry } from "./registry.js";

export const END_DRAIN_MS = 30_000;
const DRAIN_POLL_MS = 100;

export interface RuntimeInfo {
  busy: boolean;
  costUsd: number;
  turns: number;
  model?: string;
}

export interface SessionServiceHost {
  registry: Registry;
  runtimeInfo(threadId: string): RuntimeInfo | undefined;
  dropRuntime(threadId: string): Promise<void>;
  archiveSession(threadId: string, summary?: { turns?: number; costUsd?: number }): Promise<void>;
}

export interface SessionSummary {
  num: number;
  title: string;
  status: "active" | "ended";
  model?: string;
  busy: boolean;
  live: boolean;
  ageSec: number;
  costUsd: number;
}

export interface EndResult {
  num: number;
  ended: boolean;
  forced: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function listSessions(host: SessionServiceHost, now = Date.now()): SessionSummary[] {
  return host.registry.all().map((r) => {
    const info = host.runtimeInfo(r.threadId);
    return {
      num: r.sessionNum,
      title: r.title,
      status: r.status,
      model: r.model ?? info?.model,
      busy: info?.busy ?? false,
      live: info !== undefined,
      ageSec: Math.round((now - new Date(r.createdAt).getTime()) / 1000),
      costUsd: info?.costUsd ?? 0,
    };
  });
}

async function drain(host: SessionServiceHost, threadId: string, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (host.runtimeInfo(threadId)?.busy) {
    if (Date.now() >= deadline) return false;
    await sleep(DRAIN_POLL_MS);
  }
  return true;
}

async function teardown(
  host: SessionServiceHost,
  threadId: string,
  info: RuntimeInfo | undefined,
): Promise<void> {
  await host.dropRuntime(threadId);
  host.registry.update(threadId, { status: "ended" });
  await host.archiveSession(threadId, info ? { turns: info.turns, costUsd: info.costUsd } : undefined);
}

export async function endSession(
  host: SessionServiceHost,
  num: number,
  opts: { drainMs?: number } = {},
): Promise<EndResult> {
  const record = host.registry.getByNum(num);
  if (!record) return { num, ended: false, forced: false, error: `no session #${num}` };
  if (record.status === "ended") return { num, ended: false, forced: false, error: `session #${num} already ended` };

  const info = host.runtimeInfo(record.threadId);
  let forced = false;
  if (info?.busy) forced = !(await drain(host, record.threadId, opts.drainMs ?? END_DRAIN_MS));
  await teardown(host, record.threadId, info);
  return { num, ended: true, forced };
}

export async function killSession(host: SessionServiceHost, num: number): Promise<EndResult> {
  const record = host.registry.getByNum(num);
  if (!record) return { num, ended: false, forced: true, error: `no session #${num}` };
  if (record.status === "ended") return { num, ended: false, forced: true, error: `session #${num} already ended` };
  await teardown(host, record.threadId, host.runtimeInfo(record.threadId));
  return { num, ended: true, forced: true };
}

export async function endAll(
  host: SessionServiceHost,
  opts: { drainMs?: number } = {},
): Promise<EndResult[]> {
  const active = host.registry.all().filter((r) => r.status === "active");
  const results: EndResult[] = [];
  for (const r of active) {
    try {
      results.push(await endSession(host, r.sessionNum, opts));
    } catch (err) {
      results.push({ num: r.sessionNum, ended: false, forced: false, error: String(err) });
    }
  }
  return results;
}

export function pruneEnded(host: SessionServiceHost): { removed: number } {
  const ended = host.registry.all().filter((r) => r.status === "ended");
  for (const r of ended) host.registry.remove(r.threadId);
  return { removed: ended.length };
}
