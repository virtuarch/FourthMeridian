/**
 * scripts/db-guard.test.ts — the guard that would have prevented 2026-09-15,
 * and the target-identity authority that closes FM-AUDIT-002 / FM-AUDIT-032.
 *
 * The 09-15 incident: `prisma migrate dev` from a non-interactive shell, schema
 * drift pending, populated dev database ⇒ Prisma RESET the database before its
 * own "non-interactive is not supported" refusal printed.
 *
 * The pre-S1 audit's defect: the guard and the backup read DATABASE_URL while
 * Prisma Migrate connects through DIRECT_URL — so a split environment approved
 * and backed up database A while Prisma mutated database B.
 *
 * What must hold:
 *   1. logical identity: local aliases and Supabase pooler/direct pairs are the
 *      SAME database; different names/ports/projects are DIFFERENT; two unknown
 *      hosts are UNPROVABLE (and refused).
 *   2. the adversarial matrix — every dangerous DATABASE_URL / DIRECT_URL /
 *      SHADOW_DATABASE_URL combination refuses in EVERY mode;
 *   3. the 09-15 decision and the reset confirmation (FM-AUDIT-032);
 *   4. package scripts: every Prisma migrate command is behind the guard, the
 *      guard reads schema.prisma's directUrl rather than assuming it, and the
 *      backup and population probe use the SAME target as the guard;
 *   5. the real script, spawned non-interactively, refuses a split BEFORE any
 *      database is touched (both URLs unreachable — nothing could be mutated).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { decideDbGuard, type DbGuardInput } from "./lib/db-guard.core";
import { databaseIdentity, mutationAuthority, schemaRequiresDirectUrl, targetRelationship } from "@/lib/db/target-identity";

let passes = 0, failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const LIVE = "postgresql://u:p@localhost:5432/fintracker?schema=public";
const LIVE_127 = "postgresql://other:q@127.0.0.1:5432/fintracker";
const CLONE_A = "postgresql://u:p@localhost:5432/fintracker_gate_a?schema=public";
const CLONE_A_ALIAS = "postgresql://u:p@127.0.0.1/fintracker_gate_a";
const CLONE_B = "postgresql://u:p@localhost:5432/fintracker_gate_b?schema=public";
const CLONE_A_OTHER_PORT = "postgresql://u:p@localhost:55432/fintracker_gate_a";
const REF = "abcdefghijklmnopqrst";
const SB_POOLER = `postgresql://postgres.${REF}:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true`;
const SB_DIRECT = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
const SB_OTHER = "postgresql://postgres:pw@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres";
const UNKNOWN_A = "postgresql://u:p@db-primary.internal:5432/app";
const UNKNOWN_B = "postgresql://u:p@pgbouncer.internal:6432/app";

const MODES = ["reset", "migrate-dev", "migrate-deploy"] as const;
function input(over: Partial<DbGuardInput>): DbGuardInput {
  return {
    mode: "reset", dbUrl: CLONE_A, directUrl: CLONE_A, shadowUrl: undefined, requireDirect: true, armed: false,
    allowDestructive: "true", interactive: true, populated: false, typedConfirmation: null, ...over,
  };
}
/** Refused in every mode, with every other gate wide open. */
function refusedEverywhere(over: Partial<DbGuardInput>): boolean {
  return MODES.every((mode) => !decideDbGuard(input({ ...over, mode })).ok);
}

// ── 1. Logical identity ─────────────────────────────────────────────────────
console.log("logical identity");
check("localhost and 127.0.0.1 (default port) are the SAME database", targetRelationship(CLONE_A, CLONE_A_ALIAS) === "SAME");
check("…regardless of user", targetRelationship(LIVE, LIVE_127) === "SAME");
check("a different database name is DIFFERENT", targetRelationship(CLONE_A, CLONE_B) === "DIFFERENT");
check("the same name on another local port is DIFFERENT", targetRelationship(CLONE_A, CLONE_A_OTHER_PORT) === "DIFFERENT");
check("Supabase transaction pooler + direct host of ONE project are the SAME database", targetRelationship(SB_POOLER, SB_DIRECT) === "SAME");
check("two Supabase projects are DIFFERENT", targetRelationship(SB_DIRECT, SB_OTHER) === "DIFFERENT");
check("two unknown hosts (a primary and maybe-its-pooler) are UNPROVABLE", targetRelationship(UNKNOWN_A, UNKNOWN_B) === "UNPROVABLE");
check("an unparseable URL is UNPROVABLE", targetRelationship("not a url", CLONE_A) === "UNPROVABLE");
check("identity never renders a credential", !JSON.stringify(databaseIdentity(SB_POOLER)).includes("pw") && !JSON.stringify(databaseIdentity(LIVE)).includes(":p@"));

