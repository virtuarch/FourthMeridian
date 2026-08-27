/**
 * lib/crypto/wallet-current-value.ts
 *
 * W-M3a — THE current value of a wallet whose chain writes no balance column.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * Since W-M1c, a native wallet adapter writes its evidence to the position
 * spine and deliberately does NOT write `FinancialAccount.balance` or
 * `.nativeBalance` (`netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE"`).
 * That was the right call — those columns are an undated sync-time USD figure,
 * and a chain should not be forced to fabricate one to be visible.
 *
 * But the account read path composes every displayed balance FROM those
 * columns, and they are `NOT NULL DEFAULT 0`. So a Solana wallet holding a
 * verified 0.751600602 SOL rendered as $0.00 on every account surface, while
 * the Investments workspace — which reads the spine — showed it correctly. Two
 * chains of custody for one number, disagreeing.
 *
 * A column that cannot express "withheld" reported withheld AS ZERO. That is
 * the single failure this module exists to prevent, and it is why the shape
 * below is tri-state rather than a number.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is NOT a second valuation authority. It performs no price lookup, no FX,
 * no staleness policy and no arithmetic of its own: rows go to
 * `valuePositionRows` — the same canonical path the Investments Time Machine
 * and `getCurrentPositions` use — and what comes back is reported. If this
 * module and the Investments workspace ever disagreed about what a wallet is
 * worth, that would be a defect in this file.
 *
 * It is also NOT a visibility authority. It takes account ids the caller has
 * ALREADY authorized and answers only about those. That is deliberate: a
 * BALANCE_ONLY-shared account's *balance* is shared (only per-item detail is
 * not), so the account read path — which resolves that boundary itself — is
 * the right place for the decision, and `getCurrentPositions` (hard-wired to
 * FULL-only detail) is deliberately NOT reused here. Reusing it would have
 * silently zeroed every BALANCE_ONLY-shared wallet, re-creating this exact bug
 * one visibility tier down.
 *
 * ── WHICH CHAINS THIS SERVES IS A REGISTRY FACT, NOT A LIST HERE ────────────
 * A chain is served exactly when it does not name the legacy balance column as
 * its net-worth participation (`writesLegacyBalanceColumn`, wallet-sync-dispatch).
 * Nothing in this file names a chain, and nothing above it does either.
 *
 * W6d is the slice that empties the exception: Bitcoin's CURRENT value moves
 * onto this path, the same way its HISTORICAL value moved onto the spine in
 * W6c. See `needsSpineValuation` for why that is one registry line and not a
 * change here.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import {
  POSITION_VALUATION_SELECT,
  RECONSTRUCTION_VALUATION_SELECT,
  valuePositionRows,
} from "@/lib/investments/valuation";
import { todayUTCISO } from "@/lib/time/clock";
import { writesLegacyBalanceColumn } from "./wallet-sync-dispatch";
import { nativeAssetForChain } from "./native-asset";
import { bandForAge, ageInDays, type FreshnessBand } from "@/lib/freshness/observation";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Why a wallet has, or does not have, a current value.
 *
 * These are three DIFFERENT facts and no consumer may collapse them:
 *
 *   VALUED          the spine holds an observation and the canonical price path
 *                   priced it. `quantity` and `value` are both real.
 *   NO_PRICE        we know exactly how much is held and cannot say what it is
 *                   worth. `quantity` is real; `value` is null. A held asset,
 *                   not an empty one.
 *   NO_OBSERVATION  nothing has ever been observed for this wallet — never
 *                   synced, or every attempt refused. Both are null.
 *
 *   STALE           (W6b) the quantity and value are real but the observation
 *                   behind them is older than the freshness horizon. This is the
 *                   LAST KNOWN position, not a confirmation of the position now,
 *                   and it must never be published as an unqualified live
 *                   balance. The numbers are still carried — a stale non-zero is
 *                   emphatically not a zero.
 *
 * A CONFIRMED ZERO is not on this list, and that is the point: a provider that
 * returns a zero balance produces a real observation, so it arrives as VALUED
 * with `quantity: 0`. "Holds nothing" and "we don't know" are distinguishable
 * downstream because one is a number and the other is null.
 *
 * ── W6b: ZERO NEEDS THE SAME FRESHNESS AUTHORITY AS ANY OTHER QUANTITY ───────
 * A stale confirmed zero is a stale reading, not a fresh confirmation that the
 * wallet is empty. Zero is itself a material claim — "this wallet has been
 * drained" — and it may only be asserted on evidence as current as any other
 * number would need. So freshness is applied BEFORE the value is classified,
 * never only to the non-zero branch.
 */
