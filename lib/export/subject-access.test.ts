/** PRIV-006 — the data export carries the user's AI memory and Daily Briefs, scoped to rows they own. */
import { readFileSync } from "node:fs";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const s = readFileSync("lib/export/assemble.ts", "utf8");
check("AI memory is read inside the tenant transaction, owner-scoped", /tx\.spaceMemory\.findMany\(\{\s*where:\s*\{ ownerUserId: userId \}/.test(s));
check("Daily Briefs are read owner-scoped, generated content only", /tx\.dailyBrief\.findMany\(\{\s*where:\s*\{ ownerUserId: userId, content: \{ not: Prisma\.AnyNull \} \}/.test(s));
check("both reach the export data and its counts", /aiMemory: aiMemory\.map\(/.test(s) && /dailyBriefs: dailyBriefs\.map\(/.test(s) && /aiMemory: data\.aiMemory\.length/.test(s) && /dailyBriefs: data\.dailyBriefs\.length/.test(s));
check("no generation internals leave (watermark, digest, prompt version, failure reason)", !/sourceWatermark: true|materialDigest: true|promptVersion: true|lastFailureReason: true/.test(s));
if (f) process.exit(1);
console.log("\nall checks passed");
