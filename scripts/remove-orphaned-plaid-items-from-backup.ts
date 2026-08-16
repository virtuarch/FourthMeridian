/**
 * scripts/remove-orphaned-plaid-items-from-backup.ts
 *
 * Recover and remove Plaid Items that were STRANDED by a database wipe.
 *
 *   npm run plaid:orphans -- backups/postgres-*.sql                      # dry run
 *   npm run plaid:orphans -- --keep-from-db backups/postgres-*.sql       # dry run, real keep-list
 *   npm run plaid:orphans -- --apply --keep-from-db backups/postgres-*.sql
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * `npm run db:wipe` drops the `public` schema. The PlaidItem rows go with it —
 * including `encryptedToken`, the ONLY copy of the Plaid access_token. The Item
 * itself keeps existing on Plaid's side: it goes on emitting webhooks (which
 * arrive as "[plaid webhook] no PlaidItem for item_id … — ack, nothing to do")
 * and, because Transactions is a subscription product, it goes on incurring a
 * monthly fee for as long as it exists. Only /item/remove ends that, and
 * /item/remove needs the access_token we just destroyed.
 *
 * The recovery is that db-wipe.ts REFUSES to run without a successful pg_dump
 * first. So the token is not actually gone — it is sitting in the dump that the
 * wipe itself took, in `backups/`. This script reads the Items straight out of
 * those dumps and closes them out on Plaid.
 *
 * ── Running this (the `server-only` break) ───────────────────────────────────
 * `lib/plaid/client.ts` reaches `lib/plaid/provider-call.ts`, which declares
 * `import "server-only"` — a Next-internal alias that is NOT an installed npm
 * package. Under a plain tsx runtime that import throws MODULE_NOT_FOUND before
 * this script does anything at all. The fix is the SAME preload the test runner
 * already uses (scripts/lib/server-only-preload.cjs); `npm run plaid:orphans`
 * wires it up. Invoking this file with bare `npx tsx` will still fail — use the
 * npm script, or pass `--require scripts/lib/server-only-preload.cjs` yourself.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   - DRY RUN by default. Without --apply it only calls itemGet() (a read) and
 *     tells you which Items are still live.
 *   - --apply REFUSES without a keep-list. An Item removed by mistake cannot be
 *     restored; the user has to re-link the institution by hand. A keep-list is
 *     therefore mandatory for the destructive mode, never a default-empty
 *     convenience. Supply it with --keep=<ids>, --keep-from-db, or both.
 *   - --keep-from-db reads the CURRENT PlaidItem set out of the database that
 *     DATABASE_URL points at, so the protected set is live truth rather than a
 *     hand-copied list that went stale the moment someone re-linked. The
 *     database identity (host/name, never credentials) is printed before any
 *     Plaid call so you can see which database you actually protected.
 *   - Every explicit --keep id must appear in the dumps. A typo'd id silently
 *     protects nothing, which is exactly how a live Item gets removed; an
 *     unmatched id is a hard error, not a warning.
 *   - ZERO overlap between a --keep-from-db set and the dumps means the database
 *     and the dumps almost certainly describe different environments (the
 *     classic mistake: local DATABASE_URL, production dumps). --apply refuses;
 *     pass --allow-zero-overlap only when you have confirmed it is genuine.
 *   - Access tokens are decrypted in memory and NEVER printed or logged.
 *   - Items are deduped by externalItemId across dumps, so overlapping backups
 *     are safe to pass together.
 *
 * ── Required environment ─────────────────────────────────────────────────────
 *   ENCRYPTION_KEY   the PRODUCTION key (64 hex chars). Must be the key that was
 *                    in effect when the dump was taken, or decryption fails.
 *   PLAID_CLIENT_ID  production credentials — these Items live in Plaid
 *   PLAID_SECRET     production, and that is the environment they must be
 *   PLAID_ENV        removed from.
 *   DATABASE_URL     only when --keep-from-db is used; the database whose Items
 *                    must be PROTECTED (i.e. production, for production dumps).
 *
 * Handles both ciphertext formats: v1 ("iv:tag:ct", root key) from older rows
 * and v2 ("v2:iv:tag:ct", HKDF-derived subkey). decryptWithPurpose() dispatches
 * on shape, so mixed-vintage dumps need no special handling here.
 */

