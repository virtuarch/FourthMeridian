/**
 * lib/snapshots/regenerate-history.membership.test.ts
 *
 * §9 membership guard, PER REVOKED LINK (2026-10-30). Standalone tsx script:
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/regenerate-history.membership.test.ts
 *
 * The guard used to be Space-wide and date-only: ONE revocation blocked every
 * earlier day for every account. Measured on Preview: a manual asset linked,
 * first valued and revoked on 2026-10-28 blocked all 365 prior days. The guard
 * now blocks a day only when a revoked account COULD HAVE contributed to it.
 *
 * Two halves are tested:
 *   A. the pure decision (regenerate-history.core.ts) — windows + day verdicts;
 *   B. the I/O half (loadRevokedLinkWindows) against an in-memory fake client —
 *      the real link model, batching (no N+1) and every fail-closed path.
 */

import {
  regenerateDay, revokedLinkContributionWindow, blockingRevokedLinks, membershipChangedOn,
  type DayRegenInput, type RevokedLinkFacts, type RevokedLinkWindow,
} from "./regenerate-history.core";
import { loadRevokedLinkWindows } from "./regenerate-history";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function days(fromISO: string, toExclusiveISO: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${fromISO}T00:00:00Z`); d.toISOString().slice(0, 10) < toExclusiveISO; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

type ManualEvidence = Extract<RevokedLinkFacts["evidence"], { kind: "MANUAL_REAL_ASSET" }>;
const manualFacts = (over: Partial<Omit<RevokedLinkFacts, "evidence">> & { evidence?: Partial<ManualEvidence> } = {}): RevokedLinkFacts => ({
  linkId: over.linkId ?? "L-car",
  financialAccountId: over.financialAccountId ?? "FA-car",
  linkCreatedISO: over.linkCreatedISO ?? "2026-10-28",
  revokedOnISO: over.revokedOnISO ?? "2026-10-28",
  evidence: {
    kind: "MANUAL_REAL_ASSET",
    firstAnchorISO: "2026-10-28",
    isLegacy: false,
    earliestTransactionISO: null,
    earliestValuationRowISO: "2026-10-28",
    acquisitionISO: null,
    accountCreatedISO: "2026-10-28",
    ...(over.evidence ?? {}),
  },
});

const unboundedFacts = (over: Partial<RevokedLinkFacts> = {}, why = "NO_ENGINE_FLOOR_FOR_CHECKING"): RevokedLinkFacts => ({
  linkId: "L-chk", financialAccountId: "FA-chk",
  linkCreatedISO: "2026-06-01", revokedOnISO: "2026-09-15",
  evidence: { kind: "UNBOUNDED", why },
  ...over,
});

const blockedSet = (windows: RevokedLinkWindow[], range: string[]) => range.filter((d) => membershipChangedOn(windows, d));

// A minimal day input — only the membership flag matters for the verdicts below.
const dayInput = (date: string, membershipChangedSince: boolean, over: Partial<DayRegenInput> = {}): DayRegenInput => ({
  date, existingIsEstimated: true,
  base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 100, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
  investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
  digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
  cashCardTier: "derived", membershipChangedSince,
  existing: { stocks: 0, crypto: 0, total: 0, cash: 90, savings: 0, debt: 0, netWorth: 90, totalAssets: 90, netLiquid: 90, cashOnHand: 90 },
  ...over,
});

// ── A. PURE DECISION ─────────────────────────────────────────────────────────

function testPure(): void {
  const year = days("2025-10-28", "2026-10-30");

  console.log("1. Revoked the same day it was created, first evidence that day (the Preview repro)");
  {
    const w = [revokedLinkContributionWindow(manualFacts())];
    check("window is the ledger floor [2026-10-28, 2026-10-28)", w[0].contributesFromISO === "2026-10-28" && w[0].revokedOnISO === "2026-10-28" && w[0].basis === "MANUAL_ASSET_LEDGER_FLOOR");
    check("all 365 earlier days are unblocked", blockedSet(w, days("2025-10-28", "2026-10-28")).length === 0);
    check("the revocation day itself is not blocked (unchanged truncation semantics)", !membershipChangedOn(w, "2026-10-28"));
    check("over the whole window nothing is blocked", blockedSet(w, year).length === 0);

    // Same account, but revoked the NEXT day: the evidence day is blocked until revokedAt.
    const later = [revokedLinkContributionWindow(manualFacts({ revokedOnISO: "2026-10-30" }))];
    check("revoked later ⇒ the evidence day is blocked", membershipChangedOn(later, "2026-10-28"));
    check("revoked later ⇒ the days up to revokedAt are blocked", membershipChangedOn(later, "2026-10-29"));
    check("revoked later ⇒ the revocation day is not", !membershipChangedOn(later, "2026-10-30"));
    check("revoked later ⇒ the day before the evidence is unblocked", !membershipChangedOn(later, "2026-10-27"));
    check("revoked later ⇒ exactly 2 days blocked in the year", blockedSet(later, year).length === 2, String(blockedSet(later, year)));
  }

  console.log("2. Revoked account with an earlier (backdated) valuation");
  {
    const w = [revokedLinkContributionWindow(manualFacts({
      linkCreatedISO: "2026-01-15", revokedOnISO: "2026-09-01",
      evidence: { firstAnchorISO: "2025-06-01", earliestValuationRowISO: "2025-06-01", accountCreatedISO: "2026-01-15" },
    }))];
    check("floor is the earliest valuation, not the link date", w[0].contributesFromISO === "2025-06-01");
    check("day before the valuation is unblocked", !membershipChangedOn(w, "2025-05-31"));
    check("the valuation day is blocked", membershipChangedOn(w, "2025-06-01"));
    check("a day mid-membership is blocked", membershipChangedOn(w, "2026-04-01"));
    check("the day before revokedAt is blocked", membershipChangedOn(w, "2026-08-31"));
    check("revokedAt day and later are unblocked", !membershipChangedOn(w, "2026-09-01") && !membershipChangedOn(w, "2026-10-29"));
    check("blocked count = [2025-06-01, 2026-09-01)", blockedSet(w, days("2025-01-01", "2026-10-30")).length === days("2025-06-01", "2026-09-01").length);

    // Fail-closed lower bound: the EARLIEST of every bound any writer could have used.
    const linkFirst = revokedLinkContributionWindow(manualFacts({
      linkCreatedISO: "2026-02-01", revokedOnISO: "2026-09-01",
      evidence: { firstAnchorISO: "2026-05-01", earliestValuationRowISO: "2026-05-01", accountCreatedISO: "2026-03-01" },
    }));
    check("link date earlier than the first anchor ⇒ floor is the link date (live rows)", linkFirst.contributesFromISO === "2026-02-01");
    const otherCurrency = revokedLinkContributionWindow(manualFacts({
      revokedOnISO: "2026-09-01",
      evidence: { firstAnchorISO: "2026-05-01", earliestValuationRowISO: "2026-01-10", accountCreatedISO: "2026-10-28" },
    }));
    check("an earlier valuation row the resolver dropped (currency) still lowers the floor", otherCurrency.contributesFromISO === "2026-01-10");
    const acq = revokedLinkContributionWindow(manualFacts({ revokedOnISO: "2026-09-01", evidence: { acquisitionISO: "2024-03-03" } }));
    check("acquisition date (possible purchase anchor) lowers the floor", acq.contributesFromISO === "2024-03-03");
    const tx = revokedLinkContributionWindow(manualFacts({ revokedOnISO: "2026-09-01", evidence: { earliestTransactionISO: "2025-12-12" } }));
    check("an earliest transaction lowers the floor", tx.contributesFromISO === "2025-12-12");
  }

  console.log("3. Revoked-then-restored (one link row per (space, account); restore flips status)");
  {
    // Revoked → restored → revoked again: the SAME row, createdAt = first link,
    // revokedAt = latest revocation, so the window covers every membership period.
    const w = [revokedLinkContributionWindow(manualFacts({
      linkCreatedISO: "2026-02-01", revokedOnISO: "2026-10-01",
      evidence: { firstAnchorISO: "2026-03-01", earliestValuationRowISO: "2026-03-01", accountCreatedISO: "2026-02-01" },
    }))];
    check("earlier membership period (before the first revocation) stays blocked", membershipChangedOn(w, "2026-04-15"));
    check("the gap while it was revoked is blocked too (conservative)", membershipChangedOn(w, "2026-06-15"));
    check("days before its first possible contribution are unblocked", !membershipChangedOn(w, "2026-01-31"));
    // Currently restored ⇒ the link is ACTIVE ⇒ no window (asserted on the loader below).
    check("no revoked links ⇒ nothing blocked", blockedSet([], days("2025-10-28", "2026-10-30")).length === 0);
  }

  console.log("4. Multi-member shared Space — each revocation blocks only its own range");
  {
    const alice = revokedLinkContributionWindow(manualFacts({
      linkId: "L-alice-boat", financialAccountId: "FA-boat", linkCreatedISO: "2026-01-01", revokedOnISO: "2026-03-01",
      evidence: { firstAnchorISO: "2026-01-10", earliestValuationRowISO: "2026-01-10", accountCreatedISO: "2026-01-01" },
    }));
    const bob = revokedLinkContributionWindow(manualFacts({
      linkId: "L-bob-art", financialAccountId: "FA-art", linkCreatedISO: "2026-06-01", revokedOnISO: "2026-07-01",
      evidence: { firstAnchorISO: "2026-06-05", earliestValuationRowISO: "2026-06-05", accountCreatedISO: "2026-06-01" },
    }));
    const w = [alice, bob];
    check("a day in Alice's range is blocked by Alice only",
      blockingRevokedLinks(w, "2026-02-01").map((x) => x.linkId).join() === "L-alice-boat");
    check("a day in Bob's range is blocked by Bob only",
      blockingRevokedLinks(w, "2026-06-10").map((x) => x.linkId).join() === "L-bob-art");
    check("a day between the two ranges is unblocked", !membershipChangedOn(w, "2026-04-15"));
    check("a day before both is unblocked", !membershipChangedOn(w, "2025-12-31"));
    check("blocked days = the union of the two ranges, nothing more",
      blockedSet(w, days("2025-10-28", "2026-10-30")).length === days("2026-01-01", "2026-03-01").length + days("2026-06-01", "2026-07-01").length);
  }

  console.log("5. Plaid-style reconstructed account revoked — unchanged behaviour");
  {
    const w = [revokedLinkContributionWindow(unboundedFacts())];
    check("no floor (walk-back reaches every day)", w[0].contributesFromISO === null && w[0].basis === "UNBOUNDED:NO_ENGINE_FLOOR_FOR_CHECKING");
    check("every earlier day blocked, back to the start of the window",
      blockedSet(w, days("2025-10-28", "2026-09-15")).length === days("2025-10-28", "2026-09-15").length);
    check("even a day before the link existed is blocked", membershipChangedOn(w, "2025-01-01"));
    check("revocation day and later unblocked", !membershipChangedOn(w, "2026-09-15") && !membershipChangedOn(w, "2026-10-29"));
    // Mixed with the Preview repro: the unbounded one dominates its own range only.
    const mixed = [w[0], revokedLinkContributionWindow(manualFacts())];
    check("a Plaid revocation still blocks the days the car would not", membershipChangedOn(mixed, "2026-01-01"));
  }

  console.log("6. Unknown / missing evidence fails closed");
  {
    const cases: [string, RevokedLinkFacts][] = [
      ["legacy (balance-only) manual asset", manualFacts({ revokedOnISO: "2026-10-28", evidence: { isLegacy: true } })],
      ["manual asset with no anchor", manualFacts({ evidence: { firstAnchorISO: null } })],
      ["malformed evidence date", manualFacts({ evidence: { acquisitionISO: "28/10/2026" } })],
      ["unreadable account", unboundedFacts({ revokedOnISO: "2026-10-28" }, "ACCOUNT_UNREADABLE")],
      ["crypto wallet (historical writers carried it across the window)", unboundedFacts({ revokedOnISO: "2026-10-28" }, "NO_ENGINE_FLOOR_FOR_CRYPTO")],
      ["investment account (holdConstantBeforeEarliest)", unboundedFacts({ revokedOnISO: "2026-10-28" }, "NO_ENGINE_FLOOR_FOR_INVESTMENT")],
    ];
    for (const [name, f] of cases) {
      const w = revokedLinkContributionWindow(f);
      check(`${name} ⇒ UNBOUNDED, blocks every earlier day`,
        w.contributesFromISO === null && w.basis.startsWith("UNBOUNDED:") && membershipChangedOn([w], "2020-01-01") && membershipChangedOn([w], "2026-10-27"),
        w.basis);
    }
  }

  console.log("7. The core verdict is unchanged; amendment still bypasses");
  {
    const w = [revokedLinkContributionWindow(unboundedFacts())];
    const r = regenerateDay(dayInput("2026-01-01", membershipChangedOn(w, "2026-01-01")));
    check("blocked day ⇒ skip-membership-changed, no fields", r.action === "skip-membership-changed" && r.fields === null);
    const free = regenerateDay(dayInput("2026-01-01", membershipChangedOn([revokedLinkContributionWindow(manualFacts())], "2026-01-01")));
    check("Preview-repro day ⇒ regenerates (not skip-membership-changed)", free.action === "write", free.action);
    const amend = regenerateDay(dayInput("2026-01-01", true, { isAmendment: true }));
    check("amendment on a blocked day still writes", amend.action === "write", amend.action);
  }
}

// ── B. THE I/O HALF, AGAINST A FAKE CLIENT ───────────────────────────────────

type Link = { id: string; spaceId: string; financialAccountId: string; status: "ACTIVE" | "REVOKED"; createdAt: Date; revokedAt: Date | null };
type Account = { id: string; type: string; syncStatus: string | null; currency: string; balance: number; lastUpdated: Date; createdAt: Date };
type Valuation = { id: string; financialAccountId: string; effectiveDate: Date; value: number; currency: string; recordedAt: Date };
type Tx = { financialAccountId: string; date: Date };

function fakeClient(state: { links: Link[]; accounts: Account[]; valuations?: Valuation[]; profiles?: { financialAccountId: string; acquisitionDate: Date | null }[]; txs?: Tx[] },
  fail: { accounts?: boolean; ledger?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const hit = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  const inIds = (where: { financialAccountId?: { in: string[] }; id?: { in: string[] } }, id: string) =>
    (where.financialAccountId?.in ?? where.id?.in ?? []).includes(id);
  const client = {
    spaceAccountLink: {
      findMany: async ({ where }: { where: { spaceId: string; status: string } }) => {
        hit("spaceAccountLink.findMany");
        return state.links.filter((l) => l.spaceId === where.spaceId && l.status === where.status && l.revokedAt !== null);
      },
    },
    financialAccount: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        hit("financialAccount.findMany");
        if (fail.accounts) throw new Error("boom");
        return state.accounts.filter((a) => where.id.in.includes(a.id));
      },
    },
    assetValuation: {
      findMany: async ({ where }: { where: { financialAccountId: { in: string[] } } }) => {
        hit("assetValuation.findMany");
        if (fail.ledger) throw new Error("ledger boom");
        return (state.valuations ?? []).filter((v) => inIds(where, v.financialAccountId))
          .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
      },
      groupBy: async ({ where }: { where: { financialAccountId: { in: string[] } } }) => {
        hit("assetValuation.groupBy");
        const by = new Map<string, Date>();
        for (const v of state.valuations ?? []) {
          if (!inIds(where, v.financialAccountId)) continue;
          const m = by.get(v.financialAccountId);
          if (!m || v.effectiveDate < m) by.set(v.financialAccountId, v.effectiveDate);
        }
        return [...by].map(([financialAccountId, d]) => ({ financialAccountId, _min: { effectiveDate: d } }));
      },
    },
    manualAssetProfile: {
      findMany: async ({ where }: { where: { financialAccountId: { in: string[] } } }) => {
        hit("manualAssetProfile.findMany");
        return (state.profiles ?? []).filter((p) => inIds(where, p.financialAccountId)).map((p) => ({
          ...p, purchasePrice: null, purchaseCurrency: null, purchasePriceIsStartingValue: false,
        }));
      },
    },
    transaction: {
      groupBy: async ({ where }: { where: { financialAccountId: { in: string[] } } }) => {
        hit("transaction.groupBy");
        const by = new Map<string, Date>();
        for (const t of state.txs ?? []) {
          if (!inIds(where, t.financialAccountId)) continue;
          const m = by.get(t.financialAccountId);
          if (!m || t.date < m) by.set(t.financialAccountId, t.date);
        }
        return [...by].map(([financialAccountId, d]) => ({ financialAccountId, _min: { date: d } }));
      },
    },
  };
  return { client: client as unknown as Parameters<typeof loadRevokedLinkWindows>[0], calls };
}

const T = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const TODAY = T("2026-10-30");
const acct = (id: string, type: string, syncStatus: string | null, createdISO: string): Account => ({
  id, type, syncStatus, currency: "USD", balance: 25_000, lastUpdated: T("2026-10-28T07:00:00Z"), createdAt: T(createdISO),
});
const val = (id: string, faId: string, effISO: string, currency = "USD"): Valuation => ({
  id, financialAccountId: faId, effectiveDate: T(effISO), value: 25_000, currency, recordedAt: T("2026-10-28T07:00:00Z"),
});

async function testLoader(): Promise<void> {
  console.log("8. Loader — the Preview repro, end to end");
  {
    const { client } = fakeClient({
      links: [{ id: "L-car", spaceId: "S", financialAccountId: "FA-car", status: "REVOKED", createdAt: T("2026-10-28T07:00:00Z"), revokedAt: T("2026-10-28T07:22:00Z") }],
      accounts: [acct("FA-car", "other", "manual", "2026-10-28T07:00:00Z")],
      valuations: [val("v1", "FA-car", "2026-10-28")],
      profiles: [{ financialAccountId: "FA-car", acquisitionDate: null }],
    });
    const w = await loadRevokedLinkWindows(client, "S", TODAY);
    check("one window, ledger-floored", w.length === 1 && w[0].basis === "MANUAL_ASSET_LEDGER_FLOOR", JSON.stringify(w));
    check("contributes from 2026-10-28, revoked on 2026-10-28", w[0].contributesFromISO === "2026-10-28" && w[0].revokedOnISO === "2026-10-28");
    check("the 365 days from 2025-10-28 are no longer blocked", blockedSet(w, days("2025-10-28", "2026-10-28")).length === 0);
  }

  console.log("9. Loader — real link model: restore flips the one row back to ACTIVE");
  {
    const restored: Link = { id: "L-car", spaceId: "S", financialAccountId: "FA-car", status: "ACTIVE", createdAt: T("2026-02-01"), revokedAt: null };
    const { client } = fakeClient({
      links: [restored, { id: "L-chk", spaceId: "S", financialAccountId: "FA-chk", status: "REVOKED", createdAt: T("2026-03-01"), revokedAt: T("2026-08-01T12:00:00Z") }],
      accounts: [acct("FA-car", "other", "manual", "2026-02-01"), acct("FA-chk", "checking", "synced", "2026-03-01")],
      valuations: [val("v1", "FA-car", "2026-02-01")],
    });
    const w = await loadRevokedLinkWindows(client, "S", TODAY);
    check("a restored (ACTIVE) link produces no window", !w.some((x) => x.linkId === "L-car"));
    check("a still-revoked link in the same Space keeps its window", w.length === 1 && w[0].linkId === "L-chk" && w[0].contributesFromISO === null);
    check("another Space's revoked links are never read", (await loadRevokedLinkWindows(client, "OTHER", TODAY)).length === 0);
  }

  console.log("10. Loader — batching (no N+1) across a mixed Space");
  {
    const links: Link[] = [];
    const accounts: Account[] = [];
    const valuations: Valuation[] = [];
    for (let i = 0; i < 6; i++) {
      links.push({ id: `L-m${i}`, spaceId: "S", financialAccountId: `FA-m${i}`, status: "REVOKED", createdAt: T("2026-05-01"), revokedAt: T("2026-07-01") });
      accounts.push(acct(`FA-m${i}`, "other", "manual", "2026-05-01"));
      valuations.push(val(`v${i}`, `FA-m${i}`, "2026-05-10"));
    }
    for (let i = 0; i < 4; i++) {
      links.push({ id: `L-p${i}`, spaceId: "S", financialAccountId: `FA-p${i}`, status: "REVOKED", createdAt: T("2026-05-01"), revokedAt: T("2026-07-01") });
      accounts.push(acct(`FA-p${i}`, i % 2 ? "debt" : "checking", "synced", "2026-05-01"));
    }
    const { client, calls } = fakeClient({ links, accounts, valuations });
    const w = await loadRevokedLinkWindows(client, "S", TODAY);
    check("10 windows for 10 revoked links", w.length === 10);
    check("every read issued exactly once", Object.values(calls).every((n) => n === 1), JSON.stringify(calls));
    check("6 ledger-floored, 4 unbounded",
      w.filter((x) => x.basis === "MANUAL_ASSET_LEDGER_FLOOR").length === 6 && w.filter((x) => x.contributesFromISO === null).length === 4);
    const plaidOnly = fakeClient({ links: links.filter((l) => l.id.startsWith("L-p")), accounts });
    await loadRevokedLinkWindows(plaidOnly.client, "S", TODAY);
    check("no manual asset ⇒ no ledger reads at all", plaidOnly.calls["assetValuation.findMany"] === undefined && plaidOnly.calls["transaction.groupBy"] === undefined);
  }

  console.log("11. Loader — fail closed on missing data or a failed read");
  {
    const base = {
      links: [{ id: "L-car", spaceId: "S", financialAccountId: "FA-car", status: "REVOKED" as const, createdAt: T("2026-10-28"), revokedAt: T("2026-10-29T07:22:00Z") }],
      accounts: [acct("FA-car", "other", "manual", "2026-10-28")],
      valuations: [val("v1", "FA-car", "2026-10-28")],
    };
    const blocksAll = (w: RevokedLinkWindow[]) => w.length === 1 && w[0].contributesFromISO === null && membershipChangedOn(w, "2025-11-01");

    const missing = await loadRevokedLinkWindows(fakeClient({ ...base, accounts: [] }).client, "S", TODAY);
    check("account not returned ⇒ UNBOUNDED:ACCOUNT_UNREADABLE", blocksAll(missing) && missing[0].basis === "UNBOUNDED:ACCOUNT_UNREADABLE", missing[0]?.basis);

    const acctFail = await loadRevokedLinkWindows(fakeClient(base, { accounts: true }).client, "S", TODAY);
    check("account read throws ⇒ UNBOUNDED (run not failed)", blocksAll(acctFail), acctFail[0]?.basis);

    const ledgerFail = await loadRevokedLinkWindows(fakeClient(base, { ledger: true }).client, "S", TODAY);
    check("ledger read throws ⇒ UNBOUNDED:MANUAL_ASSET_LEDGER_UNAVAILABLE", blocksAll(ledgerFail) && ledgerFail[0].basis === "UNBOUNDED:MANUAL_ASSET_LEDGER_UNAVAILABLE", ledgerFail[0]?.basis);

    const legacy = await loadRevokedLinkWindows(fakeClient({ ...base, valuations: [] }).client, "S", TODAY);
    check("no valuation rows and no profile (legacy balance-only) ⇒ UNBOUNDED", blocksAll(legacy) && legacy[0].basis === "UNBOUNDED:MANUAL_ASSET_LEGACY_NO_LEDGER", legacy[0]?.basis);

    const crypto = await loadRevokedLinkWindows(fakeClient({ ...base, accounts: [acct("FA-car", "crypto", "synced", "2026-10-28")] }).client, "S", TODAY);
    check("a crypto wallet ⇒ UNBOUNDED", blocksAll(crypto) && crypto[0].basis === "UNBOUNDED:NO_ENGINE_FLOOR_FOR_CRYPTO", crypto[0]?.basis);

    const currency = await loadRevokedLinkWindows(fakeClient({ ...base, valuations: [val("v0", "FA-car", "2026-01-05", "EUR"), val("v1", "FA-car", "2026-10-28")] }).client, "S", TODAY);
    check("an other-currency valuation the resolver drops still lowers the floor", currency[0]?.contributesFromISO === "2026-01-05", currency[0]?.contributesFromISO ?? "null");
  }
}

// The manual-asset floor includes ManualAssetProfile.acquisitionDate. That
// table is UPDATE/DELETE-able at the DB level, so the floor is only sound while
// no code mutates it: moving an acquisition date LATER would unblock days a
// past regen valued from the purchase price, and they would be rewritten
// without the asset. If you add an edit path, the guard must stop trusting it.
function testProfileImmutability(): void {
  const root = path.resolve(__dirname, "..", "..");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      const src = readFileSync(full, "utf8");
      if (/manualAssetProfile\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(src)
        || /(UPDATE|DELETE\s+FROM)\s+"?ManualAssetProfile"?/i.test(src)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  for (const d of ["app", "lib", "scripts"]) walk(path.join(root, d));
  check("no code mutates ManualAssetProfile (the acquisition-date floor depends on it)", offenders.length === 0, offenders.join(", "));
}

async function main(): Promise<void> {
  testPure();
  await testLoader();
  testProfileImmutability();
  if (failures > 0) { console.error(`\n✗ ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✓ all membership-guard checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