export type WalletValueState = "VALUED" | "STALE" | "NO_PRICE" | "NO_OBSERVATION";

export interface WalletCurrentValue {
  accountId:  string;
  chain:      string;
  /** CAIP-19 identity of the native asset, or null for an unregistered chain. */
  assetKey:   string | null;
  /** Display ticker — never an identity. */
  symbol:     string | null;
  /** Native units held. NULL IS UNKNOWN — never 0. A real zero is 0. */
  quantity:   number | null;
  /** Reporting-currency value. NULL IS UNKNOWN — never 0. */
  value:      number | null;
  state:      WalletValueState;
  /** The date this was valued at (the caller's clock). */
  asOf:       string;
  /** The close actually used, which may be earlier than `asOf`. */
  priceDate:  string | null;
  /**
   * W6b — WHEN the provider last successfully confirmed this wallet, and the
   * canonical band for that age.
   *
   * The instant is `FinancialAccount.lastUpdated`, which the wallet adapters
   * write ONLY after a successful read (sol-sync.ts step 4, evm-native.ts): a
   * refused sync returns before it, so the age grows exactly as it should when a
   * provider is unavailable. The band is `bandForAge` from lib/freshness —
   * LIVE / RECENT / STALE / VERY_STALE / UNKNOWN — the same thresholds every
   * other balance surface discloses against. No new TTL is invented here.
   */
  observedAt: Date | null;
  freshness:  FreshnessBand;
}

/** One account the caller has already authorized, with the chain that names its asset. */
export interface WalletAccountRef {
  id:          string;
  walletChain: string | null | undefined;
  /**
   * W6b — `FinancialAccount.lastUpdated`: the clock a wallet adapter advances
   * ONLY on a successful provider read. Omitted or null leaves the freshness
   * UNKNOWN, which is never treated as fresh.
   */
  lastUpdated?: Date | null;
}

/**
 * Does this wallet have a real number behind it, fresh or not?
 *
 * TRUE for VALUED and STALE alike, and that is deliberate. A stale reading is
 * the LAST KNOWN position; falling back to `FinancialAccount.balance` because it
 * is not fresh would replace a real, dated number with an unwritten column that
 * always reads zero — trading a disclosable imprecision for a fabricated
 * absence. Staleness is disclosed by `freshness`, never by discarding the value.
 *
 * FALSE for NO_PRICE and NO_OBSERVATION, where there is no number to show.
 */
export function hasKnownValue(v: WalletCurrentValue | undefined): boolean {
  return v !== undefined && (v.state === "VALUED" || v.state === "STALE") && v.value !== null;
}

/** May this wallet back a CURRENT claim — freshly observed wealth, now? */
export function isFreshCurrentValue(v: WalletCurrentValue | undefined): boolean {
  return v !== undefined && v.state === "VALUED";
}

