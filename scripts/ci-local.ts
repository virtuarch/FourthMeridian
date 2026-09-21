/**
 * scripts/ci-local.ts — `npm run ci`
 *
 * THE GITHUB CI CONTRACT, RUN LOCALLY, AGAINST WHAT WILL ACTUALLY BE PUSHED.
 *
 * ── Why this exists (2026-09-21) ────────────────────────────────────────────
 * GitHub CI was red from 264d91e to b68bce9 while every local gate passed. Four
 * independent causes, and not one was flaky — each was a difference between the
 * environment the gates ran in locally and the one CI runs:
 *   · nobody ran `npm run audit:ci` locally, so an unregistered script stopped
 *     the architecture gate at reconciliation for a month;
 *   · local Node was 26, CI 22, production 24 — compact money and the mutation
 *     loader behaved differently on each;
 *   · local checkouts carry full history, CI clones one commit;
 *   · local checkouts carry ignored files (tmp/, prototype/, .next/) that
 *     `tsc --noEmit` type-checks — 89 errors locally, 0 in the committed tree.
 *
 * So this command gates HEAD, never the working tree:
 *
 *   1. REFUSES any Node whose major is not `.nvmrc`'s — the one runtime
 *      contract shared with CI (setup-node reads the same file) and production
 *      (Vercel 24.x; `engines.node` states it).
 *   2. Builds a CLEAN depth-1 copy of HEAD in a temp dir (only committed files,
 *      no history — exactly what actions/checkout gives CI), with `origin`
 *      pointing back at this repo so a history-reading audit can fetch what it
 *      needs, as it does from GitHub.
 *   3. Runs the `test` job's steps there, then the `architecture` job's, in the
 *      order ci.yml runs them. `TEST_JOB` / `ARCHITECTURE_JOB` (scripts/lib/
 *      ci-contract.ts) ARE that order: scripts/ci-local.test.ts fails if
 *      ci.yml's `run:` steps differ.
 *
 * ── Database safety (fail closed) ───────────────────────────────────────────
 * The architecture job migrates, seeds and audits a database. Here that database
 * is ALWAYS a Postgres container this process starts for the run (same image as
 * CI's service, random loopback port, removed on exit) — never DATABASE_URL:
 *   · every inherited DATABASE_URL / DIRECT_URL / SHADOW_DATABASE_URL is
 *     REMOVED from the child environment and replaced with the container's URL;
 *   · the clean copy has no .env / .env.local for anything to fall back to;
 *   · the URL must classify NON_LIVE under lib/db/live-guard before any step
 *     runs, and FM_DB_GUARD=clone-only is set so lib/db refuses anything else;
 *   · no Docker ⇒ the architecture job FAILS. It never falls back to a
 *     developer database.
 * The test job gets no database URL at all — as in CI.
 *
 * Uncommitted edits are NOT gated (it says so). Commit, then `npm run ci`.
 *
 *   npm run ci            # both jobs
 *   npm run ci -- --keep  # keep the clean copy for inspection
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDatabaseTarget, DB_GUARD_CLONE_ONLY, DB_GUARD_ENV } from "../lib/db/live-guard";
import {
  ARCHITECTURE_JOB, CI_ENCRYPTION_KEY, CI_POSTGRES, TEST_JOB, nvmrcMajor, withoutDatabaseUrls,
} from "./lib/ci-contract";

// ── plumbing ─────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const KEEP = process.argv.includes("--keep");

function sh(cmd: string, args: string[], opts: SpawnSyncOptions = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function bar(title: string): void {
  console.log(`\n${"═".repeat(78)}\n${title}\n${"═".repeat(78)}`);
}

interface StepResult { job: string; step: string; ok: boolean | null; ms: number }
const results: StepResult[] = [];

/** Run a job's steps in order; the first failure skips the rest of THAT job. */
function runJob(job: string, steps: readonly string[], cwd: string, env: NodeJS.ProcessEnv): boolean {
  let failed = false;
  for (const step of steps) {
    if (failed) { results.push({ job, step, ok: null, ms: 0 }); continue; }
    bar(`${job} › ${step}`);
    const started = Date.now();
    const r = spawnSync(step, { cwd, env, stdio: "inherit", shell: true });
    const ok = r.status === 0;
    results.push({ job, step, ok, ms: Date.now() - started });
    if (!ok) failed = true;
  }
  return !failed;
}

let container: string | null = null;
let workdir: string | null = null;

function teardown(): void {
  if (container) { sh("docker", ["rm", "-f", container]); container = null; }
  if (workdir && !KEEP) { rmSync(workdir, { recursive: true, force: true }); workdir = null; }
}
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { teardown(); process.exit(130); });

