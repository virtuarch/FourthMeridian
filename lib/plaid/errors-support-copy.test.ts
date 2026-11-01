/**
 * lib/plaid/errors-support-copy.test.ts — "Contact support" names the address.
 *
 * A Plaid error that tells the user to contact support must say WHERE: the
 * published support mailbox (SUPPORT_EMAIL, the one the footer, Terms and Privacy
 * carry). A bare "Contact support." left a beta user with nowhere to go.
 *
 * Standalone tsx script: exits 0/1. No DB, no network.
 */

import { readFileSync } from "node:fs";
import { parsePlaidError } from "@/lib/plaid/errors";
import { SUPPORT_EMAIL } from "@/content/marketing/copy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ADDR = `Contact ${SUPPORT_EMAIL}.`;

const env = parsePlaidError({ response: { status: 400, data: { error_code: "INVALID_ENVIRONMENT" } } }, "x");
check("INVALID_ENVIRONMENT names the support address", env.message.endsWith(ADDR), env.message);

const enc = parsePlaidError(new Error("ENCRYPTION_KEY is not set"), "x");
check("encryption-key configuration error names the support address", enc.message.endsWith(ADDR) && enc.status === 500, enc.message);

const miss = parsePlaidError(new Error("Missing env var: PLAID_SECRET"), "x");
check("missing-env configuration error names the support address", miss.message.endsWith(ADDR) && miss.status === 500, miss.message);

const src = readFileSync("lib/plaid/errors.ts", "utf8");
check("no bare \"Contact support.\" remains in the Plaid error copy", !/Contact support\./.test(src));

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log("\nall passed");
