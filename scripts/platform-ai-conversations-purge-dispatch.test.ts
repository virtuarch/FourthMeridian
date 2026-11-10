/**
 * scripts/platform-ai-conversations-purge-dispatch.test.ts  (S2 REQUIRED 2 on #424)
 *
 * The manual purge dispatch's gate, pure, plus one spawn proving a refusal exits
 * 2 before any database contact. No database and no network: every URL is
 * synthetic and only parsed.
 *
 *   npx tsx scripts/platform-ai-conversations-purge-dispatch.test.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decidePurgeDispatch } from "./lib/platform-ai-conversations-purge-dispatch.core";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const PROD_REF = "prodprojectref0000001";
const PREV_REF = "previewprojectref0002";
const SECRET = "s3cr3tPassw0rd";
const direct = (ref: string) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
const pooler = (ref: string, role = "fm_system") => `postgresql://${role}.${ref}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const local = (role = "fm") => `postgresql://${role}:${SECRET}@localhost:5432/fintracker`;
const E = (over: Record<string, string | undefined>) => ({ FM_PRODUCTION_DB_REF: PROD_REF, ...over }) as unknown as NodeJS.ProcessEnv;

console.log("\nplatform-ai-conversations purge dispatch — the gate\n");

const ok = (d: ReturnType<typeof decidePurgeDispatch>) => d.ok;
check("--env=local on a loopback target ⇒ allowed", ok(decidePurgeDispatch(["--env=local"], E({ DATABASE_URL: local() }))));
check("--env=preview on a Supabase target that is NOT the Production ref ⇒ allowed",
  ok(decidePurgeDispatch(["--env=preview"], E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PREV_REF), DATABASE_URL_SYSTEM: pooler(PREV_REF) }))));
check("--env=production ⇒ ALWAYS refused (Production runs the cron), even pointed at the Production ref",
  !ok(decidePurgeDispatch(["--env=production"], E({ DATABASE_URL: direct(PROD_REF) }))));
check("--env=preview pointed at the PRODUCTION ref ⇒ refused",
  !ok(decidePurgeDispatch(["--env=preview"], E({ DATABASE_URL: direct(PROD_REF) }))));
check("--env=preview with FM_PRODUCTION_DB_REF unset ⇒ refused (cannot prove non-Production)",
  !ok(decidePurgeDispatch(["--env=preview"], E({ FM_PRODUCTION_DB_REF: undefined, DATABASE_URL: direct(PREV_REF) }))));
check("--env=local on a remote target ⇒ refused", !ok(decidePurgeDispatch(["--env=local"], E({ DATABASE_URL: direct(PREV_REF) }))));
check("no --env ⇒ refused", !ok(decidePurgeDispatch([], E({ DATABASE_URL: local() }))));
check("two --env flags ⇒ refused", !ok(decidePurgeDispatch(["--env=local", "--env=preview"], E({ DATABASE_URL: local() }))));
check("an unknown flag ⇒ refused", !ok(decidePurgeDispatch(["--env=local", "--force"], E({ DATABASE_URL: local() }))));
check("VERCEL_ENV=production ⇒ refused", !ok(decidePurgeDispatch(["--env=local"], E({ DATABASE_URL: local(), VERCEL_ENV: "production" }))));
check("DATABASE_URL_SYSTEM on ANOTHER project than DATABASE_URL ⇒ refused (never check one target and purge another)",
  !ok(decidePurgeDispatch(["--env=preview"], E({ DATABASE_URL: direct(PREV_REF), DATABASE_URL_SYSTEM: pooler(PROD_REF) }))));
check("DATABASE_URL and DIRECT_URL on different databases ⇒ refused",
  !ok(decidePurgeDispatch(["--env=preview"], E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PROD_REF) }))));
const refusals = [
  decidePurgeDispatch(["--env=preview"], E({ DATABASE_URL: direct(PROD_REF) })),
  decidePurgeDispatch(["--env=preview"], E({ DATABASE_URL: direct(PREV_REF), DATABASE_URL_SYSTEM: pooler(PROD_REF) })),
  decidePurgeDispatch(["--env=production"], E({ DATABASE_URL: direct(PROD_REF) })),
];
const text = JSON.stringify(refusals);
check("refusals name the rule, never a secret, ref, host or URL",
  !text.includes(SECRET) && !text.includes(PROD_REF) && !text.includes(PREV_REF) && !text.includes("supabase.co") && !text.includes("postgresql://"), text);

// One spawn: a refused dispatch exits 2 and never loads lib/db (no contact).
const ROOT = process.cwd();
const r = spawnSync(process.execPath, [...process.execArgv, path.join(ROOT, "scripts/platform-ai-conversations-purge-dispatch.ts"), "--env=production"], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF, DATABASE_URL_SYSTEM: "" },
});
check("the script refuses --env=production with exit 2 and 'nothing was contacted'", r.status === 2 && /REFUSED — nothing was contacted/.test(r.stderr), { status: r.status, err: r.stderr.slice(0, 300) });

// Source pins: the gate runs before any database module is imported; the job's own seam is reused.
const src = readFileSync(path.join(ROOT, "scripts/platform-ai-conversations-purge-dispatch.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
check("the script statically imports no database module (lib/db / jobs only after the gate)",
  !/^import[^\n]*(@\/lib\/db|jobs\/data-retention|conversations\/purge)/m.test(src) && src.indexOf("decidePurgeDispatch(") < src.indexOf('import("@/lib/db")'));
check("the script reuses the job's seam (platformAiPurgeDeps(\"MANUAL_DISPATCH\")) and the job's rule (runPlatformAiConversationPurge)",
  /platformAiPurgeDeps\("MANUAL_DISPATCH"\)/.test(src) && /runPlatformAiConversationPurge\(/.test(src) && !/\$queryRaw|\$executeRaw|deleteMany/.test(src));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
