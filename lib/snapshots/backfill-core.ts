/**
 * lib/snapshots/backfill-core.ts
 *
 * D2.x Slice 4 — PURE reconstruction math for the historical snapshot backfill.
 * No DB, no Prisma, no `new Date()` inside the tested functions (dates are
 * passed in), so this unit-tests without `prisma generate`. The DB orchestration
 * (queries, gate, createMany) lives in lib/snapshots/backfill.ts.
 *
 * Reconstruction is honest only for CASH (checking/savings): balances are
 * walked backward from today's real balance using raw signed transaction
 * amounts (FM convention: +in / −out), with
 *   eod(d) = eod(d+1) − Σ amount(transactions dated d+1).
 * Below an account's earliest transaction there are no deltas, so the balance
 * naturally holds flat — never fabricated. Non-cash (investments/crypto/manual/
 * loans) are held flat by the caller (they aren't passed here). No FlowType.
 */

// ── Date helpers (UTC, date-only) ─────────────────────────────────────────────

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fromISO(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function truncDateUTC(d: Date): Date {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

export function addDaysUTC(d: Date, days: number): Date {
  const t = truncDateUTC(d);
  t.setUTCDate(t.getUTCDate() + days);
  return t;
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

// ── Cash balance reconstruction ───────────────────────────────────────────────

export interface CashAccountBalance {
  id:      string;
  balance: number; // current balance = end-of-day(today)
}

/**
 * deltaByAccountDay: accountId → (isoDate → Σ signed amount posted that day).
 * Returns: isoDate → (accountId → reconstructed end-of-day balance), for every
 * day in [effectiveStart, today − 1] (today itself is never reconstructed).
 *
 * Days are produced newest-first (today−1 down to effectiveStart); Map preserves
 * insertion order. Missing deltas count as 0 (balance holds flat).
 */
export function reconstructDailyCashBalances(
  cashAccounts: CashAccountBalance[],
  deltaByAccountDay: Map<string, Map<string, number>>,
  today: Date,
  effectiveStart: Date,
): Map<string, Map<string, number>> {
  const start = truncDateUTC(effectiveStart);
  const t0 = truncDateUTC(today);
  const out = new Map<string, Map<string, number>>();

  // running = end-of-day(today) = current balances.
  const running = new Map<string, number>(cashAccounts.map((a) => [a.id, a.balance]));

  for (let d = addDaysUTC(t0, -1); d.getTime() >= start.getTime(); d = addDaysUTC(d, -1)) {
    // Move from eod(d+1) to eod(d) by subtracting the transactions dated (d+1).
    const dPlus1 = isoDate(addDaysUTC(d, 1));
    for (const a of cashAccounts) {
      const sum = deltaByAccountDay.get(a.id)?.get(dPlus1) ?? 0;
      running.set(a.id, (running.get(a.id) ?? 0) - sum);
    }
    out.set(isoDate(d), new Map(running));
  }

  return out;
}

/**
 * D2.x Slice 4B — liability (credit-card) reverse walk. Identical shape to the
 * cash walk EXCEPT the sign: a liability balance is the amount OWED (stored
 * positive), which rises with purchases (FM −) and falls with payments/refunds
 * (FM +). The per-day change in owed is −Σ FM_amount, so the reverse step ADDS:
 *
 *   owed(d) = owed(d+1) + Σ amount(txns dated d+1)
 *
 * (Sanity: owed today 500; a $100 purchase yesterday is FM −100 ⇒ owed before =
 * 500 + (−100) = 400 — correctly lower before the charge.) Missing deltas hold
 * flat. A reconstructed negative owed (overpayment/credit balance) is left as-is
 * here; classifyAccounts clamps liabilities at max(0, balance) downstream,
 * matching live behavior.
 *
 * The cash walk (reconstructDailyCashBalances) is intentionally left unchanged.
 */
export function reconstructDailyLiabilityBalances(
  liabilityAccounts: CashAccountBalance[],
  deltaByAccountDay: Map<string, Map<string, number>>,
  today: Date,
  effectiveStart: Date,
): Map<string, Map<string, number>> {
  const start = truncDateUTC(effectiveStart);
  const t0 = truncDateUTC(today);
  const out = new Map<string, Map<string, number>>();

  // running = owed at end-of-day(today) = current balance.
  const running = new Map<string, number>(liabilityAccounts.map((a) => [a.id, a.balance]));

  for (let d = addDaysUTC(t0, -1); d.getTime() >= start.getTime(); d = addDaysUTC(d, -1)) {
    const dPlus1 = isoDate(addDaysUTC(d, 1));
    for (const a of liabilityAccounts) {
      const sum = deltaByAccountDay.get(a.id)?.get(dPlus1) ?? 0;
      running.set(a.id, (running.get(a.id) ?? 0) + sum); // ADD (owed) vs SUBTRACT (cash)
    }
    out.set(isoDate(d), new Map(running));
  }

  return out;
}

// ── Reconstruction/observation boundary continuity ────────────────────────────

/**
 * The boundary between RECONSTRUCTED and OBSERVED history (the ownership rule this
 * codebase actually implements — there is NO persisted `firstSyncedAt`):
 *
 *   • Storage grain: SpaceSnapshot is one row per `@@unique([spaceId, date])`, so a
 *     calendar date has AT MOST ONE row — reconstructed and observed can never
 *     coexist for the same day. Ownership is decided by the row's `isEstimated`.
 *   • `isEstimated = false` → OBSERVED (a live snapshot regenerate.ts wrote from
 *     that day's real `FinancialAccount.balance`); it is FROZEN — automatic regen
 *     skips it (regenerate-history.core.ts's skip-frozen guard).
 *   • `isEstimated = true`  → RECONSTRUCTED (walked back from the current balance).
 *   • The handoff day is therefore the earliest `isEstimated = false` date; every
 *     earlier date is reconstructed. It is defined by the DATA (which days have a
 *     frozen observed row), not by any stored sync timestamp.
 *
 * The desired shape is `… reconstructed(N-1) │ observed(N) observed(N+1) …` with no
 * overlap (guaranteed by the unique key) and no gap. CONTINUITY across that seam
 * is the same-basis invariant expressed at the boundary: since both sides read the
 * same posted `balance` truth, the only legitimate difference between the last
 * reconstructed value and the first observed value is the POSTED economic activity
 * dated on the observed day:
 *
 *   firstObserved − lastReconstructed − postedBoundaryActivity  ==  0   (± epsilon)
 *
 * Any non-zero residual is value NOT explained by posted activity — a phantom
 * (e.g. an anchor that carried unsettled/pending value, or a stale anchor never
 * re-walked). `postedBoundaryActivity` is the day-N net change in the SAME value
 * the two balances measure, in the caller's sign convention (for cash: Σ FM signed
 * amount dated N; for owed: the day-N change in owed). Sign-agnostic by design.
 */
export const RECONSTRUCTION_CONTINUITY_EPSILON = 0.01;

/** firstObserved − lastReconstructed − postedBoundaryActivity. 0 (±ε) ⇒ continuous. */
export function boundaryContinuityResidual(
  lastReconstructed: number,
  firstObserved: number,
  postedBoundaryActivity: number,
): number {
  return firstObserved - lastReconstructed - postedBoundaryActivity;
}

/** True when the reconstructed→observed seam is explained entirely by posted activity. */
export function isBoundaryContinuous(
  lastReconstructed: number,
  firstObserved: number,
  postedBoundaryActivity: number,
  epsilon: number = RECONSTRUCTION_CONTINUITY_EPSILON,
): boolean {
  return Math.abs(boundaryContinuityResidual(lastReconstructed, firstObserved, postedBoundaryActivity)) <= epsilon;
}

// ── Reconstructable-card predicate ────────────────────────────────────────────

/**
 * Is this debt account a reconstructable revolving credit card?
 *
 * Plaid import never writes debtSubtype (exchangeToken.ts), so Plaid cards have
 * debtSubtype = null. We therefore accept an explicit credit_card OR a
 * null-subtype debt account that carries a creditLimit OR (PB-8) whose Plaid
 * `providerSubtype` is a credit subtype ("credit card", "paypal") — Plaid sends
 * some cards with no limit at all, and those were being held flat. Any account with an explicit NON-card subtype
 * (line_of_credit, heloc, mortgage, auto_loan, student_loan, personal_loan, …)
 * is excluded and stays flat.
 *
 * Known caveat: a Plaid line_of_credit / HELOC also has a null subtype + a
 * limit, so it would be included here — those are revolving and transaction-
 * driven, so the walk is still directionally correct, but to strictly exclude
 * one, set its FinancialAccount.debtSubtype to a non-"credit_card" value.
 * Installment loans (no limit) are naturally excluded. Never touches non-debt.
 *
 * SINGLE AUTHORITY (HIST-1A). Formerly duplicated as four logic-identical copies
 * — backfill.ts, regenerate-history.ts, accounts-asof.core.ts (named), and
 * accounts-asof.ts (inline). backfill-core is the pure, `server-only`-free module
 * every one of those already imports, so the historical card walk (backfill,
 * regenerate-history) and the as-of card walk can never diverge on which debt
 * accounts are transaction-driven. Structurally typed so richer inputs (e.g.
 * AsOfAccountInput) satisfy it without an adapter.
 */
export function isReconstructableCard(a: {
  type:        string;
  debtSubtype: string | null;
  creditLimit: number | null;
  /**
   * PB-8 — `FinancialAccount.providerSubtype` (Plaid `subtype`, lowercased).
   * Optional only so hand-built inputs keep compiling; every DB caller selects
   * it (pinned by lib/snapshots/card-predicate-authority.test.ts).
   */
  providerSubtype?: string | null;
}): boolean {
  if (a.type !== "debt") return false;
  if (a.debtSubtype === "credit_card") return true;
  if (a.debtSubtype !== null) return false; // an explicit non-card subtype stays flat
  if (a.creditLimit != null) return true;
  // PB-8 — Plaid sends many cards (Capital One among them) with
  // `balances.limit: null`, so the limit cannot be the only revolving signal.
  // The provider's own subtype is evidence of the same fact.
  const sub = a.providerSubtype?.trim().toLowerCase() ?? null;
  return sub !== null && PLAID_CREDIT_SUBTYPES.has(sub);
}

/**
 * PB-8 — Plaid's `credit` account subtypes: revolving, transaction-driven lines
 * whose posted ledger walks back from the current balance. (Plaid `loan`
 * subtypes — mortgage, auto, student, … — are installment and never walk.)
 */
export const PLAID_CREDIT_SUBTYPES: ReadonlySet<string> = new Set(["credit card", "paypal"]);

// ── Derived snapshot fields (parity with lib/snapshots/regenerate.ts) ─────────

export interface ClassifyTotals {
  totalInvestments:   number;
  totalDigitalAssets: number;
  totalChecking:      number;
  totalSavings:       number;
  totalLiabilities:   number;
  totalRealAssets:    number;
  /**
   * FIN-005 — the classifier's unrestricted/restricted split of the SAME cash
   * (`classifyAccounts.totalLiquid` / `totalRestrictedCash`). Optional, because
   * the stored snapshot carries no such column; read by `computeLiquidSplit`.
   */
  totalLiquid?:         number;
  totalRestrictedCash?: number;
}

/**
 * FIN-005 — the liquid position on the HERO's basis, beside the snapshot row.
 *
 * The stored `netLiquid` is `cash + savings − debt` over ALL checking and
 * savings, restricted cash INCLUDED (an HSA checking account, retirement cash).
 * That formula is pinned as a stored-row invariant by
 * lib/snapshots/series-integrity.core.ts, lib/snapshots/aggregate-authorisation.core.ts
 * and the REQUIRED `check-snapshot-integrity` audit, so it cannot change
 * without a schema-level split. `classifyAccounts.totalLiquid` — the Hero's
 * "Available now" figure, the AI's `totalLiquid`, the runway denominator —
 * EXCLUDES restricted cash. Runtime audit 2026-10-21: checking 10,000 + HSA
 * checking 5,000 (restricted) + savings 2,000 ⇒ Hero 12,000 vs snapshot
 * netLiquid/history 17,000.
 *
 * This function is the honest bridge: the unrestricted figure when the totals
 * carry the split, and `null` — never a silent all-cash substitute — when they
 * do not (a hand-built `ClassifyTotals`, a stored row read back). Persisting the
 * split (`SpaceSnapshot.restrictedCash`) is a schema change owned elsewhere;
 * until then the Liquidity history (lib/liquidity/cash-history.ts) plots the
 * all-cash tier and says so.
 */
export interface LiquidSplit {
  /** Unrestricted checking + savings — `classifyAccounts.totalLiquid`. */
  liquid:         number;
  /** Restricted checking + savings — `classifyAccounts.totalRestrictedCash`. */
  restrictedCash: number;
  /** `liquid − debt`: `netLiquid` on the Hero's basis. */
  netLiquidUnrestricted: number;
}
export function computeLiquidSplit(c: ClassifyTotals): LiquidSplit | null {
  if (typeof c.totalLiquid !== "number" || typeof c.totalRestrictedCash !== "number") return null;
  return {
    liquid:         c.totalLiquid,
    restrictedCash: c.totalRestrictedCash,
    netLiquidUnrestricted: c.totalLiquid - c.totalLiabilities,
  };
}

export interface SnapshotFields {
  stocks:      number;
  crypto:      number;
  total:       number;
  cash:        number;
  savings:     number;
  debt:        number;
  netWorth:    number;
  totalAssets: number;
  netLiquid:   number;
  cashOnHand:  number;
}

/**
 * REG-2 — held-flat inclusion predicate. A cash/savings/debt account with a real
 * (non-zero) current balance but NO reconstructable transaction history is held
 * FLAT at its current balance across the historical window — an honest estimate
 * (the row stays isEstimated=true; the day's cash/card tier degrades to
 * "estimated") — instead of being floored to today and dropped from every
 * historical day. This mirrors the constant-quantity treatment crypto / holdings-
 * only investment accounts already get, and keeps the historical writers symmetric
 * with the live writer (regenerate.ts), which includes every balance-bearing
 * account regardless of transaction evidence.
 *
 * Single authority for the predicate, imported by BOTH historical writers
 * (backfill.ts, regenerate-history.ts) so "which accounts are held flat" can never
 * diverge between them. Investment/crypto/real-asset accounts are excluded here —
 * they are valued from holdings / manual entry, so "zero Transaction rows" is
 * normal for them and is handled by their own valuation path, not this one.
 *
 * @param hasTransactions true when the account has ≥1 non-deleted Transaction (so
 *   its history is reconstructed by the walk-back, not held flat).
 */
export function isHeldFlatBalanceAccount(a: { type: string; balance: number }, hasTransactions: boolean): boolean {
  if (hasTransactions) return false;
  if (a.type !== "checking" && a.type !== "savings" && a.type !== "debt") return false;
  return a.balance !== 0;
}

// ── Per-account reconstruction floors ─────────────────────────────────────────

/** The epoch — a floor of "no lower bound" (account spans the whole window). */
const FLOOR_EPOCH = new Date(0);

/**
 * The earliest date each account may appear on a reconstructed day — the SINGLE
 * authority for the floor rule, imported by BOTH historical writers (backfill.ts
 * = M2, regenerate-history.ts = M3) so "from when can this account be
 * reconstructed" can never drift between them (HIST-2A; same anti-drift rationale
 * as the shared [[isReconstructableCard]]).
 *
 * Per account:
 *   - account-level floor = its earliest real (non-deleted) Transaction; NO
 *     transactions ⇒ `today` (genuinely zero reconstructable days) EXCEPT a
 *     held-flat balance-bearing account (REG-2): a cash account floors to EPOCH
 *     (spans the window held flat at its current balance); a DEBT account
 *     (PB-8) floors to its connection — ESTIMATED from there, UNKNOWN before;
 *   - SECONDARY floor (SHARED spaces only) = the SpaceAccountLink.createdAt — this
 *     Space's history cannot predate when the account was shared into it; a
 *     PERSONAL space (the account's home) has no such bound (it would re-collapse
 *     the window to connect day);
 *   - the floor is the LATER (maxDate) of the two.
 *
 * `ignoreFloors` (dev-seed only, backfill's `--ignore-floors`) collapses every
 * floor to EPOCH. Pure: `today` is passed in, EPOCH is a constant.
 */
export function computeAccountFloors(
  entries:             readonly {
    id: string;
    linkCreatedAt: Date;
    /** PB-8 — the account's type; a held-flat `debt` account never floors to EPOCH. */
    type?: string;
    /** PB-8 — FinancialAccount.createdAt, for that liability's connection floor. */
    accountCreatedAt?: Date;
  }[],
  earliestTxByAccount: ReadonlyMap<string, Date>,
  heldFlatIds:         ReadonlySet<string>,
  isSharedSpace:       boolean,
  today:               Date,
  ignoreFloors = false,
): Map<string, Date> {
  return new Map(
    entries.map(({ id, linkCreatedAt, type, accountCreatedAt }): [string, Date] => {
      if (ignoreFloors) return [id, FLOOR_EPOCH];
      // PB-8 (owner 2026-11-02) — a held-flat LIABILITY (a mortgage with no
      // transactions) is never painted backward across the epoch: it is present
      // from its CONNECTION (max(account created, linked)) and UNKNOWN before.
      // A held-flat cash account keeps REG-2's EPOCH floor (out of PB-8's scope).
      const heldFlatFloor = type === "debt"
        ? maxDate(truncDateUTC(accountCreatedAt ?? linkCreatedAt), truncDateUTC(linkCreatedAt))
        : FLOOR_EPOCH;
      const txFloor = earliestTxByAccount.get(id) ?? (heldFlatIds.has(id) ? heldFlatFloor : today);
      const linkFloor = isSharedSpace ? truncDateUTC(linkCreatedAt) : FLOOR_EPOCH;
      return [id, maxDate(txFloor, linkFloor)];
    }),
  );
}

/**
 * THE snapshot arithmetic (regenerateSpaceSnapshot, backfill and the history
 * writers all import this), so every row is the same computation:
 *
 *   total       = stocks + crypto
 *   totalAssets = stocks + crypto + cash + savings + realAssets
 *   netWorth    = totalAssets − debt
 *               = stocks + crypto + cash + savings + realAssets − debt
 *                 (FIN-015 — real assets ARE in net worth; the schema comment on
 *                 `SpaceSnapshot.netWorth` omits them and no `realAssets` column
 *                 is stored, so the component is a read-time residual)
 *   netLiquid   = cash + savings − debt   — ALL checking + savings, restricted
 *                 cash included (FIN-005; see `computeLiquidSplit`); real
 *                 assets, investments and crypto excluded
 *   cashOnHand  = max(cash, 0)
 */
export function computeSnapshotFields(c: ClassifyTotals): SnapshotFields {
  const stocks     = c.totalInvestments;
  const crypto     = c.totalDigitalAssets;
  const total      = stocks + crypto;
  const cash       = c.totalChecking;
  const savings    = c.totalSavings;
  const debt       = c.totalLiabilities;
  const realAssets = c.totalRealAssets;

  const totalAssets = total + cash + savings + realAssets;
  const netWorth    = totalAssets - debt;
  const netLiquid   = cash + savings - debt;
  const cashOnHand  = Math.max(cash, 0);

  return { stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand };
}
