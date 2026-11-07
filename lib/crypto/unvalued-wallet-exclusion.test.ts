/**
 * lib/crypto/unvalued-wallet-exclusion.test.ts   (FM-AUDIT-022)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/unvalued-wallet-exclusion.test.ts
 *
 * THE DEFECT: a crypto wallet with no price (NO_PRICE) or no on-chain
 * observation yet (NO_OBSERVATION) fell back to the stored `balance` column in
 * every totals path. A new wallet is created with that column's DEFAULT 0, so it
 * counted as $0 in net worth; a never-synced one carried an undated stored
 * figure. Nothing disclosed either.
 *
 * THE FIX, pinned here:
 *   - ONE classification (`resolveWalletBalance`) decides a wallet's totals
 *     contribution: VALUED/STALE → the spine value; NO_PRICE/NO_OBSERVATION →
 *     EXCLUDED (structural 0 flagged `valuationUnknown`), never the column.
 *   - `classifyAccounts` skips flagged rows in every sum and reports
 *     `unvaluedCount`; the Wealth envelope and the Accounts ledger disclose it.
 *   - A priced, observed wallet is byte-identical to before.
 *   - The today-snapshot read carries the flag, so the writer has the signal.
 *   - Static: no totals path substitutes a wallet balance outside the helper.
 *
 * All fixtures are synthetic.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  resolveWalletBalance,
  hasKnownValue,
  type WalletCurrentValue,
  type WalletValueState,
} from "./wallet-current-value";
import { classifyAccounts, unvaluedAccountCount, type ClassifiableAccount } from "@/lib/account-classifier";
import { resolvePerspectiveEnvelope, unvaluedWarning } from "@/lib/perspectives/envelope";
import { composeInvestments } from "@/lib/ai/economic-concepts";
import { readSpaceAccountsForSnapshot, type SnapshotAccountsClient } from "@/lib/snapshots/space-accounts";
import type { AccountsSectionData } from "@/lib/ai/types";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

function wallet(state: WalletValueState, value: number | null, quantity: number | null = null): WalletCurrentValue {
  return {
    accountId: "acct-w", chain: "SOL", assetKey: null, symbol: "SOL",
    quantity, value, state, asOf: "2026-01-02", priceDate: null, price: null,
    observedAt: null, freshness: "UNKNOWN", tokens: [],
  };
}

/** The pre-fix rule, reproduced verbatim, so "unchanged" is measured, not asserted. */
const legacyBalance = (column: number, v: WalletCurrentValue | undefined) =>
  hasKnownValue(v) ? v!.value! : column;

const CASH: ClassifiableAccount = { type: "checking", balance: 1000.1, currency: "USD" };
const SAVE: ClassifiableAccount = { type: "savings", balance: 250.25, currency: "USD" };
const BROK: ClassifiableAccount = { type: "investment", balance: 5000.33, currency: "USD" };
const CARD: ClassifiableAccount = { type: "debt", balance: 120.07, currency: "USD" };

const totals = (c: ReturnType<typeof classifyAccounts>) => JSON.stringify({
  totalChecking: c.totalChecking, totalSavings: c.totalSavings, totalLiquid: c.totalLiquid,
  totalRestrictedCash: c.totalRestrictedCash, totalInvestments: c.totalInvestments,
  totalDigitalAssets: c.totalDigitalAssets, totalRealAssets: c.totalRealAssets,
  totalLiabilities: c.totalLiabilities, totalAssets: c.totalAssets, netWorth: c.netWorth,
  estimated: c.estimated, unconverted: c.unconverted,
});

