/**
 * lib/transactions/merchant.ts
 *
 * Pure, deterministic merchant-name normalization (D6.3A-1 — Merchant
 * Intelligence foundation). No I/O, no DB, no LLM, no Plaid dependency: a
 * single pure function so the transactions assembler and any future
 * persistence tier share ONE canonicalization rule, mirroring the
 * lib/transactions/fingerprint.ts extraction pattern.
 *
 * Two outputs per raw merchant string:
 *   canonicalKey  — an UPPERCASED, punctuation/number-stripped grouping key.
 *                   Two rows whose raw merchant text collapses to the same key
 *                   are treated as the same merchant.
 *   canonicalName — a display-safe label derived from the same cleaned tokens
 *                   (title-cased only when the source is ALL-CAPS bank-feed
 *                   text; already-mixed-case names like "Netflix" are left
 *                   untouched).
 *
 * ── Design bias: CONSERVATIVE ────────────────────────────────────────────────
 * In a financial context it is worse to MERGE two genuinely different merchants
 * than to leave two spellings of one merchant split. So this only strips noise
 * that is unambiguously non-identifying:
 *   - a small allowlist of LEADING payment-processor / card-rail prefixes
 *     (SQ *, TST*, PAYPAL *, POS, ACH, CHECKCARD, DEBIT CARD PURCHASE, …)
 *   - store numbers (#1234), long digit/reference runs (>= 4 digits), and
 *     masked card tails (*1234 / xxxx1234).
 *
 * It deliberately does NOT strip city/state tokens. Removing a trailing state
 * code alone still leaves a differing city token (so it buys almost nothing),
 * and stripping the city as well would merge unrelated single-word merchants in
 * different locations. City/state canonicalization belongs to the later
 * persisted canonical-dictionary tier (Tier B), not this pure compute layer.
 *
 * The function NEVER returns an empty key or name — if stripping would empty the
 * string it falls back to the whitespace-collapsed original, so distinct inputs
 * can never all collapse onto one empty group.
 */

/**
 * Leading payment-processor / card-rail prefixes, matched case-insensitively at
 * the START of the string only. These identify the payment rail, not the
 * merchant, so removing them reveals the real merchant (e.g. "SQ *COFFEE BAR" →
 * "COFFEE BAR"). Kept intentionally tight to payment plumbing — brand
 * aggregators (GOOGLE *, AMZN MKTP) are excluded because stripping them changes
 * the merchant's meaning.
 */
const LEADING_PREFIXES: RegExp[] = [
  /^SQ\s*\*\s*/i,                       // Square
  /^TST\s*\*\s*/i,                      // Toast
  /^PAYPAL\s*\*\s*/i,                   // PayPal
  /^PP\s*\*\s*/i,                       // PayPal (short)
  /^PY\s*\*\s*/i,                       // Paymentus / generic
  /^POS\s+DEBIT\s+/i,                   // point-of-sale debit
  /^POS\s+/i,                           // point-of-sale
  /^ACH\s+(?:DEBIT|CREDIT)\s+/i,        // ACH debit/credit
  /^ACH\s+/i,                           // ACH
  /^CHECKCARD\s+/i,                     // debit "checkcard" descriptor
  /^DEBIT\s+CARD\s+PURCHASE\s+/i,       // verbose debit descriptor
  /^PURCHASE\s+AUTHORIZED\s+ON\s+\d{1,2}\/\d{1,2}\s+/i, // "PURCHASE AUTHORIZED ON 03/14 ..."
];

/**
 * A single whitespace token is "noise" (a store / reference / trace number, or
 * a masked card tail) and dropped from both key and display name. Short numbers
 * (<= 3 digits, e.g. "76", "7") are PRESERVED — they are often part of the
 * merchant's real name rather than a store id.
 */
function isNoiseToken(token: string): boolean {
  return (
    /^#\d+$/.test(token) ||        // "#1234" store number
    /^\d{4,}$/.test(token) ||      // "0099123" long numeric run
    /^\*+\d{2,}$/.test(token) ||   // "*1234" masked tail
    /^x{2,}\d+$/i.test(token)      // "xxxx1234" masked tail
  );
}

/** Strip a single leading processor prefix, repeatedly, until stable. */
function stripLeadingPrefixes(value: string): string {
  let out = value;
  // Cap iterations defensively; combos like "POS DEBIT ACH ..." are rare.
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const rx of LEADING_PREFIXES) {
      const next = out.replace(rx, '');
      if (next !== out) {
        out = next;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Trim stray separator punctuation left at the edges after stripping. */
function trimSeparators(value: string): string {
  return value.replace(/^[\s*\-/|.,]+/, '').replace(/[\s*\-/|.,]+$/, '').trim();
}

/** True when the string has capital letters but no lowercase letters. */
function isAllCaps(value: string): boolean {
  return /[A-Z]/.test(value) && !/[a-z]/.test(value);
}

/** Title-case ALL-CAPS bank-feed text for display; single-letter tokens kept. */
function toTitleCase(value: string): string {
  return value
    .split(' ')
    .map((w) =>
      w.length === 0
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');
}

export interface NormalizedMerchant {
  /** Uppercased grouping key. Never empty. */
  canonicalKey:  string;
  /** Display-safe name. Never empty. */
  canonicalName: string;
}

/**
 * Normalize a raw merchant string into a stable grouping key + display name.
 * Pure and deterministic — identical input always yields identical output.
 */
export function normalizeMerchant(raw: string): NormalizedMerchant {
  // Whitespace-collapsed original preserves case for display and is the ultimate
  // fallback so we never emit an empty key/name.
  const collapsed = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (collapsed === '') {
    return { canonicalKey: 'UNKNOWN', canonicalName: 'Unknown' };
  }

  // 1) Strip leading payment-processor prefixes (case-insensitive).
  const deprefixed = trimSeparators(stripLeadingPrefixes(collapsed));

  // 2) Drop store / reference / trace / masked-tail tokens.
  const kept = deprefixed
    .split(' ')
    .filter((t) => t.length > 0 && !isNoiseToken(t));

  // 3) Rebuild; fall back through progressively less-cleaned forms if empty so a
  //    string made only of noise tokens still gets a stable, non-empty group.
  const cleaned = trimSeparators(kept.join(' '));
  const displaySource = cleaned !== '' ? cleaned : deprefixed !== '' ? deprefixed : collapsed;

  const canonicalName = isAllCaps(displaySource) ? toTitleCase(displaySource) : displaySource;
  const canonicalKey  = canonicalName.toUpperCase();

  return { canonicalKey, canonicalName };
}
