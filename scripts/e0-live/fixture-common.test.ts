/**
 * scripts/e0-live/fixture-common.test.ts — the E0-LIVE fixture's pure guard, tag,
 * repo-basis, manifest-matching and drift rules. No database, no network: every
 * URL is synthetic and only parsed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/e0-live/fixture-common.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decideE0LiveGuard, makeTag, parseTag, nonceFromBytes, teardownDeadline, utcDay, repoBasisRefusal, migrationBasisRefusal,
  parseManifest, matchTagToManifest, emptyIds, rowHash, stableJson, driftCounts, MANIFEST_TABLES, DB_ENV_KEYS,
  type E0LiveManifest,
} from "./fixture-common";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const PROD_REF = "prodprojectref0000001";
const PREV_REF = "previewprojectref0002";
const OTHER_REF = "otherprojectref000003";
const SECRET = "s3cr3tPassw0rd";
const direct = (ref: string, port = 5432) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:${port}/postgres`;
const pooled = (ref: string) => `postgresql://postgres.${ref}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`;
const EXP = (over: Record<string, string | undefined> = {}) =>
  ({ FM_PREVIEW_DB_REF: PREV_REF, FM_PRODUCTION_DB_REF: PROD_REF, ...over }) as unknown as NodeJS.ProcessEnv;
const FILE = (over: Record<string, string> = {}) => ({ DIRECT_URL: direct(PREV_REF), DATABASE_URL: pooled(PREV_REF), ...over });
const ok = (d: ReturnType<typeof decideE0LiveGuard>) => d.ok;

console.log("\ne0-live fixture — the guard (Preview only)\n");
const good = decideE0LiveGuard({ exported: EXP(), envFile: FILE(), envFileMode: 0o600 });
check("Preview DIRECT_URL (5432) + Preview pooler URL, refs set, file 0600 ⇒ allowed", good.ok, good);
check("the accepted URL is the DIRECT_URL", good.ok && good.directUrl === direct(PREV_REF));
for (const k of DB_ENV_KEYS) {
  check(`${k} exported in the shell ⇒ refused`, !ok(decideE0LiveGuard({ exported: EXP({ [k]: direct(PREV_REF) }), envFile: FILE(), envFileMode: 0o600 })));
}
check("VERCEL_ENV=production exported ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP({ VERCEL_ENV: "production" }), envFile: FILE(), envFileMode: 0o600 })));
check("VERCEL_ENV=production in the env file ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ VERCEL_ENV: "production" }), envFileMode: 0o600 })));
check("no env file ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP(), envFile: null, envFileMode: null })));
for (const mode of [0o644, 0o640, 0o604, 0o660]) {
  check(`env file mode ${mode.toString(8)} ⇒ refused`, !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE(), envFileMode: mode })));
}
check("FM_PREVIEW_DB_REF unset ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP({ FM_PREVIEW_DB_REF: undefined }), envFile: FILE(), envFileMode: 0o600 })));
check("FM_PRODUCTION_DB_REF unset ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP({ FM_PRODUCTION_DB_REF: undefined }), envFile: FILE(), envFileMode: 0o600 })));
check("preview ref == production ref ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP({ FM_PREVIEW_DB_REF: PROD_REF }), envFile: FILE(), envFileMode: 0o600 })));
check("DIRECT_URL on the PRODUCTION project ⇒ refused",
  !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: direct(PROD_REF) }), envFileMode: 0o600 })));
check("DATABASE_URL on the PRODUCTION project ⇒ refused",
  !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DATABASE_URL: pooled(PROD_REF) }), envFileMode: 0o600 })));
check("Production ref anywhere in a URL string (e.g. a query param) ⇒ refused",
  !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: `${direct(PREV_REF)}?application_name=${PROD_REF}` }), envFileMode: 0o600 })));
check("an unrelated (non-Preview) project ⇒ refused (positive Preview proof required)",
  !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: direct(OTHER_REF), DATABASE_URL: pooled(OTHER_REF) }), envFileMode: 0o600 })));
check("DIRECT_URL on the transaction pooler port ⇒ refused",
  !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: direct(PREV_REF, 6543) }), envFileMode: 0o600 })));
check("a loopback DIRECT_URL ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: `postgresql://fm:${SECRET}@localhost:5432/fintracker` }), envFileMode: 0o600 })));
check("DIRECT_URL missing ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP(), envFile: { DATABASE_URL: pooled(PREV_REF) }, envFileMode: 0o600 })));
check("DATABASE_URL missing ⇒ refused", !ok(decideE0LiveGuard({ exported: EXP(), envFile: { DIRECT_URL: direct(PREV_REF) }, envFileMode: 0o600 })));
const refusalText = JSON.stringify([
  decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: direct(PROD_REF) }), envFileMode: 0o600 }),
  decideE0LiveGuard({ exported: EXP({ DATABASE_URL: direct(PREV_REF) }), envFile: FILE(), envFileMode: 0o600 }),
  decideE0LiveGuard({ exported: EXP(), envFile: FILE({ DIRECT_URL: direct(OTHER_REF) }), envFileMode: 0o600 }),
]);
check("refusals name the rule, never a secret, ref, host or URL",
  !refusalText.includes(SECRET) && !refusalText.includes(PROD_REF) && !refusalText.includes(PREV_REF) && !refusalText.includes(OTHER_REF)
  && !refusalText.includes("supabase.co") && !refusalText.includes("postgresql://"));

console.log("\ne0-live fixture — tag, nonce, deadline\n");
const day = new Date("2026-11-10T08:30:00Z");
check("utcDay = YYYYMMDD", utcDay(day) === "20261110");
check("tag = fm-e0-live-<YYYYMMDD>-<nonce>", makeTag(day, "3fa9c2d1") === "fm-e0-live-20261110-3fa9c2d1");
check("parseTag round-trips", JSON.stringify(parseTag("fm-e0-live-20261110-3fa9c2d1")) === JSON.stringify({ day: "20261110", nonce: "3fa9c2d1" }));
for (const bad of ["fm-e0-live-20261110-3FA9C2D1", "fm-e0-live-2026111-3fa9c2d1", "fm-e0-live-20261110-3fa9c2d", "fm-synthetic-mortgage-review-20261108", "fm-e0-live-20261110-3fa9c2d1x"]) {
  check(`parseTag(${JSON.stringify(bad)}) ⇒ null`, parseTag(bad) === null);
}
let threw = false;
try { makeTag(day, "XYZ"); } catch { threw = true; }
check("makeTag refuses a malformed nonce", threw);
check("nonceFromBytes = 8 hex", nonceFromBytes(new Uint8Array([0x3f, 0xa9, 0xc2, 0xd1, 0x99])) === "3fa9c2d1");
check("teardown deadline = the tag's UTC day 23:59:59Z", teardownDeadline("fm-e0-live-20261110-3fa9c2d1") === "2026-11-10T23:59:59Z");

console.log("\ne0-live fixture — repo basis\n");
const SHA = "a".repeat(40);
check("HEAD = --expect-sha, clean ⇒ allowed", repoBasisRefusal({ headSha: SHA, expectSha: SHA, dirty: false }) === null);
check("no --expect-sha ⇒ refused", repoBasisRefusal({ headSha: SHA, expectSha: null, dirty: false }) !== null);
check("short --expect-sha ⇒ refused", repoBasisRefusal({ headSha: SHA, expectSha: "aaaaaaa", dirty: false }) !== null);
check("HEAD ≠ --expect-sha ⇒ refused", repoBasisRefusal({ headSha: SHA, expectSha: "b".repeat(40), dirty: false }) !== null);
check("dirty tracked files ⇒ refused", repoBasisRefusal({ headSha: SHA, expectSha: SHA, dirty: true }) !== null);
check("migration ledger equal ⇒ allowed", migrationBasisRefusal("20261109000000_x", "20261109000000_x") === null);
check("migration ledger differs ⇒ refused", migrationBasisRefusal("20261109000000_x", "20261108000000_y") !== null);
check("no ledger ⇒ refused", migrationBasisRefusal("20261109000000_x", null) !== null);

console.log("\ne0-live fixture — manifest and tag ∩ manifest\n");
const TAG = "fm-e0-live-20261110-3fa9c2d1";
const ids = emptyIds();
ids.user = ["cuserfixture00000001", "cuserfixture00000002"];
ids.plaidItem = ["citemfixture00000001"];
const manifest: E0LiveManifest = {
  kind: "e0-live-fixture-manifest", tag: TAG, createdAt: day.toISOString(), repoSha: SHA, targetHash: "abcd", teardownDeadline: teardownDeadline(TAG),
  ids, hashes: {}, auditLogIds: [],
};
check("a well-formed manifest parses", (() => { try { parseManifest(JSON.parse(JSON.stringify(manifest)), TAG); return true; } catch { return false; } })());
check("a manifest for another tag is refused", (() => { try { parseManifest(manifest, "fm-e0-live-20261111-3fa9c2d1"); return false; } catch { return true; } })());
check("a manifest with a non-id entry is refused",
  (() => { try { parseManifest({ ...manifest, ids: { ...ids, user: ["x y"] } }, TAG); return false; } catch { return true; } })());
check("the deletion order: incidents and account links before accounts/items/connections, users last",
  MANIFEST_TABLES.at(-1) === "user" && MANIFEST_TABLES.indexOf("syncIssue") < MANIFEST_TABLES.indexOf("plaidItem")
  && MANIFEST_TABLES.indexOf("accountConnection") < MANIFEST_TABLES.indexOf("financialAccount")
  && MANIFEST_TABLES.indexOf("financialAccount") < MANIFEST_TABLES.indexOf("user") && !(MANIFEST_TABLES as readonly string[]).includes("syncIssueEvent"));
const sameByTag = emptyIds();
sameByTag.user = [...ids.user].reverse();
sameByTag.plaidItem = [...ids.plaidItem];
check("tag discovery = manifest ⇒ match ok", matchTagToManifest(sameByTag, manifest).ok);
const extraByTag = { ...sameByTag, user: [...sameByTag.user, "cuserforeign00000009"] };
const mExtra = matchTagToManifest(extraByTag, manifest);
check("a tagged row the manifest lacks ⇒ refused (extras counted)", !mExtra.ok && mExtra.extras.user === 1);
const missingByTag = { ...sameByTag, plaidItem: [] };
const mMissing = matchTagToManifest(missingByTag, manifest);
check("a manifest row the tag no longer finds ⇒ refused (missing counted)", !mMissing.ok && mMissing.missing.plaidItem === 1);

console.log("\ne0-live fixture — drift hashes\n");
check("stableJson sorts keys and normalises Dates", stableJson({ b: 1, a: new Date("2026-11-10T00:00:00Z") }) === `{"a":"2026-11-10T00:00:00.000Z","b":1}`);
check("rowHash is order-independent", rowHash({ a: 1, b: "x" }) === rowHash({ b: "x", a: 1 }));
check("rowHash changes with a value", rowHash({ status: "ERROR" }) !== rowHash({ status: "ACTIVE" }));
const seeded = { plaidItem: { i1: rowHash({ status: "ERROR" }), i2: rowHash({ status: "NEEDS_REAUTH" }) } };
check("no drift ⇒ empty", Object.keys(driftCounts(seeded, { plaidItem: { ...seeded.plaidItem } })).length === 0);
check("a job writing status ⇒ drift counted", driftCounts(seeded, { plaidItem: { i1: rowHash({ status: "ACTIVE" }), i2: seeded.plaidItem.i2 } }).plaidItem === 1);
check("a vanished row ⇒ drift counted", driftCounts(seeded, { plaidItem: { i1: seeded.plaidItem.i1 } }).plaidItem === 1);

console.log("\ne0-live fixture — module purity\n");
const src = readFileSync(path.join(process.cwd(), "scripts/e0-live/fixture-common.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
check("fixture-common imports only node:crypto and pure repo helpers (no Prisma, no lib/db, no fs)",
  specs.every((s) => ["node:crypto", "@/lib/db/target-identity", "../lib/repair-env-guard"].includes(s)), specs);

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
