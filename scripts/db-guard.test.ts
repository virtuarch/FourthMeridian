/**
 * scripts/db-guard.test.ts — the guard that would have prevented 2026-09-15.
 *
 * The incident: `prisma migrate dev` from a non-interactive shell, schema drift
 * pending, populated dev database ⇒ Prisma RESET the database before its own
 * "non-interactive is not supported" refusal printed. Three things must hold:
 *   1. the pure decision refuses exactly that input (and fails CLOSED when the
 *      database cannot be inspected);
 *   2. the repository's own `db:migrate` script cannot reach `prisma migrate dev`
 *      without passing the guard, and no package script runs a destructive
 *      prisma command unguarded;
 *   3. the real script, spawned with a piped stdin, exits non-zero with the
 *      actionable message BEFORE any prisma process is started.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { decideDbGuard } from "./lib/db-guard.core";

let passes = 0, failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const DB = "postgresql://u:p@localhost:5432/fintracker?schema=public";
const base = { dbUrl: DB, shadowUrl: undefined, allowDestructive: undefined } as const;

// ── 1. Pure decision ────────────────────────────────────────────────────────
console.log("db-guard core");
const incident = decideDbGuard({ ...base, mode: "migrate-dev", interactive: false, populated: true });
check("THE INCIDENT: non-interactive migrate dev against a populated DB is refused", !incident.ok);
check("…and the refusal names the command, the reset, and the safe alternative",
  /migrate dev/.test(incident.reasons[0]) && /RESETS/.test(incident.reasons.join(" ")) && /db:migrate:safe/.test(incident.hint.join(" ")));
check("fails CLOSED: unknown database contents + non-interactive is refused",
  !decideDbGuard({ ...base, mode: "migrate-dev", interactive: false, populated: null }).ok);
check("interactive migrate dev against a populated DB proceeds (Prisma prompts a human)",
  decideDbGuard({ ...base, mode: "migrate-dev", interactive: true, populated: true }).ok);
check("non-interactive migrate dev against an EMPTY DB proceeds (fresh clone / CI)",
  decideDbGuard({ ...base, mode: "migrate-dev", interactive: false, populated: false }).ok);
check("ALLOW_DESTRUCTIVE_DB does not unlock a non-interactive migrate dev",
  !decideDbGuard({ ...base, allowDestructive: "true", mode: "migrate-dev", interactive: false, populated: true }).ok);
check("shadow == live DB is refused in every mode",
  !decideDbGuard({ ...base, shadowUrl: DB, mode: "migrate-dev", interactive: true, populated: false }).ok
  && !decideDbGuard({ ...base, shadowUrl: DB, mode: "reset", allowDestructive: "true", interactive: true, populated: null }).ok);
check("reset without opt-in is refused; with opt-in it proceeds (unchanged contract)",
  !decideDbGuard({ ...base, mode: "reset", interactive: true, populated: null }).ok
  && decideDbGuard({ ...base, mode: "reset", allowDestructive: "true", interactive: false, populated: null }).ok);

// ── 2. Package scripts ──────────────────────────────────────────────────────
console.log("package scripts");
const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
const migrate = pkg.scripts["db:migrate"] ?? "";
check("db:migrate runs the guard in migrate-dev mode BEFORE prisma migrate dev",
  migrate.indexOf("scripts/db-guard.ts --mode=migrate-dev") >= 0
  && migrate.indexOf("scripts/db-guard.ts") < migrate.indexOf("prisma migrate dev"), migrate);
check("db:migrate takes a backup between the guard and prisma", /db-guard[^&]*&&\s*npm run db:backup\s*&&\s*prisma migrate dev/.test(migrate), migrate);
const unguarded = Object.entries(pkg.scripts).filter(([, cmd]) =>
  /prisma migrate (dev|reset)/.test(cmd) && !/scripts\/db-guard\.ts/.test(cmd.split(/prisma migrate (dev|reset)/)[0]));
check("no package script reaches `prisma migrate dev|reset` without the guard first",
  unguarded.length === 0, unguarded.map(([k]) => k).join(", "));
const guardSrc = readFileSync(path.join(process.cwd(), "scripts", "db-guard.ts"), "utf8");
check("the script derives interactivity from real TTYs, not from an env flag",
  /process\.stdin\.isTTY\s*&&\s*process\.stdout\.isTTY/.test(guardSrc));
check("the script never spawns prisma itself (refusal precedes any prisma process)",
  !/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(guardSrc));

// ── 3. The real script, non-interactively, against an unreachable DB ───────
console.log("live refusal");
const run = spawnSync("npx", ["tsx", "scripts/db-guard.ts", "--mode=migrate-dev"], {
  cwd: process.cwd(),
  input: "",                 // piped stdin ⇒ not a TTY, exactly like an agent session
  env: { ...process.env, DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nowhere", SHADOW_DATABASE_URL: "", ALLOW_DESTRUCTIVE_DB: "true" },
  encoding: "utf8",
  timeout: 60_000,
});
check("spawned guard exits non-zero with stdin piped and the DB unreachable", run.status !== 0 && run.status !== null, `status=${run.status} ${run.stderr.slice(0, 200)}`);
check("…printing the actionable refusal", /DESTRUCTIVE DATABASE OPERATION BLOCKED/.test(run.stderr) && /db:migrate:safe/.test(run.stderr));

console.log(`\ndb-guard: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
