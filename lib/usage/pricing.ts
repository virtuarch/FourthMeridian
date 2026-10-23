/**
 * lib/usage/pricing.ts  (Platform Ops cost accounting — Slice 2)
 *
 * VERSIONED PRICES IN CODE. IMMUTABLE FACTS ELSEWHERE. COST IS A READ-TIME
 * REDUCTION, NEVER A STORED COLUMN.
 *
 * Prices are deliberately code, not schema: they are contract-specific, they
 * change on the provider's schedule rather than ours, and true billing is not
 * pollable — neither OpenAI nor Plaid exposes an invoice API this app can read.
 * Everything here is therefore an ESTIMATE from usage × configured rate, and the
 * surfaces that render it say so.
 *
 * ── Why the old per-unit helper is gone ─────────────────────────────────────
 * `estimateUnitSpendUsd(provider, metric, unit, count)` priced ONE counter row at
 * a time. Correct AI pricing is not a per-row operation and never can be, because
 * the input rate depends on a SECOND row:
 *
 *     input cost = (prompt − cached) × inputRate  +  cached × cachedRate
 *
 * A per-row API cannot see both terms, so a caller accumulating row by row must
 * either ignore caching (overstating input by ~5× on measured traffic) or add a
 * cached price to a prompt price — which reports a LARGER cost than pricing the
 * raw prompt with no caching at all. Both failure modes are silent. The reducer
 * below takes a SET of rows so the subtraction is structurally unavoidable.
 *
 * ── Why a rate carries all three prices ─────────────────────────────────────
 * One `AiRate` names input, cachedInput and output together. A cached rate
 * therefore CANNOT be registered without the input rate it is a discount
 * against, which is the shape-level guarantee behind "never register a
 * cached-token rate until the aggregation path is subset-aware".
 *
 * ── Why `effectiveFrom` ─────────────────────────────────────────────────────
 * Usage facts are immutable; prices are not. A rate is resolved AT THE DAY THE
 * USAGE OCCURRED, so today's rate change restates nothing historical, and a
 * corrected rate restates exactly the period it applied to. Usage on a day with
 * no effective rate is reported UNPRICED — never zero.
 *
 * PURE — no imports, no I/O. Testable without a database or a network.
 */

// ── The rate table ───────────────────────────────────────────────────────────

export interface AiRate {
  provider: string;
  /** The model id as it appears after `chat.completions:` in the counter metric. */
  model: string;
  /** Inclusive YYYY-MM-DD. The rate applies to usage on or after this day. */
  effectiveFrom: string;
  /** USD per 1,000,000 tokens. All three together — see the header. */
  usdPerMillion: { input: number; cachedInput: number; output: number };
  /** Where the numbers came from. Every dollar must be traceable to a source. */
  source: string;
}

const OPENAI_PRICING_PAGE = 'openai pricing page (standard tier), fetched 2026-09-08';

/**
 * ⚠️ `effectiveFrom` IS THE DATE WE HAVE EVIDENCE FOR, NOT THE DATE THE PRICE
 * BEGAN. These rates were read from the pricing page on 2026-09-08; when OpenAI
 * actually set them is not something this repository observed. Backdating an
 * entry would fabricate provenance, so usage before this date is reported
 * UNPRICED rather than priced at a rate we are guessing applied.
 *
 * To price earlier usage, add a SECOND entry for the same model with an earlier
 * `effectiveFrom` and a `source` that evidences it (an invoice, a dated
 * screenshot, a support reply). The resolver picks the latest entry on or before
 * the usage day, so history and present coexist without either overwriting the
 * other.
 */
export const AI_RATES: readonly AiRate[] = [
  { provider: 'OPENAI', model: 'gpt-5.5',      effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 5.00,  cachedInput: 0.500,  output: 30.00 } },
  { provider: 'OPENAI', model: 'gpt-5.1',      effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 1.25,  cachedInput: 0.125,  output: 10.00 } },
  { provider: 'OPENAI', model: 'gpt-5',        effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 1.25,  cachedInput: 0.125,  output: 10.00 } },
  { provider: 'OPENAI', model: 'gpt-5-mini',   effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 0.25,  cachedInput: 0.025,  output:  2.00 } },
  { provider: 'OPENAI', model: 'gpt-5-nano',   effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 0.05,  cachedInput: 0.005,  output:  0.40 } },
  { provider: 'OPENAI', model: 'gpt-4.1',      effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 2.00,  cachedInput: 0.500,  output:  8.00 } },
  { provider: 'OPENAI', model: 'gpt-4.1-mini', effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 0.40,  cachedInput: 0.100,  output:  1.60 } },
  { provider: 'OPENAI', model: 'gpt-4o-mini',  effectiveFrom: '2026-09-08', source: OPENAI_PRICING_PAGE,
    usdPerMillion: { input: 0.15,  cachedInput: 0.075,  output:  0.60 } },
];

