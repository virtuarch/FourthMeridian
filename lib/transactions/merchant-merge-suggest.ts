/**
 * lib/transactions/merchant-merge-suggest.ts
 *
 * Merchant Intelligence — MI2 S2 merge-candidate detector (PURE).
 *
 * A single, PURE, deterministic function that pairs duplicate Merchants from
 * data that already exists — it performs NO I/O, mints nothing, writes nothing,
 * and returns plain candidate objects. Identical input always yields identical
 * output (the house resolver/backfill purity pattern). The caller (the S2 review
 * orchestration) supplies the merchant facts it looked up in the DB; this module
 * never touches Prisma, the db client, AI, or the merge engine.
 *
 * ── What it produces (and what it never does) ────────────────────────────────
 * It emits CANDIDATE pairs with categorical evidence tiers. It NEVER auto-merges,
 * never persists, never suggests a denied pair. Suggestions are recomputed on
 * demand; only human DECISIONS are persisted (lib/transactions/
 * merchant-merge-decisions.ts). The deny-list runs FIRST — a denied pair is not
 * returned at any tier — because in a financial context wrongly proposing a merge
 * of two different businesses is the costly error.
 *
 * ── Signals implemented (S2 build-first: T1 + T2) ────────────────────────────
 *   T1  PLAID_ENTITY          — a transaction on merchant A carries a
 *                               merchantEntityId equal to merchant B's
 *                               plaidEntityId. The provider asserts one identity
 *                               where MI holds two. Near-zero false positives.
 *   T2  CANONICAL_CONTAINMENT — one canonicalKey is a leading-token prefix of the
 *                               other (≥2 shared leading tokens). The WGU
 *                               truncation class.
 * Weaker lexical (T3) and enrichment-domain signals are deliberately deferred.
 * MANUAL and AI candidates do not originate here — they are constructed by the
 * caller and flow through the SAME human-confirmed accept path; this module only
 * covers automated detection.
 *
 * Every candidate is still HUMAN-confirmed downstream. Tiers are categorical
 * (no numeric scores), each explainable to a person in one sentence.
 */

// ── Public evidence vocabulary ────────────────────────────────────────────────

/** Categorical confidence tier — strongest single signal wins. Never numeric. */
export type MergeEvidenceTier = "T1" | "T2" | "T3";

/** Which signal produced (or would produce) a candidate. */
export type MergeEvidenceSignal =
  | "PLAID_ENTITY"
  | "CANONICAL_CONTAINMENT"
  | "ALIAS_TOKEN"
  | "MANUAL"
  | "AI";

/** Injected facts for one merchant — everything the detector needs, no DB types. */
export interface MergeDetectorMerchant {
  id: string;
  canonicalKey: string;
  displayName: string;
  /** The merchant's own stable provider id, when known. */
  plaidEntityId?: string | null;
  /** Distinct provider entity ids OBSERVED on this merchant's transactions. */
  observedEntityIds?: readonly string[];
}

/** A proposed pair. `deniedReason` set ⇒ excluded from results (never shown). */
export interface MergeCandidate {
  /** The pre-selected survivor (least-truncated / provider-preferred). Operator may flip. */
  survivorKey: string;
  survivorId: string;
  /** The merchant proposed for absorption. */
  absorbedKey: string;
  absorbedId: string;
  tier: MergeEvidenceTier;
  signal: MergeEvidenceSignal;
  /** One human sentence a reviewer can act on. */
  explanation: string;
}

// ── Deny-list (runs BEFORE tiering) ───────────────────────────────────────────

/**
 * Aggregator / rail / marketplace prefixes whose SHARED PREFIX is precisely the
 * non-evidence: two different service suffixes of the same aggregator
 * (GOOGLE *Fi vs GOOGLE *Cloud) must never be paired. Matched case-insensitively
 * at the START of a canonicalKey. Kept tight and static (S2); expansion is a
 * later slice, tested more heavily than matching (deny-list is the priority).
 */
const DENY_PREFIXES: readonly string[] = [
  "GOOGLE",
  "APPLE",
  "AMZN",
  "AMAZON",
  "PAYPAL",
  "META",
  "SQ ",
  "SQUARE",
  "TST",
  "TOAST",
  "STRIPE",
];

/** Normalize a key for prefix/token comparison — collapse spaces, uppercase. */
function tokens(key: string): string[] {
  return key.trim().toUpperCase().split(/\s+/).filter(Boolean);
}

/** True when a canonicalKey begins with a denied aggregator/rail/marketplace prefix. */
function hasDenyPrefix(key: string): boolean {
  const up = key.trim().toUpperCase();
  return DENY_PREFIXES.some((p) => up === p.trim() || up.startsWith(p.toUpperCase()));
}

/**
 * The deny reason for a pair, or null when the pair is allowed to be tiered.
 * Denied classes (S2 subset, computable from identity alone):
 *   • self-pair (same id)
 *   • either side begins with an aggregator/rail/marketplace deny-prefix
 *   • single-token canonical keys for LEXICAL signals (SHELL, DELTA) — provider
 *     evidence (T1) may still pair them, so this denial applies to T2 only and is
 *     checked at the T2 site, not here.
 * Person/P2P-descriptor denial needs flow data not injected in S2 and is a
 * documented extension point (see header) — not yet enforced here.
 */
