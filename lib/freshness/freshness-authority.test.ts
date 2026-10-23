/**
 * lib/freshness/freshness-authority.test.ts   (v2.6-L1)
 *
 * Behavioural probes for the freshness authority. Pure, no DB, standalone tsx.
 *
 * These encode the acceptance cases from the v2.6 brief plus the standing
 * invariants. The load-bearing ones:
 *
 *   • a Space's freshness is NEVER the newest account (the defect this replaces);
 *   • no Space-level claim hides stale material value;
 *   • unknown provider freshness stays unknown — never a number, never a band;
 *   • the provider clock and our ingestion clock are never conflated.
 */

import {
  resolveAccountFreshness,
  balanceClaimLabel,
  accountBalanceClaimLabel,
  balanceBasisCaveat,
  describeLedgerCoverage,
  bandForAge,
  isStaleBand,
  STALE_AFTER_DAYS,
} from "./observation";
import { resolveSpaceFreshness, summarizeSpaceFreshness } from "./space-freshness";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

// ── Per-account: the two clocks ───────────────────────────────────────────────

console.log("Per-account — the provider clock and our clock are different facts");
{
  // Missing balanceLastUpdatedAt (today: every account in the corpus).
  const f = resolveAccountFreshness(
    { accountId: "a", ingestedAt: daysAgo(1), providerBalanceAt: null },
    NOW,
  );
  check("no provider timestamp ⇒ basis INGESTION", f.balance.basis === "INGESTION");
  check("no provider timestamp ⇒ providerClockUnknown", f.balance.providerClockUnknown === true);
  check("ingestion time is NOT copied into providerAttestedAt", f.balance.providerAttestedAt === null);
  check("the ingestion instant is still carried separately", f.balance.ingestedAt === daysAgo(1));
  check("label claims only our clock", accountBalanceClaimLabel(f.balance.basis) === "Balance checked");
  check("a caveat is emitted, not silence", (balanceBasisCaveat(f.balance) ?? "").includes("may be older"));

  // Provider timestamp available.
  const g = resolveAccountFreshness(
    { accountId: "b", ingestedAt: daysAgo(1), providerBalanceAt: daysAgo(3) },
    NOW,
  );
  check("provider timestamp present ⇒ basis PROVIDER_ATTESTED", g.balance.basis === "PROVIDER_ATTESTED");
  check("the reported instant is the PROVIDER's, not ours", g.balance.observedAt === daysAgo(3));
  check("the provider's older truth is not flattered by our newer write",
    Math.round(g.balance.ageDays!) === 3);
  check("attested label earns 'as of'", accountBalanceClaimLabel(g.balance.basis) === "Balance as of");
  check("no caveat needed when the provider attested", balanceBasisCaveat(g.balance) === null);

  // No evidence at all.
  const h = resolveAccountFreshness({ accountId: "c", ingestedAt: null }, NOW);
  check("no evidence ⇒ UNOBSERVED", h.balance.basis === "UNOBSERVED");
  check("unknown age is null, NOT 0 and NOT a large number", h.balance.ageDays === null);
  check("unknown band is UNKNOWN", h.balance.band === "UNKNOWN");
  check("UNKNOWN is not laundered into 'stale'", isStaleBand("UNKNOWN") === false);
}

console.log("Per-account — the clocks disagreeing is reported, never smoothed");
{
  // Provider claims it computed the balance AFTER we fetched it.
  const f = resolveAccountFreshness(
    { accountId: "a", ingestedAt: daysAgo(5), providerBalanceAt: daysAgo(1) },
    NOW,
  );
  check("provider-after-ingestion is flagged contradictory", f.balance.contradictory === true);
  check("the OLDER instant is reported, never the flattering one", f.balance.observedAt === daysAgo(5));
  check("contradiction produces its own caveat",
    (balanceBasisCaveat(f.balance) ?? "").includes("disagree"));

  // Inside tolerance: ordinary clock skew, not a disagreement.
  const skew = new Date(NOW.getTime() - 86_400_000 + 10 * 60_000).toISOString();
  const g = resolveAccountFreshness(
    { accountId: "b", ingestedAt: daysAgo(1), providerBalanceAt: skew },
    NOW,
  );
  check("10 minutes of skew is not a contradiction", g.balance.contradictory === false);
}

