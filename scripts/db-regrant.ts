/**
 * scripts/db-regrant.ts  (DR — re-establish GRANTs after a restore)
 *
 *   REGRANT_REFERENCE_URL=postgres://…/fintracker_ref \
 *   REGRANT_TARGET_URL=postgres://…/fintracker_restore \
 *   npm run db:regrant                 # dry run: report missing / extra privileges
 *   npm run db:regrant -- --apply      # GRANT what is missing, in one transaction
 *   npm run db:regrant -- --apply --revoke-extra
 *
 * REFERENCE = an empty database with the full migration history applied (the
 * authority on what the roles should hold). TARGET = the database restored from a
 * `--no-owner --no-privileges` dump. Both URLs must authenticate as a role that can
 * read the catalogs and (for --apply) grant on the target's objects — the restore
 * owner.
 *
 * Safety:
 *   - dry run by default; nothing is written without --apply;
 *   - the target must be a recognised clone (`fintracker_*`). Running against a
 *     hosted Production restore is a separate, owner-approved change to this tool;
 *   - extra privileges on the target are reported as findings and only revoked
 *     with --revoke-extra;
 *   - role attributes (LOGIN / BYPASSRLS / SUPERUSER) are printed for both sides and
 *     never changed: roles are cluster-level and must exist before a restore.
 *
 * Runbook: docs/operations/backup-restore-verification.md §4 step 3.
 */

import { spawnSync } from "node:child_process";
import {
  ACL_QUERY, ROLE_QUERY, diffAcl, isCloneName, parseAcl, renderRegrant,
} from "./lib/acl-core";

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", url], { encoding: "utf8", input: sql });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr ?? "").trim().split("\n")[0]}`);
  return (r.stdout ?? "").trim();
}

const dbName = (url: string): string => new URL(url).pathname.replace(/^\//, "");
const redact = (url: string): string => { const u = new URL(url); u.password = u.password ? "***" : ""; return u.toString(); };

function main(): void {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const revokeExtra = args.has("--revoke-extra");
  const reference = process.env.REGRANT_REFERENCE_URL;
  const target = process.env.REGRANT_TARGET_URL;
  if (!reference || !target) {
    console.error("Set REGRANT_REFERENCE_URL (freshly migrated) and REGRANT_TARGET_URL (the restore).");
    process.exit(2);
  }
  const targetName = dbName(target);
  if (!isCloneName(targetName)) {
    console.error(`Refusing: target database "${targetName}" is not a recognised clone (fintracker_*). Production use requires an owner-approved change to this tool.`);
    process.exit(2);
  }
  if (dbName(reference) === targetName && new URL(reference).host === new URL(target).host) {
    console.error("Refusing: reference and target are the same database.");
    process.exit(2);
  }

  console.log(`[regrant] reference ${redact(reference)}`);
  console.log(`[regrant] target    ${redact(target)}${apply ? "  (APPLY)" : "  (dry run)"}`);
  console.log(`[regrant] roles (rolname|login|bypassrls|super)\n  reference: ${psql(reference, ROLE_QUERY).split("\n").join(", ")}\n  target:    ${psql(target, ROLE_QUERY).split("\n").join(", ")}`);

  const diff = diffAcl(parseAcl(psql(reference, ACL_QUERY)), parseAcl(psql(target, ACL_QUERY)));
  console.log(`[regrant] missing on target: ${diff.missing.length}   extra on target: ${diff.extra.length}`);
  for (const e of diff.extra) console.log(`  EXTRA (finding): ${e.objType} ${e.name}${e.column ? `.${e.column}` : ""} → ${e.grantee} ${e.privilege}`);

  const statements = renderRegrant(diff, { revokeExtra });
  if (!statements.length) { console.log("[regrant] nothing to do."); return; }
  if (!apply) {
    console.log("[regrant] would run:");
    for (const s of statements) console.log(`  ${s}`);
    console.log("[regrant] dry run — re-run with --apply to execute.");
    return;
  }
  psql(target, ["BEGIN;", ...statements, "COMMIT;"].join("\n"));
  const after = diffAcl(parseAcl(psql(reference, ACL_QUERY)), parseAcl(psql(target, ACL_QUERY)));
  console.log(`[regrant] applied ${statements.length} statement(s). Now missing: ${after.missing.length}, extra: ${after.extra.length}.`);
  if (after.missing.length || (revokeExtra && after.extra.length)) process.exit(1);
}

main();