function denyReason(a: MergeDetectorMerchant, b: MergeDetectorMerchant): string | null {
  if (a.id === b.id) return "self-pair";
  if (hasDenyPrefix(a.canonicalKey) || hasDenyPrefix(b.canonicalKey)) {
    return "aggregator/rail/marketplace prefix — shared prefix is non-evidence";
  }
  return null;
}

// ── Tier signals ──────────────────────────────────────────────────────────────

/**
 * T2 — canonical containment (the WGU truncation class): the shorter key is a
 * string prefix of the longer one, AND they share ≥2 leading FULL tokens. The
 * string-prefix condition catches a final-token truncation ("WESTERN GOVERNORS
 * UN" ⊂ "WESTERN GOVERNORS UNIVERSITY") as well as a clean token-boundary prefix
 * ("COSTCO WHOLESALE" ⊂ "COSTCO WHOLESALE CORP"). The ≥2-shared-leading-full-
 * token guard denies single-token spurious matches (a bare "SHELL" ⊂ "SHELL GAS"
 * is not evidence). The longer (least-truncated) key is the survivor. Returns
 * null when not a containment pair.
 */
function canonicalContainment(
  a: MergeDetectorMerchant,
  b: MergeDetectorMerchant,
): { survivor: MergeDetectorMerchant; absorbed: MergeDetectorMerchant } | null {
  const sa = tokens(a.canonicalKey).join(" ");
  const sb = tokens(b.canonicalKey).join(" ");
  if (sa === sb) return null; // identical (can't happen — canonicalKey is unique)
  const [shortM, longM, shortS, longS] =
    sa.length <= sb.length ? [a, b, sa, sb] : [b, a, sb, sa];
  if (!longS.startsWith(shortS)) return null; // shorter must be a prefix of longer

  // Count shared LEADING full tokens; ≥2 required (the differing final token is
  // the truncation and is not counted).
  const shortT = tokens(shortM.canonicalKey);
  const longT = tokens(longM.canonicalKey);
  let shared = 0;
  for (let i = 0; i < shortT.length; i++) {
    if (shortT[i] === longT[i]) shared++;
    else break;
  }
  if (shared < 2) return null;

  return { survivor: longM, absorbed: shortM };
}

/**
 * T1 — provider entity-id contradiction: merchant A carries an observed
 * transaction entityId equal to merchant B's own plaidEntityId. Directional:
 * the merchant that OWNS the entityId (B) is the survivor. Returns null when no
 * contradiction exists between the ordered pair (a → b).
 */
function entityContradiction(
  a: MergeDetectorMerchant,
  b: MergeDetectorMerchant,
): { survivor: MergeDetectorMerchant; absorbed: MergeDetectorMerchant } | null {
  if (!b.plaidEntityId) return null;
  const observed = a.observedEntityIds ?? [];
  if (observed.includes(b.plaidEntityId) && a.plaidEntityId !== b.plaidEntityId) {
    return { survivor: b, absorbed: a };
  }
  return null;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Detect merge candidates among a set of merchants. Pure and deterministic.
 * Deny-list first; then T1 (provider entity id) dominates T2 (containment) for
 * any given pair. Each unordered pair yields at most one candidate — the
 * strongest tier. Output is sorted deterministically (tier, then keys).
 */
export function suggestMerchantMerges(
  merchants: readonly MergeDetectorMerchant[],
): MergeCandidate[] {
  const out: MergeCandidate[] = [];

  for (let i = 0; i < merchants.length; i++) {
    for (let j = i + 1; j < merchants.length; j++) {
      const a = merchants[i];
      const b = merchants[j];
      if (denyReason(a, b)) continue;

      // T1 — provider evidence, checked in both directions (either may own the id).
      const t1 = entityContradiction(a, b) ?? entityContradiction(b, a);
      if (t1) {
        out.push({
          survivorKey: t1.survivor.canonicalKey,
          survivorId: t1.survivor.id,
          absorbedKey: t1.absorbed.canonicalKey,
          absorbedId: t1.absorbed.id,
          tier: "T1",
          signal: "PLAID_ENTITY",
          explanation: `Your bank identifies "${t1.absorbed.displayName}" and "${t1.survivor.displayName}" as the same business.`,
        });
        continue; // strongest tier wins for this pair
      }

      // T2 — structural containment (the WGU truncation class).
      const t2 = canonicalContainment(a, b);
      if (t2) {
        out.push({
          survivorKey: t2.survivor.canonicalKey,
          survivorId: t2.survivor.id,
          absorbedKey: t2.absorbed.canonicalKey,
          absorbedId: t2.absorbed.id,
          tier: "T2",
          signal: "CANONICAL_CONTAINMENT",
          explanation: `"${t2.absorbed.displayName}" looks like a truncation of "${t2.survivor.displayName}".`,
        });
      }
    }
  }

  // Deterministic order: T1 before T2, then by survivor then absorbed key.
  const tierRank: Record<MergeEvidenceTier, number> = { T1: 0, T2: 1, T3: 2 };
  out.sort(
    (x, y) =>
      tierRank[x.tier] - tierRank[y.tier] ||
      x.survivorKey.localeCompare(y.survivorKey) ||
      x.absorbedKey.localeCompare(y.absorbedKey),
  );
  return out;
}
