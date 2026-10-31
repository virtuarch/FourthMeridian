/**
 * lib/platform/policies/policy-group-migration.test.ts  (POLICY EDITOR — the migration, pinned)
 *
 * migration 20261030120000_policy_group_editor is ADDITIVE and least-privilege:
 *   · creates exactly two tables (PolicyGroup, PolicyGroupVersion) and touches no other table;
 *   · at most one default (partial unique index), (groupKey, version) unique, FK RESTRICT;
 *   · RLS enabled AND forced on both; fm_system policy only; fm_app / fm_auth get NOTHING;
 *     fm_system holds no DELETE on groups and no UPDATE / DELETE on versions (immutable);
 *   · the seed is the built-in Beta group, isDefault + builtIn, version 1 = the CODE values
 *     exactly (so day-one resolution is unchanged), idempotent (ON CONFLICT DO NOTHING);
 *   · the schema declares the same two models.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/policies/policy-group-migration.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const DIR = "20261030120000_policy_group_editor";
const raw = readFileSync(`prisma/migrations/${DIR}/migration.sql`, "utf8");
const sql = raw.replace(/^--.*$/gm, "");
const schema = readFileSync("prisma/schema.prisma", "utf8");

// Ordering, not "newest": later migrations (e.g. 20261031120000_policy_group_lifecycle) build on this one.
{
  const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort();
  check("the migration exists and sorts after 20261028120000", dirs.includes(DIR) && DIR > "20261028120000");
}
check("creates exactly PolicyGroup and PolicyGroupVersion", [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).join() === "PolicyGroup,PolicyGroupVersion");
const altered = [...sql.matchAll(/ALTER TABLE (?:public\.)?"?([\w%]+)"?/g)].map((m) => m[1]);
check("alters only its own two tables (no existing table touched)", altered.every((t) => t === "PolicyGroup" || t === "PolicyGroupVersion" || t === "%I"), altered);
check("no DROP, no DELETE, no UPDATE, no TRUNCATE", !/\b(DROP|DELETE FROM|UPDATE\s+"|TRUNCATE)\b/i.test(sql));
check("at most ONE default: a partial unique index on isDefault WHERE true",
  /CREATE UNIQUE INDEX "PolicyGroup_single_default" ON "PolicyGroup"\("isDefault"\) WHERE "isDefault" = true;/.test(sql));
check("(groupKey, version) unique", /CREATE UNIQUE INDEX "PolicyGroupVersion_groupKey_version_key" ON "PolicyGroupVersion"\("groupKey", "version"\);/.test(sql));
check("versions reference their group, RESTRICT (a group with history cannot vanish)", /REFERENCES "PolicyGroup"\("key"\) ON DELETE RESTRICT ON UPDATE RESTRICT/.test(sql));
check("RLS ENABLED and FORCED on both (loop over both tables)",
  /ARRAY\['PolicyGroup', 'PolicyGroupVersion'\]/.test(sql) && /ENABLE ROW LEVEL SECURITY/.test(sql) && /FORCE ROW LEVEL SECURITY/.test(sql));
check("the only policy is fm_system_all", (sql.match(/CREATE POLICY/g) ?? []).length === 1 && /CREATE POLICY fm_system_all ON public\.%I FOR ALL TO fm_system USING \(true\) WITH CHECK \(true\)/.test(sql));
check("fm_app and fm_auth: REVOKE ALL and no GRANT", /REVOKE ALL ON TABLE public\.%I FROM fm_app/.test(sql) && /REVOKE ALL ON TABLE public\.%I FROM fm_auth/.test(sql) && !/GRANT[^;]*TO fm_(app|auth)/.test(sql));
check("fm_system: SELECT, INSERT, UPDATE on groups (no DELETE)", /GRANT SELECT, INSERT, UPDATE ON TABLE public\."PolicyGroup" TO fm_system;/.test(sql) && !/GRANT[^;]*DELETE[^;]*fm_system/.test(sql));
check("fm_system: SELECT, INSERT only on versions (immutable at the database)", /GRANT SELECT, INSERT ON TABLE public\."PolicyGroupVersion" TO fm_system;/.test(sql));
check("fm_backup can dump both", /GRANT SELECT ON TABLE public\.%I TO fm_backup/.test(sql));

// The seed.
const unq = (s: string) => s.replace(/''/g, "'");
const groupSeed = sql.match(/INSERT INTO "PolicyGroup"[\s\S]*?VALUES \(\s*'([^']+)',\s*'([^']+)',\s*'((?:[^']|'')+)',\s*(true|false), (true|false), NULL, (\d+), NULL,[\s\S]*?ON CONFLICT \("key"\) DO NOTHING;/);
check("seeds ONE group, idempotently", (sql.match(/INSERT INTO "PolicyGroup"\s/g) ?? []).length === 1 && groupSeed !== null);
if (groupSeed) {
  check("…the built-in Beta: key, label and description exactly the code's", groupSeed[1] === DEFAULT_POLICY_GROUP && groupSeed[2] === BETA_FULL_ACCESS_V1.label && unq(groupSeed[3]) === BETA_FULL_ACCESS_V1.description);
  check("…isDefault true, builtIn true, currentVersion 1", groupSeed[4] === "true" && groupSeed[5] === "true" && groupSeed[6] === "1");
}
const versionSeed = sql.match(/INSERT INTO "PolicyGroupVersion"[\s\S]*?'BETA_FULL_ACCESS_V1',\s*1,\s*'(\{[^']+\})'::jsonb,\s*'([^']+)',[\s\S]*?ON CONFLICT \("groupKey", "version"\) DO NOTHING;/);
check("seeds version 1, idempotently", versionSeed !== null);
if (versionSeed) {
  const values = JSON.parse(versionSeed[1]);
  check("…version 1 values = BETA_FULL_ACCESS_V1.values EXACTLY (day-one resolution unchanged)", JSON.stringify(values) === JSON.stringify(BETA_FULL_ACCESS_V1.values), values);
  check("…label = the code label", versionSeed[2] === BETA_FULL_ACCESS_V1.label);
}
check("no Free / Paid / Pro group is seeded and no assignment is written", !/\b(FREE|PAID|PRO)_/i.test(sql) && !/CustomerPolicyAssignment/.test(sql));

// The schema.
const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf("\n}\n", schema.indexOf(`model ${name} {`)));
check("schema: PolicyGroup keyed by `key`, with isDefault / builtIn / archivedAt / currentVersion",
  /key\s+String\s+@id/.test(model("PolicyGroup")) && ["isDefault", "builtIn", "archivedAt", "currentVersion", "createdById"].every((f) => new RegExp(`\\b${f}\\b`).test(model("PolicyGroup"))));
check("schema: PolicyGroupVersion @@unique([groupKey, version]), Restrict, full values Json",
  /@@unique\(\[groupKey, version\]\)/.test(model("PolicyGroupVersion")) && /onDelete: Restrict/.test(model("PolicyGroupVersion")) && /values\s+Json/.test(model("PolicyGroupVersion")));

if (failures > 0) { console.error(`\npolicy-group-migration: ${failures} check(s) failed.`); process.exit(1); }
console.log("\npolicy-group-migration: all checks passed.");