// ── 2. The adversarial matrix ───────────────────────────────────────────────
console.log("adversarial matrix (every mode, every other gate open)");
check("DATABASE_URL=clone / DIRECT_URL=live ⇒ REFUSED", refusedEverywhere({ dbUrl: CLONE_A, directUrl: LIVE }));
check("DATABASE_URL=live / DIRECT_URL=clone ⇒ REFUSED", refusedEverywhere({ dbUrl: LIVE, directUrl: CLONE_A }));
check("two DIFFERENT clones ⇒ REFUSED", refusedEverywhere({ dbUrl: CLONE_A, directUrl: CLONE_B }));
check("same clone name on another port ⇒ REFUSED", refusedEverywhere({ dbUrl: CLONE_A, directUrl: CLONE_A_OTHER_PORT }));
check("unprovable pairing (unknown hosts) ⇒ REFUSED", refusedEverywhere({ dbUrl: UNKNOWN_A, directUrl: UNKNOWN_B }));
check("missing DIRECT_URL (schema requires it) ⇒ REFUSED", refusedEverywhere({ dbUrl: CLONE_A, directUrl: undefined }));
check("missing DATABASE_URL ⇒ REFUSED", refusedEverywhere({ dbUrl: undefined, directUrl: CLONE_A }));
check("unparseable DIRECT_URL ⇒ REFUSED", refusedEverywhere({ dbUrl: CLONE_A, directUrl: "postgresql://[bad" }));
check("SHADOW == DIRECT_URL ⇒ REFUSED", refusedEverywhere({ shadowUrl: CLONE_A_ALIAS }));
check("SHADOW == DATABASE_URL (live) ⇒ REFUSED", refusedEverywhere({ dbUrl: LIVE, directUrl: LIVE_127, shadowUrl: LIVE }));
check("SHADOW unprovably distinct ⇒ REFUSED", refusedEverywhere({ dbUrl: UNKNOWN_A, directUrl: UNKNOWN_A, shadowUrl: "postgresql://u:p@other.internal:5432/app" }));
check("armed (clone-only) with both URLs on live ⇒ REFUSED", refusedEverywhere({ dbUrl: LIVE, directUrl: LIVE, armed: true, typedConfirmation: "localhost:5432/fintracker" }));
check("both on the SAME clone ⇒ allowed (reset with opt-in; migrate-dev on an empty DB; deploy)",
  MODES.every((mode) => decideDbGuard(input({ mode, interactive: false })).ok));
check("…and via different aliases of that clone ⇒ allowed", decideDbGuard(input({ directUrl: CLONE_A_ALIAS, interactive: false })).ok);
check("SHADOW on a different clone ⇒ allowed", decideDbGuard(input({ shadowUrl: CLONE_B, interactive: false })).ok);
check("Supabase pooler + direct of one project ⇒ identity passes (deploy allowed)",
  decideDbGuard(input({ mode: "migrate-deploy", dbUrl: SB_POOLER, directUrl: SB_DIRECT })).ok);
const t = mutationAuthority({ DATABASE_URL: CLONE_A, DIRECT_URL: CLONE_A_ALIAS }, { requireDirect: true });
check("the mutation target is DIRECT_URL — what Prisma Migrate connects to", t.ok && t.target.source === "DIRECT_URL" && t.target.url === CLONE_A_ALIAS);
const split = decideDbGuard(input({ dbUrl: CLONE_A, directUrl: LIVE }));
check("the split refusal names both databases and never a credential",
  /fintracker_gate_a/.test(split.reasons.join(" ")) && /localhost:5432\/fintracker\b/.test(split.reasons.join(" ")) && !/:p@/.test(split.reasons.join(" ")));

