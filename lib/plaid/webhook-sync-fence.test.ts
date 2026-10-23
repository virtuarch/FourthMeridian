/** IDEMP-005 (remaining caller) — the webhook pipeline releases only a lease it still owns. */
import { readFileSync } from "node:fs";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const s = readFileSync("lib/plaid/webhook-sync.ts", "utf8");
check("claims through the token-returning claim", /const claimedAt = await claimPlaidItemSyncLockAt\(plaidItemId\);/.test(s) && !/claimPlaidItemSyncLock\(plaidItemId\)/.test(s));
check("an un-won claim skips (no token, no run)", /if \(!claimedAt\) \{/.test(s));
check("releases with the fencing token", /releasePlaidItemSyncLock\(plaidItemId, ok, undefined, claimedAt\)/.test(s));
if (f) process.exit(1);
console.log("\nall checks passed");