import { readFileSync } from "node:fs";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { plaidClient, PLAID_ENV } from "@/lib/plaid/client";

interface DumpItem {
  externalItemId:  string;
  institutionName: string;
  encryptedToken:  string;
  sourceDump:      string;
}

/**
 * Pull the PlaidItem rows out of a plain-format pg_dump.
 *
 * pg_dump writes table data as a COPY block: a header naming the columns in
 * order, then tab-separated rows, terminated by a lone `\.`. Column order is
 * read from the header rather than assumed — the schema has changed before
 * (syncLockedAt, investmentsConsent) and will again, and a positional guess
 * would silently read the wrong field after the next migration.
 */
function parseDump(path: string): DumpItem[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith('COPY public."PlaidItem" ('));
  if (start === -1) return [];

  const cols = lines[start]
    .slice(lines[start].indexOf("(") + 1, lines[start].lastIndexOf(")"))
    .split(",")
    .map((c) => c.trim().replace(/^"|"$/g, ""));

  const iExternal = cols.indexOf("externalItemId");
  const iInst     = cols.indexOf("institutionName");
  const iToken    = cols.indexOf("encryptedToken");
  if (iExternal === -1 || iToken === -1) {
    throw new Error(`${path}: PlaidItem COPY block is missing expected columns`);
  }

  const out: DumpItem[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "\\." || line === "") break;
    const f = line.split("\t");
    out.push({
      externalItemId:  f[iExternal],
      institutionName: f[iInst] ?? "(unknown)",
      encryptedToken:  f[iToken],
      sourceDump:      path.split("/").pop() ?? path,
    });
  }
  return out;
}

/**
 * Credential-free database identity for the console — mirrors the `hostDb`
 * idiom in scripts/db-guard.ts. That file runs its preflight at module scope
 * (and calls process.exit), so it cannot be imported; the six lines are
 * duplicated deliberately rather than making a destructive preflight importable.
 */
