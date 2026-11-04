/**
 * scripts/lib/synthetic-operator.files.ts — the private evidence files of the
 * synthetic Preview operator (scripts/synthetic-operator.ts).
 *
 * Every write runs under process.umask(0o077): the directory is 0700, every
 * file 0600 (mode at open AND chmodSync after, so a pre-existing file or a
 * permissive umask can never leave it readable). The base directory is
 * injectable (tests pass a temp dir); the CLI uses ~/FourthMeridian-private.
 *
 * Nothing here prints. The credential file is never logged, and is SHREDDED
 * (overwritten with random bytes, fsynced, then unlinked) by cleanup.
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const CREDENTIALS_FILE = "credentials.json";
export const RECORD_FILE = "record.json";
export const CLEANUP_FILE = "cleanup.json";

/** ~/FourthMeridian-private (resolved from the current HOME). */
export function defaultPrivateBase(): string {
  return path.join(os.homedir(), "FourthMeridian-private");
}

function withUmask<T>(fn: () => T): T {
  const prev = process.umask(0o077);
  try { return fn(); } finally { process.umask(prev); }
}

/** Create the private directory (0700). Refuses an existing directory. */
export function createPrivateDir(dir: string): void {
  withUmask(() => {
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    if (existsSync(dir)) throw new Error("the private directory already exists — refusing to reuse it");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  });
}

/** Write JSON at 0600 inside a 0700 directory. `exclusive` refuses an existing file. */
export function writePrivateJson(dir: string, name: string, value: unknown, exclusive = false): string {
  const file = path.join(dir, name);
  withUmask(() => {
    chmodSync(dir, 0o700);
    const fd = openSync(file, exclusive ? "wx" : "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(file, 0o600);
  });
  return file;
}

export function readPrivateJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

/** Overwrite with random bytes (same length), fsync, then unlink. No-op when absent. */
export function shredFile(file: string): boolean {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, randomBytes(Math.max(size, 1)), 0, Math.max(size, 1), 0);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  unlinkSync(file);
  return true;
}