// ── 3. 09-15, and reset confirmation (FM-AUDIT-032) ──────────────────────────
console.log("migrate-dev and reset decisions");
const incident = decideDbGuard(input({ mode: "migrate-dev", dbUrl: LIVE, directUrl: LIVE, interactive: false, populated: true }));
check("THE INCIDENT: non-interactive migrate dev against a populated DB is refused", !incident.ok);
check("…and the refusal names the command, the reset, and the safe alternative",
  /migrate dev/.test(incident.reasons[0]) && /RESETS/.test(incident.reasons.join(" ")) && /db:migrate:safe/.test(incident.hint.join(" ")));
check("fails CLOSED: unknown database contents + non-interactive is refused",
  !decideDbGuard(input({ mode: "migrate-dev", interactive: false, populated: null })).ok);
check("interactive migrate dev against a populated DB proceeds (Prisma prompts a human)",
  decideDbGuard(input({ mode: "migrate-dev", dbUrl: LIVE, directUrl: LIVE, interactive: true, populated: true })).ok);
check("ALLOW_DESTRUCTIVE_DB does not unlock a non-interactive migrate dev",
  !decideDbGuard(input({ mode: "migrate-dev", interactive: false, populated: true })).ok);
check("reset without opt-in is refused, even on a clone", !decideDbGuard(input({ allowDestructive: undefined })).ok);
check("reset of a clone with opt-in proceeds non-interactively", decideDbGuard(input({ interactive: false })).ok);
check("FM-AUDIT-032: reset of LIVE with the flag alone, non-interactive ⇒ REFUSED",
  !decideDbGuard(input({ dbUrl: LIVE, directUrl: LIVE, interactive: false })).ok);
check("…interactive but the wrong confirmation ⇒ REFUSED",
  !decideDbGuard(input({ dbUrl: LIVE, directUrl: LIVE, typedConfirmation: "fintracker" })).ok);
check("…interactive with the exact host/database typed ⇒ allowed",
  decideDbGuard(input({ dbUrl: LIVE, directUrl: LIVE, typedConfirmation: "localhost:5432/fintracker" })).ok);
check("…an UNKNOWN (non-convention) name needs the same confirmation",
  !decideDbGuard(input({ dbUrl: UNKNOWN_A, directUrl: UNKNOWN_A, interactive: false })).ok);

// ── 4. Package scripts, schema, and one target everywhere ────────────────────
console.log("package scripts and target consistency");
const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
const migrate = pkg.scripts["db:migrate"] ?? "";
check("db:migrate runs the guard in migrate-dev mode BEFORE prisma migrate dev",
  migrate.indexOf("scripts/db-guard.ts --mode=migrate-dev") >= 0
  && migrate.indexOf("scripts/db-guard.ts") < migrate.indexOf("prisma migrate dev"), migrate);
check("db:migrate takes a backup between the guard and prisma", /db-guard[^&]*&&\s*npm run db:backup\s*&&\s*prisma migrate dev/.test(migrate), migrate);
check("db:migrate:safe runs the guard (migrate-deploy) then the backup then deploy",
  /scripts\/db-guard\.ts --mode=migrate-deploy\s*&&\s*npm run db:backup\s*&&\s*prisma migrate deploy/.test(pkg.scripts["db:migrate:safe"] ?? ""));
check("db:reset runs the guard then the backup then reset",
  /scripts\/db-guard\.ts\s*&&\s*npm run db:backup\s*&&\s*prisma migrate reset/.test(pkg.scripts["db:reset"] ?? ""));
const unguarded = Object.entries(pkg.scripts).filter(([, cmd]) =>
  /prisma (migrate (dev|reset|deploy|resolve)|db push)/.test(cmd) && !/scripts\/db-guard\.ts/.test(cmd.split(/prisma (migrate|db push)/)[0]));
check("no package script reaches a mutating `prisma migrate …` / `db push` without the guard first",
  unguarded.length === 0, unguarded.map(([k]) => k).join(", "));