/**
 * Does this account's CURRENT value have to come from the spine?
 *
 * True for a wallet on a chain that does not name the legacy balance column as
 * its net-worth participation. Every non-wallet account — cash, credit,
 * brokerage — is unaffected and keeps whatever authority it already had.
 *
 * ── W6c/W6d — TWO QUESTIONS, TWO PREDICATES, ONE PLACE EACH ─────────────────
 * Bitcoin's HISTORICAL authority moved to the spine in W6c (replayed,
 * reconciled, coverage-licensed). Its CURRENT authority deliberately did NOT
 * move in the same slice, and this predicate deliberately does not read the
 * historical one: they are different claims (invariant 32), and a single
 * predicate would have dragged today's net worth along with a slice about
 * history.
 *
 * W6d is that separate move, and it is a REGISTRY change, not a change here.
 * Bitcoin becomes spine-valued the moment `wallet-sync-dispatch` stops giving
 * BTC `netWorthParticipation: "LEGACY_BALANCE_COLUMN"` — one line, one place,
 * and every consumer below follows because none of them names a chain. Writing
 * `chain !== "BTC"` here instead would put chain policy in a read surface, which
 * is the drift the registry exists to prevent.
 *
 * WHAT THAT CHANGES, MEASURED: the same quantity, priced by a different
 * authority. The column is quantity × an UNDATED sync-time spot; this path is
 * quantity × the canonical dated close, the same one the Investments workspace
 * and every historical point use. On the live wallet that is +$108.86 on
 * 0.24060252 BTC (78,426.98 spot vs 78,879.42 close on 2026-08-25). The number
 * moves because the old one was never reproducible, not because this one is new.
 *
 * DELETION CONDITION: when `LEGACY_BALANCE_COLUMN` has no member left in the
 * registry AND no wallet remains without spine evidence (see the fallback note
 * in the consumers), this becomes `Boolean(ref.walletChain)` and
 * `writesLegacyBalanceColumn` goes with it.
 */
export function needsSpineValuation(ref: WalletAccountRef): boolean {
  return Boolean(ref.walletChain) && !writesLegacyBalanceColumn(ref.walletChain);
}

/**
 * Current value per account for the wallets that need it, keyed by account id.
 *
 * Accounts that do not need spine valuation are ABSENT from the map rather than
 * present with a zero — the caller must fall through to its existing authority
 * for those, and an absent key cannot be mistaken for "worth nothing".
 */
