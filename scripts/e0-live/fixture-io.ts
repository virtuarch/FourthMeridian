/**
 * scripts/e0-live/fixture-io.ts — the I/O edge of the E0-LIVE Preview fixture:
 * the env file, git, the private output directory, and the Prisma client.
 *
 * ⚠️ STATIC IMPORTS ARE NODE BUILTINS AND PURE MODULES ONLY. The Prisma client is
 * constructed by loadPrisma() — called by seed.ts / teardown.ts only AFTER
 * decideE0LiveGuard() accepted the target. Nothing here prints a URL, host, ref
 * or secret. Every private write runs under umask 077 (dir 0700, files 0600,
 * opened `wx` where the file must be new).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideE0LiveGuard, repoBasisRefusal, type E0LiveGuardDecision } from "./fixture-common";

// ── Refusal ──────────────────────────────────────────────────────────────────

export function die(msg: string, code = 2): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(code);
}

// ── Env file ─────────────────────────────────────────────────────────────────

/** Minimal KEY=value / KEY='value' / KEY="value" parser. Never prints values. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Runs the guard from the operator-supplied env file (FM_E0_LIVE_ENV_FILE). On
 * success, DATABASE_URL := DIRECT_URL so any repo module that lazily constructs
 * a client points at the SAME guarded target, and every role URL is unset.
 */
export function runGuards(): Extract<E0LiveGuardDecision, { ok: true }> {
  process.umask(0o077);
  const file = process.env.FM_E0_LIVE_ENV_FILE ?? "";
  const present = file !== "" && existsSync(file);
  const decision = decideE0LiveGuard({
    exported: process.env,
    envFile: present ? parseEnvText(readFileSync(file, "utf8")) : null,
    envFileMode: present ? statSync(file).mode & 0o777 : null,
  });
  if (!decision.ok) die(decision.reasons.join(" · "));
  process.env.DATABASE_URL = decision.directUrl;
  for (const k of ["DIRECT_URL", "DATABASE_URL_APP", "DATABASE_URL_AUTH", "DATABASE_URL_SYSTEM", "FM_RLS_STRICT"]) delete process.env[k];
  return decision;
}

// ── Repo basis ───────────────────────────────────────────────────────────────

export const REPO_ROOT = process.cwd();

export function assertRepoBasis(expectSha: string | null): { sha: string } {
  let sha = "";
  let dirty = true;
  try {
    sha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
  } catch { die("the working directory is not a git worktree."); }
  const r = repoBasisRefusal({ headSha: sha, expectSha, dirty });
  if (r) die(r);
  return { sha };
}

/** The newest migration directory name in the worktree. */
export function localNewestMigration(): string | null {
  const dir = path.join(REPO_ROOT, "prisma", "migrations");
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name)).map((d) => d.name).sort();
  return names.at(-1) ?? null;
}

// ── Private output (~/FourthMeridian-private/platform-ai-e0-live-<YYYYMMDD>/fixture/) ─

export function privateFixtureDir(day: string): string {
  return path.join(os.homedir(), "FourthMeridian-private", `platform-ai-e0-live-${day}`, "fixture");
}

export function ensurePrivateDir(dir: string): void {
  const prev = process.umask(0o077);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(path.dirname(dir), 0o700);
  } finally { process.umask(prev); }
}

/** Write a NEW 0600 file (opened `wx`: an existing file is never overwritten). */
export function writePrivateNew(file: string, content: string): void {
  const prev = process.umask(0o077);
  try {
    const fd = openSync(file, "wx", 0o600);
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(file, 0o600);
  } finally { process.umask(prev); }
}

/** Append one timestamped line (counts and codes only) to a 0600 log. */
export function logLine(file: string, line: string): void {
  const prev = process.umask(0o077);
  try { appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); chmodSync(file, 0o600); }
  finally { process.umask(prev); }
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function printCounts(title: string, counts: Record<string, number>): void {
  console.log(title);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(44)} ${v}`);
}

// ── Prisma (AFTER the guard) ─────────────────────────────────────────────────

export async function loadPrisma(directUrl: string) {
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: directUrl } }, log: ["error"] });
}
