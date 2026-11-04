/**
 * scripts/b10-rehearsal-guard.test.ts  (B10.6 — the probes refuse outside the orchestrator; S2)
 *
 * Unit + source-scan + one spawn per probe. No database and no network: every
 * URL below uses the reserved `.invalid` TLD or is only parsed, and the probes
 * are expected to exit inside the guard, before any application module loads.
 *
 *   npx tsx scripts/b10-rehearsal-guard.test.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkRehearsalEnv, REHEARSAL_CONTAINER_PREFIX, REHEARSAL_DB_PREFIX, REHEARSAL_URL_VARS } from "./lib/b10-rehearsal-guard";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const PROBES = ["scripts/test-b10-rehearsal-b9-probe.ts", "scripts/test-b10-rehearsal-b10-probe.ts"];

/** What a developer shell typically carries: a real-looking remote URL, no rehearsal marker, no fixture. */
const DEV_SECRET = "dev-password-not-a-real-one";
const DEV_HOST = "db.dev-host.invalid";
const DEVELOPER_ENV: Record<string, string> = {
  DATABASE_URL: `postgresql://postgres:${DEV_SECRET}@${DEV_HOST}:5432/fintracker?schema=public`,
  DIRECT_URL: `postgresql://postgres:${DEV_SECRET}@${DEV_HOST}:5432/fintracker?schema=public`,
};

const local = (db: string, role = "fmowner") => `postgresql://${role}:pw@127.0.0.1:55432/${db}`;
const GOOD: Record<string, string> = {
  DATABASE_URL: `${local(`${REHEARSAL_DB_PREFIX}123`)}?schema=public`,
  DIRECT_URL: `${local(`${REHEARSAL_DB_PREFIX}123`)}?schema=public`,
  DATABASE_URL_APP: local(`${REHEARSAL_DB_PREFIX}123`, "fm_app"),
  DATABASE_URL_AUTH: local(`${REHEARSAL_DB_PREFIX}123`, "fm_auth"),
  DATABASE_URL_SYSTEM: local(`${REHEARSAL_DB_PREFIX}123`, "fm_system"),
  B10REH_FIX: JSON.stringify({ u1: "x" }),
  B10REH_STATE: "{}",
  B10REH_ORCHESTRATED: `${REHEARSAL_CONTAINER_PREFIX}123-abc`,
};

console.log("1. checkRehearsalEnv");
{
  const dev = checkRehearsalEnv(DEVELOPER_ENV);
  const reasons = dev.ok ? [] : dev.reasons;
  check("a developer-like env (remote URL, no marker, no fixture) is refused", !dev.ok);
  check("…naming the missing fixture, the host, the database and the marker",
    ["B10REH_FIX is not set", "DATABASE_URL host is not 127.0.0.1", "DATABASE_URL database is not", "B10REH_ORCHESTRATED"].every((r) => reasons.some((x) => x.includes(r))), JSON.stringify(reasons));
  check("…without echoing the password or the host", !JSON.stringify(reasons).includes(DEV_SECRET) && !JSON.stringify(reasons).includes(DEV_HOST));

  check("the orchestrator's env is accepted", checkRehearsalEnv(GOOD).ok);
  check("127.0.0.1 with a non-rehearsal database name is refused", !checkRehearsalEnv({ ...GOOD, DATABASE_URL: local("fintracker") }).ok);
  check("localhost (not 127.0.0.1) is refused", !checkRehearsalEnv({ ...GOOD, DATABASE_URL: GOOD.DATABASE_URL.replace("127.0.0.1", "localhost") }).ok);
  for (const v of REHEARSAL_URL_VARS) {
    check(`one bad ${v} among good ones is refused`, !checkRehearsalEnv({ ...GOOD, [v]: `postgresql://u:p@${DEV_HOST}:5432/${REHEARSAL_DB_PREFIX}1` }).ok);
  }
  check("an empty fixture ({}) is refused", !checkRehearsalEnv({ ...GOOD, B10REH_FIX: "{}" }).ok);
  check("a missing state is refused", !checkRehearsalEnv({ ...GOOD, B10REH_STATE: "" }).ok);
  check("a missing DATABASE_URL is refused", !checkRehearsalEnv({ ...GOOD, DATABASE_URL: "" }).ok);
  check("a marker that is only the prefix is refused", !checkRehearsalEnv({ ...GOOD, B10REH_ORCHESTRATED: REHEARSAL_CONTAINER_PREFIX }).ok);
  check("a missing marker is refused", !checkRehearsalEnv({ ...GOOD, B10REH_ORCHESTRATED: undefined as unknown as string }).ok);
}

console.log("2. source order: the guard runs before any application import");
for (const p of PROBES) {
  const src = readFileSync(path.join(ROOT, p), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const staticImports = [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  check(`${p}: the ONLY runtime static import is the guard`, staticImports.length === 1 && staticImports[0] === "./lib/b10-rehearsal-guard", JSON.stringify(staticImports));
  const guardAt = code.indexOf("guardRehearsalProbe()");
  const firstDynamic = Math.min(...[code.indexOf("await import("), code.indexOf("imp(\"@/")].filter((i) => i >= 0));
  check(`${p}: guardRehearsalProbe() is called before the first dynamic import`, guardAt >= 0 && guardAt < firstDynamic, `guard@${guardAt} import@${firstDynamic}`);
  check(`${p}: no '?? "{}"' fixture default`, !/B10REH_(FIX|STATE)\s*\?\?/.test(code));
}

console.log("3. each probe, spawned with the developer-like env, refuses before reading anything");
for (const p of PROBES) {
  const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [p, "smoke"], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...DEVELOPER_ENV } as unknown as NodeJS.ProcessEnv,
  });
  const all = `${r.stdout}${r.stderr}`;
  check(`${p}: exits 1`, r.status === 1, `status=${r.status} ${all.slice(-300)}`);
  check(`${p}: prints the refusal`, /B10REH REFUSED/.test(r.stderr));
  check(`${p}: produced no probe result and no PASS/FAIL line`, !/@@B10REH|\b(PASS|FAIL)\b/.test(r.stdout));
  check(`${p}: never echoed the password or the host`, !all.includes(DEV_SECRET) && !all.includes(DEV_HOST));
}

// The evidence file is private: written 0600 and chmod'ed (an existing file keeps its old mode otherwise).
{
  const src = readFileSync(path.join(__dirname, "test-b10-rollback-rehearsal.ts"), "utf8");
  const writes = src.match(/writeFileSync\(EVIDENCE[^;]*;/g) ?? [];
  check("rehearsal evidence: every write is mode 0o600", writes.length > 0 && writes.every((w) => /mode: 0o600/.test(w)), `${writes.length} write(s)`);
  check("rehearsal evidence: chmodSync(EVIDENCE, 0o600) after the write", /chmodSync\(EVIDENCE, 0o600\)/.test(src));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
