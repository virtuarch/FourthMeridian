/**
 * lib/db/connection-url.test.ts  (PROD-POOLER-AUTH-INCIDENT-1)
 *
 * The accidental `connection_limit=1` is what turned Fluid Compute's in-process
 * concurrency into a 10-second serial queue and then into P2024. These tests pin
 * the replacement AND — just as important — pin everything the replacement must
 * NOT touch: transaction-mode pooling, port 6543, credentials, schema.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  withConnectionLimit,
  runtimeDatasourceUrl,
  RUNTIME_CONNECTION_LIMIT,
} from "@/lib/db/connection-url";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Shapes mirroring the real configuration (dummy credentials only).
const POOLED = "postgresql://postgres.qirfzvvaeddukjiphims:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1";
const LOCAL  = "postgresql://fintracker:pw@localhost:5432/fintracker?schema=public";

console.log("PROD-POOLER-AUTH-INCIDENT-1 — runtime connection-limit normalisation");

function main() {
  // ── The chosen value ────────────────────────────────────────────────────────
  check("the runtime limit is no longer 1", RUNTIME_CONNECTION_LIMIT > 1);
  check("…and is conservative (aggregate 19 instances x limit stays under the fixed 200 client ceiling)",
    19 * RUNTIME_CONNECTION_LIMIT < 200,
    `19 x ${RUNTIME_CONNECTION_LIMIT} = ${19 * RUNTIME_CONNECTION_LIMIT}`);
  check("…and covers the observed 7-14 request burst within the 10s pool_timeout even at 2.4s/query",
    (14 * 2.4) / RUNTIME_CONNECTION_LIMIT < 10,
    `${((14 * 2.4) / RUNTIME_CONNECTION_LIMIT).toFixed(1)}s`);

  // ── The leaked value is REPLACED, not appended ──────────────────────────────
  const fixed = withConnectionLimit(POOLED)!;
  const params = new URL(fixed).searchParams;
  check("the leaked connection_limit=1 is replaced",
    params.get("connection_limit") === String(RUNTIME_CONNECTION_LIMIT),
    params.get("connection_limit") ?? "(absent)");
  check("…exactly once (no ambiguous duplicate parameter)",
    params.getAll("connection_limit").length === 1 &&
    (fixed.match(/connection_limit=/g) ?? []).length === 1);
  check("…and connection_limit=1 no longer appears anywhere in the string",
    !/connection_limit=1(?!\d)/.test(fixed), fixed);

  // ── Everything else is preserved ────────────────────────────────────────────
  const before = new URL(POOLED);
  const after  = new URL(fixed);
  check("PRESERVED: pgbouncer=true (transaction mode stays on)",
    after.searchParams.get("pgbouncer") === "true");
  check("PRESERVED: port 6543 (runtime traffic does NOT move to the direct DB)",
    after.port === "6543" && after.port === before.port);
  check("PRESERVED: host unchanged", after.hostname === before.hostname);
  check("PRESERVED: credentials unchanged",
    after.username === before.username && after.password === before.password);
  check("PRESERVED: database path unchanged", after.pathname === before.pathname);

  // A local dev URL keeps its schema parameter and its port.
  const localFixed = new URL(withConnectionLimit(LOCAL)!);
  check("a local (non-pooled) URL keeps schema=public and port 5432",
    localFixed.searchParams.get("schema") === "public" && localFixed.port === "5432");
  check("…and is normalised to the same runtime limit",
    localFixed.searchParams.get("connection_limit") === String(RUNTIME_CONNECTION_LIMIT));

  // ── Absent / malformed input must never break startup ───────────────────────
  check("undefined stays undefined (Prisma raises its own config error)",
    withConnectionLimit(undefined) === undefined);
  check("empty string is returned unchanged", withConnectionLimit("") === "");
  const junk = "not a url at all";
  check("an unparseable value is returned unchanged rather than guessed",
    withConnectionLimit(junk) === junk);
  let threw = false;
  try { withConnectionLimit("postgresql://["); } catch { threw = true; }
  check("a malformed URL never throws", threw === false);

  // ── An explicit override is honoured (so sizing stays testable) ─────────────
  check("an explicit limit argument is applied",
    new URL(withConnectionLimit(POOLED, 7)!).searchParams.get("connection_limit") === "7");

  // ── runtimeDatasourceUrl reads the env var ──────────────────────────────────
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = POOLED;
  const fromEnv = runtimeDatasourceUrl()!;
  check("runtimeDatasourceUrl normalises DATABASE_URL",
    new URL(fromEnv).searchParams.get("connection_limit") === String(RUNTIME_CONNECTION_LIMIT));
  delete process.env.DATABASE_URL;
  check("…and returns undefined when DATABASE_URL is unset",
    runtimeDatasourceUrl() === undefined);
  if (prev === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prev;

  // ── DIRECT_URL is not this module's business ────────────────────────────────
  // Comments are stripped first: they discuss DIRECT_URL deliberately, and a
  // guard that fires on its own documentation is a false positive (a mistake
  // this repo has made before).
  const moduleSrc = readFileSync(
    path.join(process.cwd(), "lib/db/connection-url.ts"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("the module never reads DIRECT_URL (migrations keep port 5432 untouched)",
    !/DIRECT_URL/.test(moduleSrc));
}

main();
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll connection-limit normalisation checks passed.");
