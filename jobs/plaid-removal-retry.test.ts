/**
 * jobs/plaid-removal-retry.test.ts  (BETA C4)
 *
 * The scheduled retry of UNCONFIRMED Plaid removals: selection, bound, verdict
 * from the re-read, and the structural promise that it reuses the ONE removal
 * path and the ONE marker fold instead of growing a second of either.
 *
 *   npx tsx jobs/plaid-removal-retry.test.ts
 *
 * House pattern: standalone tsx, no DB, no Plaid. The job is driven through
 * its `{ status, disconnect, limit }` seam; the source scans pin the reuse.
 */

import { readFileSync } from "node:fs";
import { retryPlaidRemovals, selectRetryCandidates, PLAID_REMOVAL_RETRY_LIMIT } from "./plaid-removal-retry";
import type { ProviderCleanupItem, ProviderCleanupStatus } from "@/lib/platform/plaid/provider-cleanup";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const owedItem = (id: string, over: Partial<ProviderCleanupItem> = {}): ProviderCleanupItem => ({
  plaidItemId: id, institution: "Chase", ownerRef: "abc123", productStatus: "REVOKED", itemGone: false,
  owedSinceISO: "2026-10-01T00:00:00.000Z", owedForHours: 300, attemptCount: 1,
  lastAttemptAtISO: "2026-10-01T00:00:00.000Z", latestErrorCode: "INTERNAL_SERVER_ERROR", ...over,
});
const status = (owed: ProviderCleanupItem[]): ProviderCleanupStatus => ({
  owed, owedCount: owed.length, oldestOwedSinceISO: owed[0]?.owedSinceISO ?? null,
  oldestOwedForHours: owed[0]?.owedForHours ?? null, confirmedCount: 0, markersRead: owed.length,
});

/** A fake world: the owed set, and which ids a disconnect will CONFIRM (the rest stay owed). */
function world(owed: ProviderCleanupItem[], confirms: Set<string>, throws: Set<string> = new Set()) {
  let current = owed;
  const calls: string[] = [];
  let reads = 0;
  return {
    calls, reads: () => reads,
    status: async () => { reads++; return status(current); },
    disconnect: async (id: string) => {
      calls.push(id);
      if (throws.has(id)) throw new Error("decrypt failed");
      // The canonical path writes a marker; CONFIRMED removes the item from the owed fold.
      if (confirms.has(id)) current = current.filter((o) => o.plaidItemId !== id);
    },
  };
}

