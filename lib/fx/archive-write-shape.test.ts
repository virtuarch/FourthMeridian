/**
 * lib/fx/archive-write-shape.test.ts  (launch-readiness audit, 2026-10-06)
 *
 * The FX archive write runs DETACHED from the request that triggers it
 * (lib/money/server-context.ts). Prisma 5 sends createMany as BEGIN / INSERT /
 * COMMIT (measured), so a Fluid Compute instance suspended mid-write would leave
 * an open transaction holding the (date, base, quote) unique keys, and every
 * other instance's identical refresh would queue behind it on the shared `db`
 * pool. These checks pin the single-statement shape that cannot do that. The
 * behaviour (insert, idempotent re-fetch, existing rows never touched) was
 * verified against a real database when the shape changed; unit tests do not
 * import this module (see its header), so this is a source contract.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = readFileSync(path.join(process.cwd(), "lib/fx/archive.ts"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const writeBatch = /async writeBatch\([\s\S]*?\n  \},/.exec(code)?.[0] ?? "";

console.log("FX archive — the detached write is one autocommit statement");
check("writeBatch was found", writeBatch.length > 0);
check("no createMany (Prisma sends it as BEGIN / INSERT / COMMIT)", !/createMany/.test(writeBatch));
check("no interactive or batch transaction", !/\$transaction/.test(writeBatch));
check("exactly one $executeRaw INSERT", (writeBatch.match(/\$executeRaw`/g) ?? []).length === 1 && /INSERT INTO "FxRate"/.test(writeBatch));
check("idempotent on the (date, base, quote) anchor and never touches an existing row",
  /ON CONFLICT \("date", "base", "quote"\) DO NOTHING/.test(writeBatch) && !/DO UPDATE/.test(writeBatch));
check("values are bound parameters (Prisma.sql / Prisma.join), never string-built SQL",
  /Prisma\.sql`/.test(writeBatch) && /Prisma\.join\(/.test(writeBatch) && !/\$executeRawUnsafe|\$queryRawUnsafe/.test(code));
check("the closed-date guard still runs before the write",
  writeBatch.indexOf("assertClosedDateISO") > 0 && writeBatch.indexOf("assertClosedDateISO") < writeBatch.indexOf("$executeRaw"));
check("no UPDATE or DELETE of FxRate anywhere in the archive", !/UPDATE "FxRate"|DELETE FROM "FxRate"|fxRate\.(update|delete)/.test(code));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll FX archive write-shape checks passed.");