// ── Plaid: the billable unit is the Item-subscription-month ──────────────────

/**
 * ⚠️ PLAID IS NOT PRICED PER CALL, AND THAT IS THE WHOLE POINT OF THIS BLOCK.
 * Invoice `S-J7Y5657ZK0-2607` (July 2026) reconciles exactly to the Plaid
 * dashboard: Transactions qty 40 = "Items billed in the 7/1–7/31 cycle";
 * Investments qty 4 = Investments-Transactions billed. `/transactions/sync` is
 * included in the subscription and `/transactions/refresh` has zero call sites
 * (the dashboard's Refresh chart reads 0), so REFRESHES COST $0. The
 * `PLAID/<method>/calls` counters are operational telemetry with no monotonic
 * relationship to the bill, and `modelFromMetric` already keeps them out of AI
 * pricing structurally.
 */
export interface PlaidRate {
  provider: 'PLAID';
  /** The billable product line as the invoice names it. */
  product: PlaidBillableProduct;
  /** Inclusive YYYY-MM-DD. Applies to billing cycles starting on or after this. */
  effectiveFrom: string;
  usdPerItemMonth: number;
  source: string;
}

export type PlaidBillableProduct = 'transactions' | 'investments';

/**
 * ⚠️ ONE PERIOD OF EVIDENCE, AND THE RATES ARE SCOPED TO IT. These unit prices
 * are DERIVED from the single reconciled invoice, not read from a price sheet:
 *
 *   Transactions  $12.00 / 40 Item-months = $0.30   — independently confirmed by
 *                 the recorded orphan estimate, "9 orphans, ~$2.70/mo" (9 × $0.30)
 *   Investments   ($13.40 total − $12.00) / 4       = $0.35, forced by subtraction
 *
 * `effectiveFrom` is the cycle the evidence covers. Cycles before it are
 * UNPRICED — not zero — because no invoice evidences a rate for them, and
 * inventing one would fabricate provenance. A later cycle inherits these rates
 * only because no evidence yet contradicts them; a second invoice showing a
 * different unit price should be added as its own dated entry rather than
 * overwriting this one.
 */
export const PLAID_RATES: readonly PlaidRate[] = [
  { provider: 'PLAID', product: 'transactions', effectiveFrom: '2026-07-01', usdPerItemMonth: 0.30,
    source: 'invoice S-J7Y5657ZK0-2607 (Jul 2026): $12.00 Transactions / 40 Item-months; cross-checked against the recorded 9-orphan estimate of ~$2.70/mo' },
  { provider: 'PLAID', product: 'investments', effectiveFrom: '2026-07-01', usdPerItemMonth: 0.35,
    source: 'invoice S-J7Y5657ZK0-2607 (Jul 2026): ($13.40 total − $12.00 Transactions) / 4 Investments Item-months — derived by subtraction, not quoted' },
];

/**
 * The Plaid rate in force for a product on a billing cycle, or null when no
 * evidenced rate covers it.
 */