export async function loadWalletCurrentValues(
  refs: readonly WalletAccountRef[],
  options?: { client?: Client; asOf?: string; contextSpaceId?: string | null; reportingCurrency?: string; now?: Date },
): Promise<Map<string, WalletCurrentValue>> {
  const out = new Map<string, WalletCurrentValue>();
  const client = options?.client ?? db;
  const asOf   = options?.asOf ?? todayUTCISO();
  const now    = options?.now ?? new Date();

  // W6b — the freshness of the SUCCESSFUL provider read behind this wallet.
  // `lastUpdated` is advanced only by an adapter that actually got an answer, so
  // a day of refused syncs simply ages — which is precisely the signal wanted.
  const bandOf = (ref: WalletAccountRef): { observedAt: Date | null; band: FreshnessBand } => {
    const observedAt = ref.lastUpdated ?? null;
    if (observedAt === null) return { observedAt: null, band: "UNKNOWN" };
    return { observedAt, band: bandForAge(ageInDays(observedAt, now)) };
  };
  /** A band that may back a CURRENT claim. UNKNOWN is never fresh. */
  const isFresh = (band: FreshnessBand): boolean => band === "LIVE" || band === "RECENT";

  const wallets = refs.filter(needsSpineValuation);
  if (wallets.length === 0) return out;

  // Seed every wallet as NO_OBSERVATION. Anything that fails to resolve below
  // therefore stays honestly unknown; nothing can fall through to a zero.
  const freshnessByAccount = new Map<string, { observedAt: Date | null; band: FreshnessBand }>();
  for (const w of wallets) {
    const asset = nativeAssetForChain(w.walletChain);
    const f = bandOf(w);
    freshnessByAccount.set(w.id, f);
    out.set(w.id, {
      accountId: w.id,
      chain:     (w.walletChain ?? "").trim().toUpperCase(),
      assetKey:  asset?.assetKey ?? null,
      symbol:    asset?.symbol ?? null,
      quantity:  null,
      value:     null,
      state:     "NO_OBSERVATION",
      asOf,
      priceDate: null,
      observedAt: f.observedAt,
      freshness:  f.band,
    });
  }

  const accountIds = wallets.map((w) => w.id);
  const asOfDate   = new Date(`${asOf}T00:00:00.000Z`);

  // Latest observation per (account, instrument) ≤ asOf — the same cheap
  // indexed shape getCurrentPositions uses, over the same guarded rows.
  const latest = await client.positionObservation.groupBy({
    by:    ["financialAccountId", "instrumentId"],
    where: {
      financialAccountId: { in: accountIds },
      supersededById:     null,
      deletedAt:          null,
      date:               { lte: asOfDate },
    },
    _max: { date: true },
  });

  const pairFilters = latest
    .filter((g): g is typeof g & { _max: { date: Date } } => g._max.date != null)
    .map((g) => ({ financialAccountId: g.financialAccountId, instrumentId: g.instrumentId, date: g._max.date }));

  if (pairFilters.length === 0) return out;

  const [posRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where:  { OR: pairFilters, supersededById: null, deletedAt: null },
      select: POSITION_VALUATION_SELECT,
    }),
    client.positionReconstruction.findMany({
      where:  { financialAccountId: { in: accountIds } },
      select: RECONSTRUCTION_VALUATION_SELECT,
    }),
  ]);

  if (posRows.length === 0) return out;

  // THE canonical valuation path. No price, FX or staleness decision is made here.
  const view = await valuePositionRows({
    client,
    asOf,
    contextSpaceId:    options?.contextSpaceId ?? null,
    reportingCurrency: options?.reportingCurrency ?? "USD",
    holdConstant:      false,
    posRows,
    reconRows,
  });

  // A wallet holds ONE native asset, so one component per account. Should a
  // chain ever carry more, the quantities are not summable across instruments —
  // only the reporting values are, and the quantity is then left unknown rather
  // than being invented.
  const componentsByAccount = new Map<string, typeof view.components>();
  for (const c of view.components) {
    const list = componentsByAccount.get(c.accountId) ?? [];
    list.push(c);
    componentsByAccount.set(c.accountId, list);
  }

  for (const [accountId, components] of componentsByAccount) {
    const seed = out.get(accountId);
    if (!seed) continue;

    const valued = components.filter((c) => c.reportingValue !== null);
    const quantity = components.length === 1 ? components[0].quantity : null;
    const priceDate = components.length === 1 ? components[0].priceDate ?? null : null;

    if (valued.length !== components.length) {
      // At least one held asset could not be priced. We know the quantity; the
      // value is unknown, and a partial subtotal would be a smaller lie than
      // zero but a lie all the same.
      out.set(accountId, { ...seed, quantity, value: null, state: "NO_PRICE", priceDate });
      continue;
    }

    // W6b — freshness decides between a CURRENT claim and a LAST-KNOWN one, and
    // it is asked BEFORE the quantity is looked at. A stale zero is a stale
    // reading, not a fresh confirmation that the wallet is empty; zero is a
    // material claim and needs the same evidence authority as any other number.
    const f = freshnessByAccount.get(accountId) ?? { observedAt: null, band: "UNKNOWN" as FreshnessBand };
    out.set(accountId, {
      accountId,
      chain:     seed.chain,
      assetKey:  seed.assetKey,
      symbol:    seed.symbol,
      quantity,
      value:     valued.reduce((s, c) => s + (c.reportingValue ?? 0), 0),
      state:     isFresh(f.band) ? "VALUED" : "STALE",
      asOf,
      priceDate,
      observedAt: f.observedAt,
      freshness:  f.band,
    });
  }

  return out;
}