function fail(lines: string[]): never {
  console.error(`\n[ci] REFUSED\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  process.exit(1);
}

/** Start the throwaway Postgres; return its URL. Throws (never falls back) on any problem. */
function startThrowawayPostgres(): string {
  if (!sh("docker", ["info", "--format", "{{.ServerVersion}}"]).ok) {
    throw new Error("Docker is not available — the architecture job needs a throwaway Postgres "
      + "container and will not use DATABASE_URL instead.");
  }
  container = `fm-ci-${process.pid}-${Date.now().toString(36)}`;
  const run = sh("docker", [
    "run", "-d", "--rm", "--name", container,
    "-e", `POSTGRES_USER=${CI_POSTGRES.user}`,
    "-e", `POSTGRES_PASSWORD=${CI_POSTGRES.password}`,
    "-e", `POSTGRES_DB=${CI_POSTGRES.database}`,
    "-p", "127.0.0.1::5432",
    CI_POSTGRES.image,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  if (!run.ok) throw new Error(`could not start ${CI_POSTGRES.image}: ${run.out}`);

  // Ready on TCP, not just the socket: the image's init server listens on the
  // socket only, then restarts — a socket-level "ready" can precede that restart.
  const deadline = Date.now() + 90_000;
  while (!sh("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1",
    "-U", CI_POSTGRES.user, "-d", CI_POSTGRES.database]).ok) {
    if (Date.now() > deadline) throw new Error("throwaway Postgres did not become ready within 90 s");
    spawnSync("sleep", ["1"]);
  }
  const mapped = sh("docker", ["port", container, "5432/tcp"]).out.split("\n")[0];
  const port = /^127\.0\.0\.1:(\d+)$/.exec(mapped)?.[1];
  if (!port) throw new Error(`unexpected port mapping "${mapped}"`);
  return `postgresql://${CI_POSTGRES.user}:${CI_POSTGRES.password}@127.0.0.1:${port}/`
    + `${CI_POSTGRES.database}?schema=public`;
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const head = sh("git", ["rev-parse", "HEAD"]);
  if (!head.ok) fail(["not inside a git checkout"]);
  const sha = head.out;

  // 1. Runtime contract.
  const wantMajor = nvmrcMajor(sh("git", ["show", `${sha}:.nvmrc`]).out);
  if (wantMajor === null) fail([".nvmrc is missing or unreadable at HEAD — it IS the runtime contract."]);
  const haveMajor = Number(process.versions.node.split(".")[0]);
  if (haveMajor !== wantMajor) {
    fail([
      `Node ${process.versions.node} is running; the contract is Node ${wantMajor} (.nvmrc).`,
      "CI (setup-node, node-version-file: .nvmrc) and production (Vercel 24.x, engines.node)",
      "run that major. Results from another runtime are not evidence about either.",
      `Switch first — e.g. \`nvm use\`, or \`brew install node@${wantMajor}\` and put it first on PATH.`,
    ]);
  }

  const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"]).out;
  console.log(`[ci] gating HEAD ${sha.slice(0, 12)} on Node ${process.versions.node}`);
  if (dirty) console.log("[ci] ⚠ uncommitted changes to tracked files are NOT gated — commit them first.");

  // 2. Clean depth-1 copy of HEAD, origin → this repo.
  workdir = mkdtempSync(join(tmpdir(), "fm-ci-"));
  const origin = `file://${ROOT}`;
  for (const args of [
    ["init", "-q", workdir],
    ["-C", workdir, "remote", "add", "origin", origin],
    ["-C", workdir, "fetch", "-q", "--no-tags", "--depth=1", "origin", sha],
    ["-C", workdir, "checkout", "-q", "--detach", "FETCH_HEAD"],
  ]) {
    const r = sh("git", args);
    if (!r.ok) fail([`git ${args.join(" ")} failed:`, r.out]);
  }
  console.log(`[ci] clean copy: ${workdir}${KEEP ? " (kept)" : ""}`);

  // 3a. The test job — no database URL, as in CI.
  const base = withoutDatabaseUrls(process.env);
  delete base[DB_GUARD_ENV];
  const testOk = runJob("test", TEST_JOB, workdir, base);

  // 3b. The architecture job — against the throwaway container only.
  let archOk = false;
  let url: string | null = null;
  try {
    url = startThrowawayPostgres();
  } catch (e) {
    console.error(`\n[ci] architecture job cannot start: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (url) {
    const verdict = classifyDatabaseTarget(url);
    if (verdict.verdict !== "NON_LIVE") fail([`throwaway URL did not classify as a clone: ${verdict.reason}`]);
    const env: NodeJS.ProcessEnv = {
      ...base,
      DATABASE_URL: url,
      DIRECT_URL: url,
      ENCRYPTION_KEY: CI_ENCRYPTION_KEY,
      [DB_GUARD_ENV]: DB_GUARD_CLONE_ONLY,
    };
    console.log(`[ci] architecture database: ${verdict.name} in container ${container} (throwaway)`);
    archOk = runJob("architecture", ARCHITECTURE_JOB, workdir, env);
  } else {
    for (const step of ARCHITECTURE_JOB) results.push({ job: "architecture", step, ok: false, ms: 0 });
  }

  bar(`SUMMARY — HEAD ${sha.slice(0, 12)} · Node ${process.versions.node}`);
  for (const r of results) {
    const mark = r.ok === null ? "·" : r.ok ? "✓" : "✗";
    const state = r.ok === null ? "skipped" : `${(r.ms / 1000).toFixed(1)}s`;
    console.log(`  ${mark} ${r.job.padEnd(13)} ${r.step.padEnd(28)} ${state}`);
  }
  const ok = testOk && archOk;
  console.log(ok
    ? "\n[ci] PASSED — both CI jobs green on a clean copy of HEAD. ✓\n"
    : "\n[ci] FAILED — a CI job is red on a clean copy of HEAD; GitHub will agree.\n");
  process.exitCode = ok ? 0 : 1;
}

main();
