/**
 * scripts/lib/acl-core.test.ts — the pure half of db:regrant.
 *
 *   npx tsx scripts/lib/acl-core.test.ts
 */
import { aclKey, diffAcl, isCloneName, parseAcl, qi, renderRegrant, type AclEntry } from "./acl-core";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

console.log("parse");
const ref = parseAcl([
  "table|Transaction||fm_app|SELECT",
  "table|Transaction||fm_app|INSERT",
  "table|RateLimit||fm_auth|INSERT",
  "column|User|email|fm_auth|SELECT",
  "sequence|Seq||fm_system|USAGE",
  "function|current_fm_user_id()||fm_app|EXECUTE",
  "schema|public||fm_app|USAGE",
  "default|r||fm_system|SELECT",
  "",
].join("\n"));
check("8 entries, blank lines ignored", ref.length === 8, ref.length);
check("empty column for non-column rows", ref[0].column === "" && ref[3].column === "email");
check("rejects a malformed line", throws(() => parseAcl("table|X|fm_app|SELECT")));
check("rejects an unknown object type", throws(() => parseAcl("view|X||fm_app|SELECT")));

console.log("diff");
// A --no-privileges restore: the target holds none of it, plus one over-grant.
const restored = parseAcl("table|Transaction||fm_auth|SELECT");
const d = diffAcl(ref, restored);
check("everything in the reference is missing on the restore", d.missing.length === 8, d.missing.length);
check("the over-grant is reported as extra", d.extra.length === 1 && d.extra[0].grantee === "fm_auth");
const same = diffAcl(ref, [...ref].reverse());
check("identical sets (any order) diff to nothing", same.missing.length === 0 && same.extra.length === 0);
check("aclKey distinguishes column from table grants",
  aclKey({ objType: "column", name: "User", column: "email", grantee: "fm_auth", privilege: "SELECT" }) !==
  aclKey({ objType: "table", name: "User", column: "", grantee: "fm_auth", privilege: "SELECT" }));

console.log("render");
const sql = renderRegrant(d);
check("one GRANT per missing entry, no REVOKE by default", sql.length === 8 && sql.every((s) => s.startsWith("GRANT ") || s.startsWith("ALTER DEFAULT PRIVILEGES")));
check("table grant is schema-qualified and quoted", sql.includes(`GRANT SELECT ON TABLE public."Transaction" TO "fm_app";`), sql);
check("column grant names the column", sql.includes(`GRANT SELECT ("email") ON TABLE public."User" TO "fm_auth";`), sql);
check("sequence grant", sql.includes(`GRANT USAGE ON SEQUENCE public."Seq" TO "fm_system";`));
check("function grant uses the regprocedure text", sql.includes(`GRANT EXECUTE ON FUNCTION current_fm_user_id() TO "fm_app";`));
check("schema grant", sql.includes(`GRANT USAGE ON SCHEMA "public" TO "fm_app";`));
check("default privileges", sql.includes(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "fm_system";`));
const withRevoke = renderRegrant(d, { revokeExtra: true });
check("--revoke-extra adds the REVOKE", withRevoke.includes(`REVOKE SELECT ON TABLE public."Transaction" FROM "fm_auth";`), withRevoke);

console.log("refusals");
const bad = (over: Partial<AclEntry>): AclEntry => ({ objType: "table", name: "T", column: "", grantee: "fm_app", privilege: "SELECT", ...over });
check("refuses an unknown privilege", throws(() => renderRegrant({ missing: [bad({ privilege: "ALL; DROP TABLE x" })], extra: [] })));
check("refuses a grantee outside fm_*", throws(() => renderRegrant({ missing: [bad({ grantee: "postgres" })], extra: [] })));
check("identifier quoting escapes double quotes", qi('a"b') === '"a""b"');
check("clone names accepted, others refused",
  isCloneName("fintracker_restore_1") && !isCloneName("postgres") && !isCloneName("fintracker-prod") && !isCloneName("FINTRACKER_x"));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
