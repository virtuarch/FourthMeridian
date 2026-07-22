/**
 * scripts/remove-orphaned-plaid-items-from-backup.ts
 *
 * Recover and remove Plaid Items that were STRANDED by a database wipe.
 *
 *   npx tsx scripts/remove-orphaned-plaid-items-from-backup.ts backups/postgres-*.sql
 *   npx tsx scripts/remove-orphaned-plaid-items-from-backup.ts --apply backups/postgres-*.sql
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
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   - DRY RUN by default. Without --apply it only calls itemGet() (a read) and
 *     tells you which Items are still live. Pass --apply to call itemRemove().
 *   - --keep=<externalItemId,…> hard-excludes Items you still own. Anything you
 *     are currently using MUST be listed here: an Item removed by mistake cannot
 *     be restored, and the user has to re-link the institution by hand.
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

async function main() {
  const argv  = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const keep  = new Set(
    argv.filter((a) => a.startsWith("--keep=")).flatMap((a) => a.slice(7).split(",")).filter(Boolean),
  );
  const dumps = argv.filter((a) => !a.startsWith("--"));

  if (dumps.length === 0) {
    console.error("Usage: tsx scripts/remove-orphaned-plaid-items-from-backup.ts [--apply] [--keep=id,id] <dump.sql…>");
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error("✗ ENCRYPTION_KEY is not set — must be the PRODUCTION key in effect when the dump was taken.");
    process.exit(1);
  }

  // Dedupe across dumps: the same Item can appear in several backups.
  const byId = new Map<string, DumpItem>();
  for (const d of dumps) for (const it of parseDump(d)) {
    if (!byId.has(it.externalItemId)) byId.set(it.externalItemId, it);
  }

  console.log(`\nPlaid env : ${PLAID_ENV}`);
  console.log(`Mode      : ${apply ? "APPLY — will call itemRemove()" : "DRY RUN — read-only itemGet()"}`);
  console.log(`Dumps     : ${dumps.length}`);
  console.log(`Items     : ${byId.size} distinct${keep.size ? `  (keeping ${keep.size})` : ""}\n`);

  let live = 0, gone = 0, removed = 0, failed = 0, skipped = 0;

  for (const item of byId.values()) {
    const label = `${item.externalItemId}  ${item.institutionName.padEnd(22)}`;

    if (keep.has(item.externalItemId)) {
      console.log(`KEEP     ${label} (explicitly excluded)`);
      skipped++;
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
        console.log(`LIVE     ${label} (would remove)`);
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
    `\n${apply ? `removed ${removed}` : `live ${live}`} · already-gone ${gone} · kept ${skipped} · failed ${failed}\n`,
  );
  if (!apply && live > 0) console.log("Re-run with --apply to remove the LIVE items above.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
