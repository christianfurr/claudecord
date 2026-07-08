import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateOutboundFile,
  sanitizeFilename,
  isSecretFilename,
  isDatalessStat,
  MAX_UPLOAD_BYTES,
} from "./files.js";

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "cc-home-")));
});

function write(name: string, bytes = 8): string {
  const p = join(home, name);
  writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

test("accepts a normal file under home and returns its resolved path and size", () => {
  const p = write("Court Plan.pdf", 42);
  const res = validateOutboundFile(p, home);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.size).toBe(42);
    expect(res.path).toBe(realpathSync(p));
  }
});

test("expands a leading ~/ against the injected home", () => {
  write("doc.pdf", 10);
  const res = validateOutboundFile("~/doc.pdf", home);
  expect(res.ok).toBe(true);
});

test("rejects secret files by name", () => {
  for (const name of [".env", ".env.local", "id.pem", "server.key", "app.secret", "x.keystore"]) {
    write(name);
    const res = validateOutboundFile(join(home, name), home);
    expect(res.ok).toBe(false);
  }
});

test("rejects a path outside home", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "cc-out-")));
  const p = join(outside, "leak.pdf");
  writeFileSync(p, Buffer.alloc(4));
  const res = validateOutboundFile(p, home);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("outside the home directory");
});

test("rejects a symlink inside home that escapes to outside home", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "cc-out-")));
  const target = join(outside, "secret.pdf");
  writeFileSync(target, Buffer.alloc(4));
  const link = join(home, "innocent.pdf");
  symlinkSync(target, link);
  const res = validateOutboundFile(link, home);
  expect(res.ok).toBe(false);
});

test("rejects a missing file", () => {
  const res = validateOutboundFile(join(home, "nope.pdf"), home);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("not found");
});

test("rejects a directory", () => {
  mkdirSync(join(home, "folder"));
  const res = validateOutboundFile(join(home, "folder"), home);
  expect(res.ok).toBe(false);
});

test("rejects a file over the upload limit", () => {
  const p = write("big.bin", MAX_UPLOAD_BYTES + 1);
  const res = validateOutboundFile(p, home);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("Too large");
});

test("sanitizeFilename strips path components, traversal, and leading dots", () => {
  expect(sanitizeFilename("citation.pdf")).toBe("citation.pdf");
  expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  expect(sanitizeFilename("a/b/c.txt")).toBe("c.txt");
  expect(sanitizeFilename("...hidden")).toBe("hidden");
  expect(sanitizeFilename("")).toBe("file");
  expect(sanitizeFilename("   ")).toBe("file");
});

test("isDatalessStat flags a zero-block file with nonzero size (iCloud placeholder)", () => {
  expect(isDatalessStat({ size: 847987, blocks: 0 })).toBe(true);
  expect(isDatalessStat({ size: 261450, blocks: 512 })).toBe(false);
  expect(isDatalessStat({ size: 0, blocks: 0 })).toBe(false); // genuinely empty file
});

test("isSecretFilename matches the deny-list and passes normal names", () => {
  expect(isSecretFilename(".env")).toBe(true);
  expect(isSecretFilename("prod.pem")).toBe(true);
  expect(isSecretFilename("report.pdf")).toBe(false);
  expect(isSecretFilename("environment.txt")).toBe(false);
});
