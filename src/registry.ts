import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { CONFIG_DIR } from "./config.js";

function registryFile(): string {
  return join(process.env.CLAUDECORD_HOME ?? CONFIG_DIR, "sessions.json");
}

export interface SessionRecord {
  threadId: string;
  sessionNum: number;
  /** Agent SDK session id, once known — used to resume after restarts. */
  sdkSessionId?: string;
  title: string;
  status: "active" | "ended";
  /** Per-session model override (set by /model); falls back to settings.model. */
  model?: string;
  createdAt: string;
  updatedAt: string;
}

interface RegistryFile {
  nextSessionNum: number;
  sessions: Record<string, SessionRecord>; // keyed by threadId
}

function load(file: string): RegistryFile {
  if (!existsSync(file)) return { nextSessionNum: 1, sessions: {} };
  return JSON.parse(readFileSync(file, "utf8")) as RegistryFile;
}

function save(file: string, data: RegistryFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

export class Registry {
  private readonly file: string;
  private data: RegistryFile;

  constructor() {
    this.file = registryFile();
    this.data = load(this.file);
  }

  create(threadId: string, title: string): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      threadId,
      sessionNum: this.data.nextSessionNum++,
      title,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.data.sessions[threadId] = record;
    save(this.file, this.data);
    return record;
  }

  get(threadId: string): SessionRecord | undefined {
    return this.data.sessions[threadId];
  }

  update(threadId: string, patch: Partial<Omit<SessionRecord, "threadId" | "sessionNum">>): SessionRecord {
    const record = this.data.sessions[threadId];
    if (!record) throw new Error(`No session for thread ${threadId}`);
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    save(this.file, this.data);
    return record;
  }

  all(): SessionRecord[] {
    return Object.values(this.data.sessions).sort((a, b) => a.sessionNum - b.sessionNum);
  }

  getByNum(num: number): SessionRecord | undefined {
    return Object.values(this.data.sessions).find((s) => s.sessionNum === num);
  }

  remove(threadId: string): boolean {
    if (!this.data.sessions[threadId]) return false;
    delete this.data.sessions[threadId];
    save(this.file, this.data);
    return true;
  }
}
