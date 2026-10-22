/**
 * lib/security/ui-022-admin-bounds.test.ts — UI-022: the admin overview and the
 * admin user/Space list APIs never load every row.
 *
 *     npx tsx lib/security/ui-022-admin-bounds.test.ts
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

const { check, finish } = makeChecker("UI-022");
console.log("UI-022 — bounded admin reads");

const page = routeCode("app/admin/page.tsx");
check("overview: both findMany calls are bounded by ADMIN_OVERVIEW_TAKE",
  (page.match(/take:\s*ADMIN_OVERVIEW_TAKE/g) ?? []).length === 2 && /const ADMIN_OVERVIEW_TAKE = \d+;/.test(page));
check("overview: stat cards use count(), not the bounded list length",
  page.includes("db.user.count()") && page.includes("db.space.count()") &&
  /label: "Users",\s*value: totalUsers/.test(page) && /label: "Spaces",\s*value: totalSpaces/.test(page) &&
  !/value:\s*users\.length/.test(page) && !/value:\s*spaces\.length/.test(page));

for (const [rel, model] of [["app/api/admin/users/route.ts", "user"], ["app/api/admin/spaces/route.ts", "space"]] as const) {
  const r = routeCode(rel);
  check(`${rel}: findMany is bounded (take: ADMIN_LIST_MAX + 1)`,
    new RegExp(`db\\.${model}\\.findMany\\(\\{[\\s\\S]{0,120}take:\\s*ADMIN_LIST_MAX \\+ 1`).test(r));
  check(`${rel}: ADMIN_LIST_MAX is a fixed constant ≤ 500`, (() => { const m = /const ADMIN_LIST_MAX = (\d+);/.exec(r); return !!m && Number(m[1]) <= 500; })());
  check(`${rel}: the response reports truncation`, /truncated/.test(r.slice(r.indexOf("NextResponse.json"))));
  check(`${rel}: no other unbounded ${model}.findMany`, (r.match(new RegExp(`db\\.${model}\\.findMany\\(`, "g")) ?? []).length === 1);
}
finish();
