/**
 * lib/security/ui-004-permanent-delete.test.ts — UI-004: permanent Space
 * deletion runs a LIVE revocation check before the role check.
 *
 *     npx tsx lib/security/ui-004-permanent-delete.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Source with comments removed (line comments first, so `/admin/*` in prose cannot open a phantom block). */
function routeCode(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function makeChecker(label: string) {
  let failures = 0;
  return {
    check(name: string, cond: boolean, detail?: string): void {
      if (cond) console.log(`  ✓ ${name}`);
      else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
    },
    finish(): never {
      if (failures > 0) { console.error(`\n${label}: ${failures} check(s) failed.`); process.exit(1); }
      console.log(`\n${label}: all checks passed.`);
      process.exit(0);
    },
  };
}

const { check, finish } = makeChecker("UI-004");
console.log("UI-004 — permanent Space delete requires fresh auth");
const r = routeCode("app/api/spaces/[id]/permanent/route.ts");
const freshAt = r.indexOf("await requireFreshUser()");
const roleAt  = r.indexOf("await requireSpaceRole(id, SpaceMemberRole.OWNER)");
const delAt   = r.indexOf("db.space.delete(");
check("requireFreshUser is called and its error returned", freshAt !== -1 && /if \(freshErr\) return freshErr;/.test(r));
check("…BEFORE the role check", freshAt !== -1 && roleAt !== -1 && freshAt < roleAt, `fresh@${freshAt} role@${roleAt}`);
check("…and before the delete", freshAt < delAt);
check("the OWNER role check is still present (fresh auth adds to it, never replaces it)", roleAt !== -1);
const ref = routeCode("app/api/accounts/manual/[id]/permanent/route.ts");
check("parity: the manual-asset permanent delete it mirrors also uses requireFreshUser", ref.includes("requireFreshUser("));
finish();