const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
check("schema.prisma routes Migrate through DIRECT_URL (so the guard requires it)", schemaRequiresDirectUrl(schema));
check("schemaRequiresDirectUrl reads the datasource, not a guess",
  !schemaRequiresDirectUrl('datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'));
const guardSrc = readFileSync(path.join(process.cwd(), "scripts", "db-guard.ts"), "utf8");
const backupSrc = readFileSync(path.join(process.cwd(), "scripts", "db-backup.ts"), "utf8");
const wipeSrc = readFileSync(path.join(process.cwd(), "scripts", "db-wipe.ts"), "utf8");
check("the guard reads schema.prisma's directUrl rather than assuming it", /schemaRequiresDirectUrl\(readFileSync/.test(guardSrc));
check("the guard's population probe queries the TARGET url, not a default client", /datasourceUrl:\s*targetUrl/.test(guardSrc) && /isPopulated\(target\.url\)/.test(guardSrc));
check("the backup dumps the SAME mutation target (and refuses a split)", /processMutationAuthority\(requireDirect\)/.test(backupSrc) && /target\.url\.split/.test(backupSrc) && !/process\.env\.DATABASE_URL/.test(backupSrc));
check("db:wipe checks the same authority before inventory, backup or Plaid teardown",
  /processMutationAuthority\(/.test(wipeSrc) && wipeSrc.indexOf("processMutationAuthority(") < wipeSrc.indexOf("removePlaidItemsBeforeWipe()"));
check("the script derives interactivity from real TTYs, not from an env flag",
  /process\.stdin\.isTTY\s*&&\s*process\.stdout\.isTTY/.test(guardSrc));
check("the script never spawns prisma itself (refusal precedes any prisma process)",
  !/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(guardSrc));
check("identity is checked BEFORE the population probe touches any database",
  guardSrc.indexOf("mutationAuthority(env") < guardSrc.indexOf("await isPopulated("));

// ── 5. The real script, spawned non-interactively ───────────────────────────
console.log("spawned refusals (unreachable URLs — nothing can be touched)");
const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
function spawnGuard(mode: string, env: Record<string, string | undefined>) {
  const base = { ...process.env };
  delete base.DATABASE_URL; delete base.DIRECT_URL; delete base.SHADOW_DATABASE_URL; delete base.FM_DB_GUARD;
  return spawnSync(tsx, ["scripts/db-guard.ts", `--mode=${mode}`], {
    cwd: process.cwd(), input: "", encoding: "utf8", timeout: 60_000,
    env: { ...base, ALLOW_DESTRUCTIVE_DB: "true", ...env } as NodeJS.ProcessEnv,
  });
}
const CLONE_NOWHERE = "postgresql://u:p@127.0.0.1:1/fintracker_gate_a";
const LIVE_NOWHERE = "postgresql://u:p@127.0.0.1:1/fintracker";
for (const mode of MODES) {
  const r = spawnGuard(mode, { DATABASE_URL: CLONE_NOWHERE, DIRECT_URL: LIVE_NOWHERE });
  check(`spawned ${mode}: DATABASE_URL=clone / DIRECT_URL=live exits non-zero with the split refusal`,
    r.status === 1 && /DIFFERENT databases/.test(r.stderr), `status=${r.status} ${r.stderr.slice(0, 200)}`);
}
const noDirect = spawnGuard("reset", { DATABASE_URL: CLONE_NOWHERE });
check("spawned reset: missing DIRECT_URL is refused", noDirect.status === 1 && /DIRECT_URL is unset/.test(noDirect.stderr));
const inc = spawnGuard("migrate-dev", { DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nowhere", DIRECT_URL: "postgresql://u:p@127.0.0.1:1/nowhere" });
check("spawned migrate-dev: unreachable (unknown contents) + non-interactive is refused with the 09-15 hint",
  inc.status === 1 && /DESTRUCTIVE DATABASE OPERATION BLOCKED/.test(inc.stderr) && /db:migrate:safe/.test(inc.stderr), `status=${inc.status} ${inc.stderr.slice(0, 200)}`);

console.log(`\ndb-guard: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
