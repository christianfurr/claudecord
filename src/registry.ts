import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { CONFIG_DIR } from "./config.js";

const REGISTRY_FILE = join(CONFIG_DIR, "sessions.json");

export interface SessionRecord {
  threadId: string;
  sessionNum: number;
  /** Agent SDK session id, once known — used to resume after restarts. */
  sdkSessionId?: string;
  title: string;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
}

interface RegistryFile {
  nextSessionNum: number;
  sessions: Record<string, SessionRecord>; // keyed by threadId
}

function load(): RegistryFile {
  if (!existsSync(REGISTRY_FILE)) return { nextSessionNum: 1, sessions: {} };
  return JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as RegistryFile;
}

function save(data: RegistryFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = REGISTRY_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, REGISTRY_FILE);
}

export class Registry {
  private data: RegistryFile;

  constructor() {
    this.data = load();
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
    save(this.data);
    return record;
  }

  get(threadId: string): SessionRecord | undefined {
    return this.data.sessions[threadId];
  }

  update(threadId: string, patch: Partial<Omit<SessionRecord, "threadId" | "sessionNum">>): SessionRecord {
    const record = this.data.sessions[threadId];
    if (!record) throw new Error(`No session for thread ${threadId}`);
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    save(this.data);
    return record;
  }

  all(): SessionRecord[] {
    return Object.values(this.data.sessions).sort((a, b) => a.sessionNum - b.sessionNum);
  }
}
