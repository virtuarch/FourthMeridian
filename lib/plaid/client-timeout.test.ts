/**
 * lib/plaid/client-timeout.test.ts  (OPS-004)
 *
 * The Plaid axios transport carries a timeout. The client is lazily built and
 * needs real credentials to instantiate, so the pin is a source scan plus the
 * exported constant — the same shape as the other transport-timeout pins.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/client-timeout.test.ts
 */

import { readFileSync } from "node:fs";
import { PLAID_TRANSPORT_TIMEOUT_MS } from "./client";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = readFileSync("lib/plaid/client.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("30 s transport timeout", PLAID_TRANSPORT_TIMEOUT_MS === 30_000);
check("baseOptions carries the timeout", /baseOptions:\s*\{[\s\S]*?timeout:\s*PLAID_TRANSPORT_TIMEOUT_MS/.test(src));
check("importing the client still has no side effect (lazy init preserved)", /let _realClient: PlaidApi \| null = null;/.test(src));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