function hostDb(url: string | undefined): string {
  if (!url) return "(DATABASE_URL unset)";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * The CURRENT set of Item ids the connected database still owns. Imported
 * dynamically so that a run WITHOUT --keep-from-db needs no database at all —
 * the dry run against production dumps must stay usable from a laptop that has
 * no production DATABASE_URL.
 */
async function keepListFromDb(): Promise<Set<string>> {
  const { db } = await import("@/lib/db");
  const rows = await db.plaidItem.findMany({ select: { externalItemId: true } });
  return new Set(rows.map((r: { externalItemId: string }) => r.externalItemId));
}

function fail(...lines: string[]): never {
  console.error(`\n✗ ${lines[0]}`);
  for (const l of lines.slice(1)) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
}

async function main() {
  const argv  = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const keepFromDb        = argv.includes("--keep-from-db");
  const allowZeroOverlap  = argv.includes("--allow-zero-overlap");
  const explicitKeep = new Set(
    argv.filter((a) => a.startsWith("--keep=")).flatMap((a) => a.slice(7).split(",")).filter(Boolean),
  );
  const dumps = argv.filter((a) => !a.startsWith("--"));

  if (dumps.length === 0) {
    console.error("Usage: npm run plaid:orphans -- [--apply] [--keep=id,id] [--keep-from-db] <dump.sql…>");
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    fail("ENCRYPTION_KEY is not set — must be the PRODUCTION key in effect when the dump was taken.");
  }

  // Dedupe across dumps: the same Item can appear in several backups.
  const byId = new Map<string, DumpItem>();
  for (const d of dumps) for (const it of parseDump(d)) {
    if (!byId.has(it.externalItemId)) byId.set(it.externalItemId, it);
  }

  // ── Resolve the protected set ───────────────────────────────────────────────
  const keep = new Set(explicitKeep);
  let dbIdentity = "(not consulted)";
  let dbCount = 0;
  if (keepFromDb) {
    dbIdentity = hostDb(process.env.DATABASE_URL);
    const fromDb = await keepListFromDb();
    dbCount = fromDb.size;
    for (const id of fromDb) keep.add(id);
  }

  // A typo'd --keep id protects nothing. Catch it before any Plaid call.
  const unmatched = [...explicitKeep].filter((id) => !byId.has(id));
  if (unmatched.length > 0) {
    fail(
      `${unmatched.length} --keep id(s) do not appear in the supplied dumps:`,
      ...unmatched.map((id) => `  ${id}`),
      "A keep id that matches nothing protects nothing. Fix the id or drop it.",
    );
  }

  const overlap = [...keep].filter((id) => byId.has(id)).length;
  const candidates = [...byId.values()].filter((i) => !keep.has(i.externalItemId));

  console.log(`\nPlaid env  : ${PLAID_ENV}`);
  console.log(`Mode       : ${apply ? "APPLY — will call itemRemove()" : "DRY RUN — read-only itemGet()"}`);
  console.log(`Dumps      : ${dumps.length}`);
  console.log(`Items      : ${byId.size} distinct`);
  console.log(`Keep-list  : ${keep.size} id(s)` +
    (keepFromDb ? `  [--keep-from-db: ${dbCount} from ${dbIdentity}]` : "") +
    (explicitKeep.size ? `  [--keep: ${explicitKeep.size} explicit]` : ""));
  console.log(`Protected  : ${overlap} of ${byId.size} dump items`);
  console.log(`Candidates : ${candidates.length}\n`);

  // ── Destructive-mode gates ──────────────────────────────────────────────────
  if (apply) {
    if (keep.size === 0) {
      fail(
        "--apply refused: no keep-list.",
        "Removing an Item at Plaid is IRREVERSIBLE — the institution must be re-linked by hand.",
        "Supply the Items to protect with --keep-from-db (recommended) and/or --keep=<id,…>.",
        "Run without --apply first and read the candidate list.",
      );
    }
    if (keepFromDb && overlap === 0 && !allowZeroOverlap) {
      fail(
        "--apply refused: the --keep-from-db set does not overlap the dumps at all.",
        `Database : ${dbIdentity} (${dbCount} Items)`,
        `Dumps    : ${byId.size} Items, 0 protected`,
        "That normally means DATABASE_URL and the dumps are different environments",
        "(e.g. a local DATABASE_URL against production dumps) — in which case this",
        "run would remove every live production Item.",
        "Point DATABASE_URL at the matching environment, or pass --allow-zero-overlap",
        "if you have confirmed the dumps really are all orphans.",
      );
    }
  }

  let live = 0, gone = 0, removed = 0, failed = 0;
  const liveIds: string[] = [];

  for (const item of byId.values()) {
    const label = `${item.externalItemId}  ${item.institutionName.padEnd(22)}`;

    if (keep.has(item.externalItemId)) {
      console.log(`KEEP     ${label} (protected)`);
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    } catch {
      // Wrong ENCRYPTION_KEY, or a key rotated since this dump was taken.
      console.log(`DECRYPT✗ ${label} (cannot decrypt — wrong ENCRYPTION_KEY for this vintage?)`);
      failed++;
      continue;
    }

    try {
      if (!apply) {
        await plaidClient.itemGet({ access_token: accessToken });
        console.log(`LIVE     ${label} (orphan candidate — would be removed)`);
        liveIds.push(item.externalItemId);
        live++;
      } else {
        await plaidClient.itemRemove({ access_token: accessToken });
        console.log(`REMOVED  ${label}`);
        removed++;
      }
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
      if (code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN") {
        console.log(`ALREADY  ${label} (${code} — already removed)`);
        gone++;
      } else {
        console.log(`ERROR    ${label} (${code ?? "unknown"})`);
        failed++;
      }
    }
  }

  console.log(
    `\n${apply ? `removed ${removed}` : `live ${live}`} · already-gone ${gone} · kept ${keep.size ? overlap : 0} · failed ${failed}\n`,
  );

  if (!apply && live > 0) {
    console.log("LIVE orphan candidates (copy into --keep= to EXCLUDE any you still own):");
    console.log(liveIds.join(","));
    console.log(
      "\nTo remove them, re-run the SAME command with --apply AND a keep-list:\n" +
      "  npm run plaid:orphans -- --apply --keep-from-db <the same dump paths>\n" +
      "DATABASE_URL must point at the environment that OWNS the Items you are keeping.\n",
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