// ══ 1. NO_PRICE — excluded, count disclosed ═══════════════════════════════════
{
  // Held quantity known, worth unknown; the stored column carries a stale figure.
  const STALE_COLUMN = 777.77;
  const r = resolveWalletBalance(STALE_COLUMN, wallet("NO_PRICE", null, 3.5));
  check("NO_PRICE: the classification never returns the stored column", r.balance !== STALE_COLUMN);
  check("NO_PRICE: flagged valuationUnknown", r.valuationUnknown === true);

  const row: ClassifiableAccount = { type: "crypto", balance: r.balance, currency: "USD", ...(r.valuationUnknown ? { valuationUnknown: true } : {}) };
  const withWallet = classifyAccounts([CASH, BROK, row, CARD]);
  const without    = classifyAccounts([CASH, BROK, CARD]);
  check("NO_PRICE: totals equal the totals WITHOUT the wallet (excluded, not valued)",
    totals(withWallet) === totals(without), `${totals(withWallet)} vs ${totals(without)}`);
  check("NO_PRICE: the exclusion is counted", withWallet.unvaluedCount === 1);
  check("NO_PRICE: the wallet still sits in the digital-assets bucket (listed, not summed)",
    withWallet.digitalAssets.length === 1);

  // Defense in depth: even a flagged row that somehow carries a number is skipped.
  const poisoned = classifyAccounts([CASH, { type: "crypto", balance: STALE_COLUMN, currency: "USD", valuationUnknown: true }]);
  check("a flagged row is skipped even if a balance leaked onto it",
    poisoned.totalDigitalAssets === 0 && poisoned.netWorth === CASH.balance);
  // …on the FX path too.
  const ctxPath = classifyAccounts(
    [CASH, { type: "crypto", balance: STALE_COLUMN, currency: "USD", valuationUnknown: true }],
    { target: "USD", rates: new Map(), latestCloseISO: "2026-01-01" } as never,
  );
  check("…including under a ConversionContext", ctxPath.totalDigitalAssets === 0 && ctxPath.unvaluedCount === 1);

  // Disclosure: the Wealth envelope carries "N not yet valued".
  const env = resolvePerspectiveEnvelope({
    perspectiveId: "wealth",
    wealthResult: {
      completeness: { tier: "observed", label: "Observed", tone: "positive" },
      asOfState: { found: true, date: "2026-01-02", isEstimated: false },
      evidence: null, chart: { points: [] },
    } as never,
    currency: "USD",
    unvaluedCount: withWallet.unvaluedCount,
  });
  const w = env.warnings?.find((x) => x.kind === "unvalued");
  check("Wealth envelope discloses the exclusion", w !== undefined && w.label === "1 not yet valued", JSON.stringify(env.warnings));
  check("…and states the total is partial", /excluded from this total/.test(w?.detail ?? ""));
  check("unvaluedWarning(0) is empty (no caveat when nothing was excluded)", unvaluedWarning(0).length === 0);
  const none = resolvePerspectiveEnvelope({
    perspectiveId: "wealth",
    wealthResult: {
      completeness: { tier: "observed", label: "Observed", tone: "positive" },
      asOfState: { found: true, date: "2026-01-02", isEstimated: false },
      evidence: null, chart: { points: [] },
    } as never,
    currency: "USD",
  });
  check("Wealth envelope without an exclusion is byte-identical to before (no warnings key)",
    !("warnings" in none) || none.warnings === undefined);

  // Disclosure to the AI: digital assets is not assertable while a wallet is excluded.
  const acc = {
    redactedCount: 0, totalsUnconverted: false, totalsUnvaluedCount: 1,
    totalInvestments: BROK.balance, totalDigitalAssets: 0,
    counts: { liquid: 1, investments: 1, digitalAssets: 1, realAssets: 0, liabilities: 1 },
  } as unknown as AccountsSectionData;
  const inv = composeInvestments(acc);
  const digital = inv?.components.find((c) => c.key === "DIGITAL_ASSETS");
  check("AI: digital assets is UNKNOWN (never an asserted $0) while a wallet is unvalued",
    digital?.amount === null && /not yet valued/.test(digital?.reason ?? ""));
  check("AI: the other class still stands", inv?.components.find((c) => c.key === "TRADITIONAL_INVESTMENTS")?.amount != null);
}

// ══ 2. NO_OBSERVATION — a NEW wallet is excluded and is not $0 ═════════════════
{
  // A new wallet: the schema's DEFAULT 0 in the column, nothing observed yet.
  const r = resolveWalletBalance(0, wallet("NO_OBSERVATION", null, null));
  check("NO_OBSERVATION: flagged valuationUnknown (the 0 is structural, not a value)", r.valuationUnknown === true);
  const c = classifyAccounts([CASH, { type: "crypto", balance: r.balance, currency: "USD", valuationUnknown: r.valuationUnknown }]);
  check("NO_OBSERVATION: counted as unvalued, not as a $0 holding", c.unvaluedCount === 1);
  check("NO_OBSERVATION: contributes nothing to digital assets / net worth",
    c.totalDigitalAssets === 0 && c.netWorth === CASH.balance);

  // An unsynced wallet whose column carries an undated figure: never counted.
  const seeded = resolveWalletBalance(4321.5, wallet("NO_OBSERVATION", null));
  check("NO_OBSERVATION: an undated stored figure is never the value", seeded.balance === 0 && seeded.valuationUnknown === true);
}

// ══ 3. Priced, observed (and stale) wallets are UNCHANGED ═════════════════════
{
  for (const state of ["VALUED", "STALE"] as const) {
    const v = wallet(state, 1234.5678, 2);
    const r = resolveWalletBalance(0, v);
    check(`${state}: same balance as the pre-fix rule`, r.balance === legacyBalance(0, v));
    check(`${state}: no valuationUnknown key at all`, !("valuationUnknown" in r));
    const rows = [CASH, SAVE, BROK, { type: "crypto", balance: r.balance, currency: "USD" }, CARD];
    const legacyRows = [CASH, SAVE, BROK, { type: "crypto", balance: legacyBalance(0, v), currency: "USD" }, CARD];
    check(`${state}: totals byte-identical to the pre-fix arithmetic`,
      totals(classifyAccounts(rows)) === totals(classifyAccounts(legacyRows)));
    check(`${state}: nothing counted as unvalued`, classifyAccounts(rows).unvaluedCount === 0);
  }
  // Non-wallet accounts: the column is the authority, untouched.
  const plain = resolveWalletBalance(98.76, undefined);
  check("non-wallet: column passes through, no flag", plain.balance === 98.76 && !("valuationUnknown" in plain));
  // Aggregated privacy row: members excluded are counted.
  check("aggregate row: unvaluedMemberCount is counted", unvaluedAccountCount({ unvaluedMemberCount: 2 }) === 2);
}