export function plaidRateAt(product: PlaidBillableProduct, cycleStart: string,
                            rates: readonly PlaidRate[] = PLAID_RATES): PlaidRate | null {
  let best: PlaidRate | null = null;
  for (const r of rates) {
    if (r.product !== product || r.effectiveFrom > cycleStart) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

/** True iff any rate is configured — drives whether a surface shows a figure at all. */
export function isPricingConfigured(): boolean {
  return AI_RATES.length > 0;
}

/**
 * The rate in force for a model ON a given day: the latest entry whose
 * `effectiveFrom` is on or before that day. Null when none was yet in force —
 * which is how usage predating our evidence stays honestly unpriced.
 */
export function rateAt(provider: string, model: string, onDay: string, rates: readonly AiRate[] = AI_RATES): AiRate | null {
  let best: AiRate | null = null;
  for (const r of rates) {
    if (r.provider !== provider || r.model !== model) continue;
    if (r.effectiveFrom > onDay) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

/**
 * The model a counter metric refers to, or null.
 *
 * ⚠️ THIS IS ALSO WHAT KEEPS PLAID OUT OF AI COST. A Plaid metric is a bare
 * method name (`transactionsSync`), so it never parses, is never priced, and can
 * never contribute a dollar — no allowlist, no special case. Plaid's billable
 * unit is the Item-subscription-month, not the call, and pricing its call
 * counters would invent a cost curve. That is Slice 4's problem, at its own grain.
 */
export function modelFromMetric(metric: string): string | null {
  const prefix = 'chat.completions:';
  return metric.startsWith(prefix) ? metric.slice(prefix.length) || null : null;
}

// ── The reducer ──────────────────────────────────────────────────────────────

/** An `ApiUsageCounter` row, in the shape every reader already selects. */
export interface UsageRowLike {
  provider: string;
  metric: string;
  unit: string;
  day: Date | string;
  count: number;
}

export interface PricedAiUsage {
  /** Estimated USD, or null when nothing in the input could be priced. */
  usd: number | null;
  /** Prompt + completion tokens that found a rate. */
  pricedTokens: number;
  /** Prompt + completion tokens with no rate in force on their day. */
  unpricedTokens: number;
  /** Days that carried token usage no rate covered — the coverage statement. */
  unpricedDays: string[];
}

const dayKey = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/**
 * Price a SET of counter rows, subset-aware.
 *
 * Rows are grouped by (provider, metric, day) because that is the finest grain at
 * which the rate is constant AND the whole group is needed for the subtraction.
 *
 *     input  = (prompt − cached) × inputRate + cached × cachedRate
 *     output = completion × outputRate
 *
 * ⚠️ `reasoning_tokens` IS DELIBERATELY NOT READ HERE. Reasoning tokens are
 * already inside `completion_tokens` and bill at the output rate; adding them
 * would double count. They are captured to EXPLAIN a bill, never to raise one.
 * `calls` likewise carries no price — a call is not a billable unit.
 */
export function priceAiUsage(rows: readonly UsageRowLike[], rates: readonly AiRate[] = AI_RATES): PricedAiUsage {
  interface Group { provider: string; model: string | null; day: string; prompt: number; cached: number; completion: number }
  const groups = new Map<string, Group>();

  for (const r of rows) {
    const day = dayKey(r.day);
    const key = `${r.provider}|${r.metric}|${day}`;
    const g = groups.get(key) ?? { provider: r.provider, model: modelFromMetric(r.metric), day, prompt: 0, cached: 0, completion: 0 };
    if (r.unit === 'prompt_tokens')             g.prompt     += whole(r.count);
    else if (r.unit === 'cached_prompt_tokens') g.cached     += whole(r.count);
    else if (r.unit === 'completion_tokens')    g.completion += whole(r.count);
    // 'calls' and 'reasoning_tokens' contribute no cost — see the header.
    groups.set(key, g);
  }

  let usd = 0, priced = 0, unpriced = 0, anyPriced = false;
  const unpricedDays = new Set<string>();

  for (const g of groups.values()) {
    const tokens = g.prompt + g.completion;
    if (tokens === 0) continue;
    const rate = g.model ? rateAt(g.provider, g.model, g.day, rates) : null;
    if (!rate) {
      unpriced += tokens;
      unpricedDays.add(g.day);
      continue;
    }
    // THE SUBTRACTION. Clamped so a contradictory pair cannot yield negative cost.
    const uncached = Math.max(0, g.prompt - g.cached);
    const cached = Math.min(g.cached, g.prompt);
    usd += (uncached * rate.usdPerMillion.input
          + cached   * rate.usdPerMillion.cachedInput
          + g.completion * rate.usdPerMillion.output) / 1_000_000;
    priced += tokens;
    anyPriced = true;
  }

  return {
    usd: anyPriced ? usd : null,
    pricedTokens: priced,
    unpricedTokens: unpriced,
    unpricedDays: [...unpricedDays].sort(),
  };
}
