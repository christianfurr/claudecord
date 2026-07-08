import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

/** Discord's common unboosted per-file upload limit. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Cap on inbound attachment downloads (above Discord's uploader limit). */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

const SECRET_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\..+/,
  /\.key$/,
  /\.pem$/,
  /\.secret$/,
  /\.keystore$/,
];

/** Mirrors the deny-list in global-guard.py — files that must never leave the machine. */
export function isSecretFilename(name: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

export type OutboundCheck =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: string };

/**
 * Validate a path the send_file tool was asked to attach. `home` is injected for
 * testability. Resolves symlinks so a link can't escape the home scope.
 */
export function validateOutboundFile(input: string, home: string = homedir()): OutboundCheck {
  const expanded = input.startsWith("~/") ? join(home, input.slice(2)) : input;
  const abs = resolve(expanded);

  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, reason: `File not found: ${input}` };
  }

  const homeReal = realpathSync(home);
  if (real !== homeReal && !real.startsWith(homeReal + sep)) {
    return { ok: false, reason: `Refused: ${input} is outside the home directory.` };
  }

  if (isSecretFilename(basename(real))) {
    return { ok: false, reason: `Refused: ${basename(real)} looks like a secret file and won't be sent.` };
  }

  const st = statSync(real);
  if (!st.isFile()) {
    return { ok: false, reason: `Not a regular file: ${input}` };
  }
  if (st.size > MAX_UPLOAD_BYTES) {
    const mb = (st.size / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `Too large: ${mb} MB exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.` };
  }

  return { ok: true, path: real, size: st.size };
}

/**
 * A materialized file has allocated blocks on disk; an iCloud-evicted (dataless)
 * placeholder reports its logical size but zero blocks. Reading such a file faults
 * it in from the file provider, which fails with EDEADLK when the process can't
 * service the download — so callers must materialize it first.
 */
export function isDatalessStat(stat: { size: number; blocks: number }): boolean {
  return stat.size > 0 && stat.blocks === 0;
}

/**
 * Reduce a user-supplied attachment name to a safe single path component so a
 * crafted name (e.g. `../../evil`) can't write outside the inbox directory.
 */
export function sanitizeFilename(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}