console.log("Per-account — ledger coverage is a SEPARATE fact from balance age");
{
  // The live Cold Wallet BTC shape: balance fetched hours ago, ledger stops in 2023.
  const w = resolveAccountFreshness(
    { accountId: "w", ingestedAt: daysAgo(0.7), ledgerThroughDate: "2023-09-25", ledgerQueried: true },
    NOW,
  );
  check("a live balance over an ancient ledger stays LIVE on the balance band",
    w.balance.band === "LIVE");
  check("...while coverage reports the ledger's real reach",
    w.ledger.kind === "OBSERVED" && w.ledger.throughDate === "2023-09-25");
  check("coverage wording never says 'stale'",
    !describeLedgerCoverage(w.ledger).toLowerCase().includes("stale"));

  // Investment account: we looked, we hold nothing.
  const inv = resolveAccountFreshness(
    { accountId: "i", ingestedAt: daysAgo(1), ledgerThroughDate: null, ledgerQueried: true },
    NOW,
  );
  check("queried + no rows ⇒ NONE_ON_FILE", inv.ledger.kind === "NONE_ON_FILE");

  // Nobody looked.
  const un = resolveAccountFreshness({ accountId: "u", ingestedAt: daysAgo(1) }, NOW);
  check("not queried ⇒ UNKNOWN, never NONE_ON_FILE", un.ledger.kind === "UNKNOWN");
  check("'we did not look' is worded as such",
    describeLedgerCoverage(un.ledger).includes("not evaluated"));
}

console.log("Bands");
{
  check("<1d ⇒ LIVE", bandForAge(0.5) === "LIVE");
  check("1–7d ⇒ RECENT", bandForAge(3) === "RECENT");
  check("7–30d ⇒ STALE", bandForAge(8) === "STALE");
  check(">30d ⇒ VERY_STALE", bandForAge(56) === "VERY_STALE");
  check("null ⇒ UNKNOWN", bandForAge(null) === "UNKNOWN");
  check(`the stale cut is ${STALE_AFTER_DAYS} days`, bandForAge(STALE_AFTER_DAYS) === "STALE");
}

// ── Space level: the defect this slice exists to remove ───────────────────────

console.log("Space — the claim is NEVER the newest account");
{
  // One fresh account, many stale — the exact shape that produced "Updated 16 hr
  // ago" over eight-week-old balances.
  const s = resolveSpaceFreshness(
    [
      { accountId: "fresh", ingestedAt: daysAgo(0.7), balance: 100 },
      { accountId: "s1", ingestedAt: daysAgo(56), balance: 300_000 },
      { accountId: "s2", ingestedAt: daysAgo(40), balance: 200_000 },
    ],
    NOW,
  );
  check("the anchor is the OLDEST observation", s.anchor.accountId === "s1");
  check("the anchor is NOT the newest", s.anchor.observedAt !== s.newestObservedAt);
  check("the newest is still reported — as a fact, not as the claim",
    s.newestObservedAt === daysAgo(0.7));
  check("claim escalates to STALE", s.claim === "STALE");
  check("the qualifier counts the stale accounts",
    (s.qualifier ?? "").includes("2 of 3 accounts older than 7 days"));
  check("the qualifier reports the VALUE share, which is the real finding",
    (s.qualifier ?? "").includes("100% of value unverified"));
  check("value weighting: nearly all value is behind stale balances",
    s.staleValueShare !== null && s.staleValueShare > 0.999);
  check("the label claims only our clock", s.label === "Last checked");
}

console.log("Space — a stale HIGH-value account is not hidden by a fresh low-value one");
{
  const s = resolveSpaceFreshness(
    [
      { accountId: "small-fresh", ingestedAt: daysAgo(0.1), balance: 50 },
      { accountId: "big-stale", ingestedAt: daysAgo(30), balance: 900_000 },
    ],
    NOW,
  );
  check("anchor = the stale high-value account", s.anchor.accountId === "big-stale");
  check("oldestMaterial names the account that actually matters",
    s.oldestMaterial?.accountId === "big-stale");
  check("the anchor is never NEWER than the oldest material account",
    s.anchor.ageDays !== null && s.oldestMaterial?.ageDays !== null &&
    s.anchor.ageDays >= (s.oldestMaterial!.ageDays as number) - 1e-9);
  check("the trivial fresh row does not become 'material'",
    s.oldestMaterial?.accountId !== "small-fresh");
}

