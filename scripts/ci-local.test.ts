/**
 * scripts/ci-local.test.ts
 *
 * `npm run ci` is only evidence about GitHub CI while it runs what GitHub runs,
 * on the runtime GitHub and production run. This pins that: ci.yml's `run:`
 * steps, per job and in order, ARE scripts/lib/ci-contract's lists; both jobs
 * take Node from .nvmrc; .nvmrc and engines.node name the same major; the
 * Postgres service is the one the local runner starts; and no job reaches for
 * repository history (fetch-depth) — the unit tier is hermetic by contract.
 *
 * Hermetic: reads three committed files, spawns nothing.
 *
 * Run: npx tsx scripts/ci-local.test.ts
 */

import { readFileSync } from "node:fs";
import {
  ARCHITECTURE_JOB, CI_POSTGRES, DB_URL_VARS, TEST_JOB, enginesMajor, nvmrcMajor, withoutDatabaseUrls,
} from "./lib/ci-contract";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const yml = readFileSync(".github/workflows/ci.yml", "utf8");

/** The text of one job block under `jobs:` (2-space job keys). */
function jobBlock(key: string): string {
  const start = yml.indexOf(`\n  ${key}:\n`);
  if (start < 0) return "";
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const runSteps = (block: string) =>
  [...block.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) => m[1].trim());

console.log("ci.yml runs exactly what `npm run ci` runs");
{
  const test = runSteps(jobBlock("test"));
  const arch = runSteps(jobBlock("architecture"));
  check("test job steps === TEST_JOB, in order",
    JSON.stringify(test) === JSON.stringify(TEST_JOB), JSON.stringify(test));
  check("architecture job steps === ARCHITECTURE_JOB, in order",
    JSON.stringify(arch) === JSON.stringify(ARCHITECTURE_JOB), JSON.stringify(arch));
  const jobs = [...yml.slice(yml.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]);
  check("exactly the two jobs the contract covers", JSON.stringify(jobs) === '["test","architecture"]',
    JSON.stringify(jobs));
}

console.log("one runtime: .nvmrc = CI = engines.node (production)");
{
  const nvmrc = nvmrcMajor(readFileSync(".nvmrc", "utf8"));
  const engines = enginesMajor(JSON.parse(readFileSync("package.json", "utf8")).engines?.node);
  check(".nvmrc names a major", nvmrc !== null);
  check("engines.node names the same major", engines !== null && engines === nvmrc, `${engines} vs ${nvmrc}`);
  for (const key of ["test", "architecture"]) {
    const block = jobBlock(key);
    check(`${key}: setup-node reads .nvmrc`, /node-version-file:\s*\.nvmrc/.test(block));
    check(`${key}: no hard-coded node-version`, !/node-version:\s/.test(block));
  }
}

console.log("the throwaway database is the one CI uses");
{
  const arch = jobBlock("architecture");
  check(`service image ${CI_POSTGRES.image}`, new RegExp(`image:\\s*${CI_POSTGRES.image}\\s*$`, "m").test(arch));
  check("service user / password / database match",
    arch.includes(`POSTGRES_USER: ${CI_POSTGRES.user}`)
    && arch.includes(`POSTGRES_PASSWORD: ${CI_POSTGRES.password}`)
    && arch.includes(`POSTGRES_DB: ${CI_POSTGRES.database}`));
  const config = yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  check("no job needs repository history (no fetch-depth)", !/fetch-depth/.test(config));
}

console.log("contract helpers");
{
  check("nvmrc: 24 / v24 / 24.21.0 ⇒ 24",
    nvmrcMajor("24\n") === 24 && nvmrcMajor("v24") === 24 && nvmrcMajor("24.21.0\n") === 24);
  check("nvmrc: lts/* and garbage ⇒ null (refused, not guessed)",
    nvmrcMajor("lts/*") === null && nvmrcMajor("") === null);
  check("engines: 24.x / 24 ⇒ 24, a range ⇒ null", enginesMajor("24.x") === 24
    && enginesMajor("24") === 24 && enginesMajor(">=20.9.0") === null && enginesMajor(undefined) === null);
  const stripped = withoutDatabaseUrls({ NODE_ENV: "test", DATABASE_URL: "postgresql://x@h/fintracker",
    DIRECT_URL: "d", SHADOW_DATABASE_URL: "s", KEEP: "k" });
  check("every database URL is removed from the inherited environment",
    DB_URL_VARS.every((k) => !(k in stripped)) && stripped.KEEP === "k" && stripped.NODE_ENV === "test");
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