// ══ 4. The today-snapshot read carries the exclusion ══════════════════════════
async function snapshotSection(): Promise<void> {
  const links = [
    { visibilityLevel: "FULL", financialAccount: { id: "acct-cash", type: "checking", balance: 500, currency: "USD", walletChain: null, lastUpdated: new Date("2026-01-01T00:00:00Z"), availableBalance: null } },
    // A new wallet: DEFAULT-0 column, no PositionObservation yet.
    { visibilityLevel: "FULL", financialAccount: { id: "acct-new-wallet", type: "crypto", balance: 0, currency: "USD", walletChain: "SOL", lastUpdated: new Date("2026-01-01T00:00:00Z"), availableBalance: null } },
    // An unsynced wallet with an undated stored figure.
    { visibilityLevel: "FULL", financialAccount: { id: "acct-stale-col", type: "crypto", balance: 999, currency: "USD", walletChain: "ETH", lastUpdated: new Date("2026-01-01T00:00:00Z"), availableBalance: null } },
  ];
  const client = {
    spaceAccountLink: { findMany: async () => links },
    positionObservation: { groupBy: async () => [] }, // nothing observed
  } as unknown as SnapshotAccountsClient;
  const rows = await readSpaceAccountsForSnapshot("space-synthetic", client);
  const byId = new Map(rows.map((r) => [r.id, r]));
  check("snapshot read: new wallet flagged valuationUnknown", byId.get("acct-new-wallet")?.valuationUnknown === true);
  check("snapshot read: stale-column wallet flagged, column NOT used",
    byId.get("acct-stale-col")?.valuationUnknown === true && byId.get("acct-stale-col")?.balance === 0);
  check("snapshot read: the non-wallet row carries no flag (byte-identical)", !("valuationUnknown" in (byId.get("acct-cash") ?? {})));
  const c = classifyAccounts(rows);
  check("snapshot totals exclude both wallets", c.totalDigitalAssets === 0 && c.netWorth === 500);
  check("snapshot classification reports the exclusion the writer stamps from", c.unvaluedCount === 2);
}

// ══ 5. STATIC — no totals path reads a wallet balance without the classification ══
{
  // Every module that loads wallet current values must route the balance through
  // `resolveWalletBalance` and never substitute `.value!` itself.
  const roots = ["app", "lib", "components"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
      if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
    }
  };
  for (const r of roots) walk(join(process.cwd(), r));
  const AUTHORITY = join(process.cwd(), "lib", "crypto", "wallet-current-value.ts");
  const consumers = files.filter((f) => f !== AUTHORITY && /loadWalletCurrentValues\(/.test(code(readFileSync(f, "utf8"))));
  check("the consumers of loadWalletCurrentValues are found", consumers.length >= 4, consumers.join(", "));
  for (const f of consumers) {
    const src = code(readFileSync(f, "utf8"));
    const rel = f.slice(process.cwd().length + 1);
    check(`${rel} reads the wallet balance through resolveWalletBalance`, /resolveWalletBalance\(/.test(src));
    check(`${rel} never substitutes a wallet value itself`, !/\.value!/.test(src) && !/hasKnownValue\([^)]*\)\s*\?/.test(src));
  }
  const auth = code(read("lib", "crypto", "wallet-current-value.ts"));
  check("applyCanonicalWalletBalances routes through the classification",
    /\.\.\.resolveWalletBalance\(r\.balance, v\)/.test(auth));
  check("the classification excludes NO_PRICE/NO_OBSERVATION (never the column)",
    /return \{ balance: 0, valuationUnknown: true \};/.test(auth));
  const cls = code(read("lib", "account-classifier.ts"));
  check("classifyAccounts skips unvalued rows in every sum",
    (cls.match(/a\.valuationUnknown === true/g) ?? []).length >= 4);
  check("…and reports the count", /unvaluedCount: accounts\.reduce\(\(n, a\) => n \+ unvaluedAccountCount\(a\), 0\)/.test(cls));
  check("the Wealth workspace discloses unvaluedCount",
    /unvaluedCount/.test(code(read("components", "space", "widgets", "wealth", "WealthWorkspace.tsx"))));
  check("the Accounts ledger excludes + discloses unvalued rows",
    /unvaluedAccountCount\(d\.row\)/.test(code(read("components", "space", "widgets", "accounts", "AccountsLedger.tsx")))
      && /not yet valued/.test(read("components", "space", "widgets", "accounts", "AccountsLedger.tsx")));
}

snapshotSection().then(() => {
  console.log(failures === 0
    ? `\nunvalued-wallet-exclusion (FM-AUDIT-022): ${passes} checks passed.`
    : `\nunvalued-wallet-exclusion: ${failures} FAILED (${passes} passed)`);
  if (failures > 0) process.exit(1);
}, (e) => { console.error(e); process.exit(1); });
