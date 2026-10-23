/**
 * lib/snapshots/snapshot-population-disclosure.test.ts
 *
 * W1-D3 — snapshot-population disclosure tripwire (no DB; injected fake
 * client, house pattern per background-authority.test.ts Part 2).
 *
 * THE INVARIANT
 * -------------
 * Every SpaceAccountLink admitted to a Space's snapshot population must
 * satisfy the balance-disclosure predicate (grantsBalanceDisclosure,
 * lib/account-privacy.ts). readSpaceAccountsForSnapshot used to include EVERY
 * ACTIVE link regardless of visibility tier; the presentation layer
 * (normalizeSharedAccounts) fails closed on non-disclosing tiers
 * (SUMMARY_ONLY / PRIVATE / legacy SHARED / unknown), so if those tiers were
 * ever enabled, the shared-space snapshot would STRUCTURALLY leak the masked
 * amount into aggregates the member-facing views refuse to sum.
 *
 * Today every production link is FULL, so nothing leaks NOW and the guard is a
 * strict no-op — this test's job is to make any future amount-masking leak
 * fail LOUDLY (the read throws; it does not silently drop, because a silent
 * drop would change net worth without disclosure).
 *
 *   ./node_modules/.bin/tsx --require ./scripts/lib/server-only-preload.cjs \
 *       lib/snapshots/snapshot-population-disclosure.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { readSpaceAccountsForSnapshot } from "@/lib/snapshots/space-accounts";
import { grantsBalanceDisclosure } from "@/lib/account-privacy";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

/** In-memory fake honouring the SnapshotAccountsClient seam. */
function makeFake(
  links: Array<{ visibilityLevel: string; financialAccount: { id: string; type: string; balance: number; currency: string } }>,
) {
  return {
    spaceAccountLink: {
      async findMany() { return links; },
    },
  };
}

const acct = (id: string, balance = 100) =>
  ({ id, type: "checking", balance, currency: "USD" });

void (async () => {
  // ── 1. FULL links: the guard is a NO-OP — identical output, order kept ──────
  {
    const fake = makeFake([
      { visibilityLevel: "FULL", financialAccount: acct("fa-1", 1000) },
      { visibilityLevel: "FULL", financialAccount: acct("fa-2", -250) },
    ]);
    const out = await readSpaceAccountsForSnapshot("space-1", fake as never);
    check("FULL-only population passes through unchanged",
      JSON.stringify(out) === JSON.stringify([
        { id: "fa-1", type: "checking", balance: 1000, currency: "USD" },
        { id: "fa-2", type: "checking", balance: -250, currency: "USD" },
      ]));
  }

  // ── 2. BALANCE_ONLY grants balance disclosure — admitted, not thrown ────────
  {
    const fake = makeFake([
      { visibilityLevel: "FULL",         financialAccount: acct("fa-1") },
      { visibilityLevel: "BALANCE_ONLY", financialAccount: acct("fa-2") },
    ]);
    const out = await readSpaceAccountsForSnapshot("space-1", fake as never);
    check("BALANCE_ONLY link is admitted (its balance IS disclosed to the Space)",
      out.length === 2 && out[1].id === "fa-2");
  }

  // ── 3. THE TRIPWIRE — every non-disclosing tier throws LOUDLY ───────────────
  for (const tier of ["SUMMARY_ONLY", "PRIVATE", "SHARED", "SOME_FUTURE_TIER", ""]) {
    const fake = makeFake([
      { visibilityLevel: "FULL", financialAccount: acct("fa-ok") },
      { visibilityLevel: tier,   financialAccount: acct("fa-masked", 12345) },
    ]);
    let threw: unknown = null;
    try { await readSpaceAccountsForSnapshot("space-leak", fake as never); }
    catch (e) { threw = e; }
    check(`tier "${tier}" trips the guard (throws, never a silent sum)`, threw instanceof Error);
    check(`tier "${tier}" error names the offending link`,
      threw instanceof Error && threw.message.includes("fa-masked") && threw.message.includes("space-leak"),
      threw instanceof Error ? threw.message : String(threw));
  }

  // ── 4. Predicate parity: the read admits a tier IFF grantsBalanceDisclosure ─
  // If lib/account-privacy.ts and the snapshot guard ever diverge (a new tier
  // added to one but not the other), this fails on the exact tier.
  for (const tier of ["FULL", "BALANCE_ONLY", "SUMMARY_ONLY", "PRIVATE", "SHARED", "XYZ"]) {
    const fake = makeFake([{ visibilityLevel: tier, financialAccount: acct("fa-p") }]);
    let admitted = true;
    try { await readSpaceAccountsForSnapshot("space-p", fake as never); }
    catch { admitted = false; }
    check(`parity: "${tier}" admitted === grantsBalanceDisclosure("${tier}")`,
      admitted === grantsBalanceDisclosure(tier));
  }

  // ── 5. Source-scan drift guards ─────────────────────────────────────────────
  const ROOT = process.cwd();
  {
    const src = readFileSync(path.join(ROOT, "lib", "snapshots", "space-accounts.ts"), "utf8");
    check("guard uses THE canonical predicate (grantsBalanceDisclosure import)",
      src.includes('import { grantsBalanceDisclosure } from "@/lib/account-privacy"'));
    const guardAt  = src.indexOf("grantsBalanceDisclosure(l.visibilityLevel)");
    const returnAt = src.indexOf("return links.map");
    check("guard fires before the population is returned",
      guardAt !== -1 && returnAt !== -1 && guardAt < returnAt, `guard@${guardAt} return@${returnAt}`);
    check("query selects visibilityLevel (the guard has real data to check)",
      /visibilityLevel:\s*true/.test(src));
  }
  {
    // The guarded read must still be what the live snapshot writer consumes —
    // otherwise the tripwire guards a dead path.
    const src = readFileSync(path.join(ROOT, "lib", "snapshots", "regenerate.ts"), "utf8");
    check("regenerateSpaceSnapshot still populates via readSpaceAccountsForSnapshot",
      src.includes("readSpaceAccountsForSnapshot(spaceId, client)"));
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`\nsnapshot-population-disclosure: ${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`snapshot-population-disclosure: ${passed} checks passed`);
})();