async function main(): Promise<void> {
  console.log("\n1. selection — owed, REVOKED, present, oldest first, bounded");
  {
    const s = status([
      owedItem("old", { owedSinceISO: "2026-09-01T00:00:00.000Z" }),
      owedItem("relinked", { productStatus: "ACTIVE" }),
      owedItem("gone", { itemGone: true, productStatus: null }),
      owedItem("new"),
      owedItem("newer"),
    ]);
    const { candidates, skipped } = selectRetryCandidates(s, 2);
    check("takes the oldest two REVOKED, present items", candidates.join(",") === "old,new", candidates.join(","));
    check("a relinked (ACTIVE) owed item is never revoked by a background job", skipped.notRevoked === 1);
    check("a marker whose item is gone has nothing to revoke", skipped.itemGone === 1);
    check("the bound is reported, not silent", skipped.overLimit === 1);
    check("the default bound is 50", PLAID_REMOVAL_RETRY_LIMIT === 50 && selectRetryCandidates(s).candidates.length === 3);
    check("a zero or negative limit attempts nothing", selectRetryCandidates(s, 0).candidates.length === 0 && selectRetryCandidates(s, -3).candidates.length === 0);
  }

  console.log("\n2. nothing owed — no provider call, one read, honest zeros");
  {
    const w = world([], new Set());
    const r = await retryPlaidRemovals({ status: w.status, disconnect: w.disconnect });
    check("attempted 0 / confirmed 0 / stillUnconfirmed 0", r.attempted === 0 && r.confirmed === 0 && r.stillUnconfirmed === 0);
    check("no disconnect was called", w.calls.length === 0);
    check("no second read when nothing was attempted", w.reads() === 1);
    check("owedBefore 0 and the limit travel with the summary", r.owedBefore === 0 && r.limit === 50);
  }

  console.log("\n3. the verdict is the RE-READ, not the action's return");
  {
    const w = world([owedItem("a"), owedItem("b"), owedItem("c")], new Set(["a", "c"]), new Set(["b"]));
    const r = await retryPlaidRemovals({ status: w.status, disconnect: w.disconnect });
    check("every eligible item was attempted, in order", w.calls.join(",") === "a,b,c", w.calls.join(","));
    check("confirmed = those the fold no longer lists", r.confirmed === 2, `${r.confirmed}`);
    check("a throw leaves the obligation standing and does not stop the run", r.stillUnconfirmed === 1 && w.calls.includes("c"));
    check("attempted = confirmed + stillUnconfirmed", r.attempted === r.confirmed + r.stillUnconfirmed);
    check("the state was re-read after the attempts", w.reads() === 2);
    check("owedBefore reports the population before the run", r.owedBefore === 3);
  }

  console.log("\n4. the bound holds under a backlog");
  {
    const many = Array.from({ length: 70 }, (_, i) => owedItem(`i${i}`));
    const w = world(many, new Set(many.map((o) => o.plaidItemId)));
    const r = await retryPlaidRemovals({ status: w.status, disconnect: w.disconnect });
    check("at most 50 attempts per run", r.attempted === 50 && w.calls.length === 50);
    check("the 20 left over are reported as overLimit", r.skipped.overLimit === 20);
    const bounded = await retryPlaidRemovals({ status: world(many, new Set()).status, disconnect: async () => {}, limit: 5 });
    check("an injected limit is honoured", bounded.attempted === 5 && bounded.skipped.overLimit === 65);
  }

  console.log("\n5. the summary carries counts only — no ids, institutions or owner refs");
  {
    const w = world([owedItem("secret-item-id", { institution: "Amex", ownerRef: "zz9999" })], new Set());
    const r = await retryPlaidRemovals({ status: w.status, disconnect: w.disconnect });
    const json = JSON.stringify(r);
    check("no item id, institution or owner ref in the JobRun summary", !/secret-item-id|Amex|zz9999/.test(json), json);
    check("the summary is JSON-safe (what runJob writes)", JSON.parse(json).attempted === 1);
  }

  console.log("\n6. [source] one removal path, one fold, no operator envelope, registered daily");
  {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
    const JOB = strip(readFileSync("jobs/plaid-removal-retry.ts", "utf8"));
    check("the job calls disconnectPlaidItemIfOrphaned and never itemRemove",
      /disconnectPlaidItemIfOrphaned/.test(JOB) && !/itemRemove/.test(JOB));
    check("…and never a second classifier or a marker write of its own",
      !/classifyRevocationFailure|PLAID_ITEM_REVOCATION_(UN)?CONFIRMED|auditLog\.create/.test(JOB));
    check("the owed population comes from the provider-cleanup reader (one fold)",
      /getProviderCleanupStatus/.test(JOB) && !/metadata\.plaidItemId|groupByItem/.test(JOB));
    check("the job never reads status === REVOKED as cleanup proof",
      !/status\s*===\s*(?:PlaidItemStatus\.)?["']?REVOKED/.test(JOB.replace(/productStatus !== "REVOKED"/g, "")));
    check("no operator envelope — it is a job, not an operator", !/recordOperatorAction|operatorActorFrom/.test(JOB));
    check("holds no database client of its own (the reader and the disconnect path carry the authority)",
      !/from "@\/lib\/db"/.test(JOB));
    check("never touches a token or secret", !/encryptedToken|access_token|accessToken|decryptWithPurpose/.test(JOB));
    const CORE = readFileSync("lib/jobs/registry.core.ts", "utf8");
    const REG  = readFileSync("lib/jobs/registry.ts", "utf8");
    check("registered daily, fixed, at 07:30 UTC", /\{ name: "plaid-removal-retry", hourUTC: 7, minuteUTC: 30 \}/.test(CORE));
    check("the registry body is retryPlaidRemovals", /"plaid-removal-retry": async \(\) => \(await import\("@\/jobs\/plaid-removal-retry"\)\)\.retryPlaidRemovals\(\)/.test(REG));
    const READER = readFileSync("lib/platform/plaid/provider-cleanup.ts", "utf8");
    check("the operator reader reports the last attempt time, so retries are visible", /lastAttemptAtISO/.test(READER));
  }

  console.log(failures === 0 ? "\n✅ plaid-removal-retry: bounded, canonical, verdict from the re-read.\n" : `\n❌ ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