console.log("Space — uniform, partial, and unknown");
{
  const uniform = resolveSpaceFreshness(
    [
      { accountId: "a", ingestedAt: daysAgo(0.2), balance: 10 },
      { accountId: "b", ingestedAt: daysAgo(0.3), balance: 10 },
    ],
    NOW,
  );
  check("all fresh, tight spread ⇒ UNIFORM", uniform.claim === "UNIFORM");
  check("UNIFORM hides nothing, so there is no qualifier", uniform.qualifier === null);

  const partial = resolveSpaceFreshness(
    [
      { accountId: "a", ingestedAt: daysAgo(0.2), balance: 10 },
      { accountId: "b", ingestedAt: daysAgo(4), balance: 10 },
    ],
    NOW,
  );
  check("a multi-day spread with nothing stale ⇒ PARTIAL", partial.claim === "PARTIAL");
  check("the spread itself is disclosed",
    (partial.qualifier ?? "").includes("observations span"));

  const unknown = resolveSpaceFreshness(
    [{ accountId: "a", ingestedAt: null, balance: 10 }],
    NOW,
  );
  check("no observations ⇒ UNKNOWN", unknown.claim === "UNKNOWN");
  check("UNKNOWN renders no age at all", unknown.anchor.observedAt === null);
  check("UNKNOWN says so in words", unknown.label === "Freshness unknown");
  check("...and names how many accounts it covers",
    (unknown.qualifier ?? "").includes("1 account with no freshness evidence"));

  const empty = summarizeSpaceFreshness([]);
  check("an empty Space claims nothing", empty.claim === "UNKNOWN" && empty.qualifier === null);
}

console.log("Space — value with NO freshness evidence counts as unverified");
{
  const s = resolveSpaceFreshness(
    [
      { accountId: "known", ingestedAt: daysAgo(0.1), balance: 1_000 },
      { accountId: "blind", ingestedAt: null, balance: 9_000 },
    ],
    NOW,
  );
  check("an unobserved balance is counted as unverified value",
    Math.abs(s.staleValueShare! - 0.9) < 1e-9);
  check("it is reported as unknown, not as stale", s.claim === "PARTIAL" && s.staleAccountCount === 0);
  check("the qualifier names the missing evidence",
    (s.qualifier ?? "").includes("1 with no freshness evidence"));
}

console.log("Space — the aggregate is never more certain than its weakest member");
{
  const mixed = resolveSpaceFreshness(
    [
      { accountId: "attested", ingestedAt: daysAgo(1), providerBalanceAt: daysAgo(1), balance: 10 },
      { accountId: "ours-only", ingestedAt: daysAgo(1), providerBalanceAt: null, balance: 10 },
    ],
    NOW,
  );
  check("one un-attested account degrades the whole claim to INGESTION",
    mixed.anchor.basis === "INGESTION");
  check("...and the wording follows", mixed.label === "Last checked");

  const allAttested = resolveSpaceFreshness(
    [
      { accountId: "a", ingestedAt: daysAgo(1), providerBalanceAt: daysAgo(1), balance: 10 },
      { accountId: "b", ingestedAt: daysAgo(1), providerBalanceAt: daysAgo(2), balance: 10 },
    ],
    NOW,
  );
  check("every account attested ⇒ 'as of' is earned",
    allAttested.anchor.basis === "PROVIDER_ATTESTED" && allAttested.label === "Balances as of");
  check("space label mirrors the shared vocabulary",
    balanceClaimLabel("PROVIDER_ATTESTED") === "Balances as of");
}

console.log("Space — the live corpus shape (35 accounts, 2026-08-04)");
{
  // 11 accounts refreshed within ~a day; 24 seed accounts frozen 56 days back
  // holding $939,564 of $974,231.
  const inputs = [
    ...Array.from({ length: 11 }, (_, i) => ({
      accountId: `plaid-${i}`, ingestedAt: daysAgo(1.1), balance: 34_667 / 11,
    })),
    ...Array.from({ length: 24 }, (_, i) => ({
      accountId: `seed-${i}`, ingestedAt: daysAgo(56.3), balance: 939_564 / 24,
    })),
  ];
  const s = resolveSpaceFreshness(inputs, NOW);
  check("anchor lands on the 56-day cohort, not the 1-day one",
    s.anchor.ageDays !== null && s.anchor.ageDays > 56);
  check("24 of 35 stale is what it reports", s.staleAccountCount === 24);
  check("96% of value unverified is what it reports",
    (s.qualifier ?? "").includes("96% of value unverified"),
    s.qualifier ?? "(none)");
  // The defect, stated as an assertion: the OLD reducer would have claimed ~1.1d.
  const oldMaxClaim = Math.min(...inputs.map((i) => (NOW.getTime() - new Date(i.ingestedAt).getTime()) / 86_400_000));
  check("the new claim is ~55 days older than the MAX it replaces",
    s.anchor.ageDays! - oldMaxClaim > 54);
}

if (failures > 0) { console.error(`\nfreshness-authority: ${failures} failure(s).`); process.exit(1); }
console.log("\nfreshness-authority: all passed.");
