/**
 * scripts/e0-live/teardown.ts — removes ONE day's E0-LIVE fixture from PREVIEW (design §3.4).
 * DRAFT for S2 line review (L2). Nothing here has been run against any database.
 *
 *   (default)  DRY RUN: guards → ONE read-only transaction (SET TRANSACTION READ ONLY):
 *              discovers the fixture BY TAG (and by tagged owner), matches it against the
 *              manifest, re-hashes the drift columns, prints counts — deleted-if-applied,
 *              extras / missing, drift, rows left in place.
 *   --apply    the same discovery, then deletes EXACTLY tag ∩ manifest in ONE transaction
 *              (fixture-db.teardownInTx): refuses on ANY extra or missing row, on a delete
 *              count ≠ manifest, and when any tagged row remains (post-check tag count 0).
 *
 *   FM_E0_LIVE_ENV_FILE=<0600 Preview env file> FM_PREVIEW_DB_REF=<ref> FM_PRODUCTION_DB_REF=<ref> \
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/e0-live/teardown.ts \
 *     --tag=fm-e0-live-<YYYYMMDD>-<nonce> --expect-sha=<Preview deployment SHA> [--apply]
 *
 * The manifest is ~/FourthMeridian-private/platform-ai-e0-live-<YYYYMMDD>/fixture/manifest-<tag>.json
 * (written by seed.ts --apply). There is no tag-only mode: no manifest ⇒ refuse.
 * Left in place on purpose (printed as counts): AuditLog (append-only — R-6), AiInvocation
 * (cost ledger), any SyncIssueEvent an operator action wrote on a fixture incident.
 * Counts only; never an id, a name, an address or a payload.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { driftCounts, parseManifest, parseTag } from "./fixture-common";
import { assertRepoBasis, die, loadPrisma, logLine, printCounts, privateFixtureDir, runGuards, stamp } from "./fixture-io";

const argv = process.argv.slice(2);
for (const a of argv) if (a !== "--apply" && !a.startsWith("--tag=") && !a.startsWith("--expect-sha=")) die(`unknown argument ${a.split("=")[0]}`);
const APPLY = argv.includes("--apply");
const tag = argv.find((a) => a.startsWith("--tag="))?.slice("--tag=".length) ?? "";
const expectSha = argv.find((a) => a.startsWith("--expect-sha="))?.slice("--expect-sha=".length) ?? null;
const parsed = parseTag(tag);
if (!parsed) die("--tag=fm-e0-live-<YYYYMMDD>-<8 hex> is required.");

async function main(): Promise<void> {
  const guard = runGuards();                // before anything that can reach a database
  const { sha } = assertRepoBasis(expectSha);
  const dir = privateFixtureDir(parsed!.day);
  const file = path.join(dir, `manifest-${tag}.json`);
  if (!existsSync(file)) die("the manifest for this tag was not found — there is no tag-only teardown.");
  const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")), tag);
  if (manifest.targetHash !== guard.targetHash) die("the manifest was written for a different database than this connection.");
  const LOG = path.join(dir, `teardown-${APPLY ? "apply" : "dry-run"}-${stamp()}.log`);
  logLine(LOG, `mode=${APPLY ? "apply" : "dry-run"} repoSha=${sha}`);
  if (Date.now() > Date.parse(manifest.teardownDeadline)) console.log("NOTE: past the same-day teardown deadline — tear down now and record it in the RUN-LOG.");

  const { previewTeardown, readDriftHashes, leftInPlace, teardownInTx } = await import("./fixture-db");
  const prisma = await loadPrisma(guard.directUrl);
  try {
    await prisma.$transaction(async (tx) => {
      if (!APPLY) await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`); // the first statement of the transaction
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '60s'`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);

      const { match, counts } = await previewTeardown(tx, manifest);
      const drift = driftCounts(manifest.hashes, await readDriftHashes(tx, manifest.ids));
      const kept = await leftInPlace(tx, manifest);
      printCounts(`fixture ${APPLY ? "to delete" : "an --apply would delete"} (manifest rows by table):`, counts);
      printCounts("found by tag but NOT in the manifest (refuses):", match.extras as Record<string, number>);
      printCounts("in the manifest but NOT found by tag (refuses):", match.missing as Record<string, number>);
      printCounts("drifted rows since seed (cases that read them are FIXTURE_DRIFT):", drift as Record<string, number>);
      printCounts("left in place on purpose:", kept);
      logLine(LOG, `match=${match.ok} extras=${JSON.stringify(match.extras)} missing=${JSON.stringify(match.missing)} drift=${JSON.stringify(drift)} kept=${JSON.stringify(kept)}`);
      if (!APPLY) return;
      const del = await teardownInTx(tx, manifest);
      printCounts("DELETED (committed with this transaction; post-check: 0 tagged rows remain):", del);
      logLine(LOG, `deleted ${JSON.stringify(del)}`);
    }, { timeout: 120_000, maxWait: 20_000 });
  } catch (e) {
    const msg = (e as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>");
    logLine(LOG, `FAILED (rolled back): ${msg}`);
    console.error(`FAILED — transaction rolled back: ${msg}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  await prisma.$disconnect();
  if (APPLY) console.log("teardown committed. The manifest is kept as the record; run the next-day sweep check.");
}

main().catch((e) => {
  console.error(`could not run: ${(e as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>")}`);
  process.exit(1);
});
