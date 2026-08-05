/**
 * lib/transactions/provider-link-extract.ts   (Financial Truth — Transfer Authority, Phase 5)
 *
 * STAGE-1 EXTRACTORS — the only module that knows what any one institution's
 * descriptor looks like. Everything above it consumes `ProviderAssertedIdentity`
 * and never learns a pattern, exactly as `plaid-transfer-evidence.ts` already
 * establishes for rail/form/venue.
 *
 * Adding an institution is adding a REGISTRY ENTRY. The ladder, the validator
 * and every consumer are untouched. An institution with no entry yields no
 * evidence and no error — the same contract `plaid:no_signal` already uses.
 *
 * ── The registry IS the rollout gate ───────────────────────────────────────
 *
 * There is deliberately no separate feature flag. An extractor may only be
 * registered once its extraction rate AND precision have been measured on real
 * data, and the measurement is recorded beside it. An unmeasured institution has
 * no entry, which is indistinguishable from "disabled" and impossible to enable
 * by accident.
 *
 * ── Identifier, not name ───────────────────────────────────────────────────
 *
 * ⚠️ This module recognizes IDENTIFIERS ONLY — a correlation token, an account
 * mask. It must never extract an institution NAME, a person, a memo or a
 * counterparty string. That distinction is the whole reason descriptor evidence
 * is admissible here at all: `...9516` denotes exactly one account or none,
 * while `AMERICANEXPRESS` denotes an institution that issues both cards and
 * savings accounts. Measured over the live corpus: mask evidence made **250
 * claims with 0 errors**; institution-NAME routing resolved **0 legs on its own**.
 * Names may only SCOPE a candidate set (see the authority's scoping tier); they
 * may never resolve one, and this module must not tempt a future reader
 * otherwise.
 *
 * ⚠️ Extracted digits NEVER leave this module. A mask is resolved to an owned
 * account id here, or discarded. The four digits must not reach a
 * `classificationReason` (user-visible), a DTO, a log, or the AI payload.
 */

import { providerLinkKey, type ProviderAssertedIdentity } from "@/lib/transactions/provider-link";

/** Bump on any pattern change so a re-extraction is detectable and replayable. */
export const PROVIDER_LINK_EXTRACTOR_VERSION = "provider-link/1";

// ─── Correlation-token extractors, keyed by institution ──────────────────────

interface CorrelationExtractor {
  /** Stable id; also the namespace component of every key it produces. */
  id: string;
  /** Must capture the token in group 1. Anchored to an explicit label, never a
   *  bare number — a loose numeric pattern would group unrelated rows. */
  pattern: RegExp;
  /** How this was verified before registration. Required by convention. */
  measured: string;
}

/**
 * Institution id → its correlation extractors.
 *
 * ⚠️ Keyed by Plaid `institution_id`, NOT by display name. A display name is
 * user-editable and locale-dependent; `ins_56` is stable.
 */
const CORRELATION_EXTRACTORS: Record<string, readonly CorrelationExtractor[]> = {
  // Chase stamps one reference on BOTH legs of an internal transfer, in
  // `description`, in plaintext:
  //   "Online Transfer to   SAV ...9516 transaction#: 30039468383"   checking −1,000
  //   "Online Transfer from CHK ...2058 transaction#: 30039468383"   savings  +1,000
  ins_56: [{
    id: "chase/online-transfer",
    pattern: /transaction#:\s*(\d{6,})/i,
    // 132 rows · 66 distinct ids · EVERY group exactly 2 · all 66 cross-account,
    // opposite-sign, equal-amount, same-owner, same-currency, 0-day gap ·
    // 0 contradictions with the independently-derived authority (which agrees on
    // 72 of the 132) · 0 errors.
    measured: "V27 investigation, 2026-08-05: 66/66 groups valid, 0 contradictions, 0 errors",
  }],
  // American Express: MEASURED AND DELIBERATELY ABSENT. 147 transfer rows,
  // 0 carrying any correlation token (mean description length 30 chars vs Chase's
  // 49). This absence is the reference case for graceful degradation — the
  // authority must reach a correct answer for Amex with no E1 evidence at all.
};

// ─── Account-mask extraction (institution-agnostic) ─────────────────────────

/**
 * Mask patterns. Each REQUIRES an explicit account-reference marker before the
 * digits — a redaction run (`...`, `XXXX`, `****`), the words "ending in", the
 * word "account", or a product word followed by a separator.
 *
 * ⚠️ A bare four-digit token is NEVER matched. Descriptors are full of dates,
 * store numbers and amounts; matching them would produce exactly the fabricated
 * counterparties this arc has spent four slices removing.
 *
 * Deliberately NOT institution-scoped: the live corpus contains a Chase
 * descriptor naming an American Express account, and that pairing is correct.
 * Ownership — not institution — is the boundary.
 */
const MASK_PATTERNS: readonly RegExp[] = [
  /(?:\.{3}|X{3,}|x{3,}|\*{2,})\s*(\d{4})\b/g,          // "...9516" · "XXXXX2058" · "****1009"
  /\bending\s+in\s+(\d{4})\b/gi,                         // "card ending in 0202"
  /\baccount\s+(?:[A-Za-z*.#]*?)(\d{4})\b/gi,            // "DDA account XXXXX2058"
  /\b(?:CHK|SAV|SAVINGS|CHECKING|CARD)\s*[-–—]\s*(\d{4})\b/gi, // "Savings -5336"
];

export interface ProviderLinkExtractionContext {
  /** Plaid `institution_id` of the row's OWN account. Null ⇒ no correlation
   *  extractor applies; mask extraction still does. */
  institutionId: string | null;
  /**
   * Mask → owned account ids, WITHIN ONE OWNER. Built by the caller from
   * `FinancialAccount.mask`; a mask mapping to more than one account must be
   * present with all of them, so this module can ABSTAIN rather than pick.
   */
  maskToAccountIds: ReadonlyMap<string, readonly string[]>;
  /** The row's own account id — never its own counterparty. */
  selfAccountId: string;
}

export interface ExtractedProviderLinks {
  /**
   * A COUNTERPARTY-scope correlation identity, when the institution has a
   * registered extractor and the descriptor carries its token.
   */
  correlation: ProviderAssertedIdentity | null;
  /**
   * The owned account a descriptor MASK names, when it names exactly one.
   *
   * Null when: no mask marker present · the mask matches no owned account ·
   * the mask matches the row's own account only · **the mask is ambiguous
   * across two owned accounts** (abstain, never pick — 4-digit masks collide
   * within one user with probability 0.45% at 10 accounts and 4.3% at 30).
   */
  maskedAccountId: string | null;
  /** True when a mask marker resolved to MORE THAN ONE owned account. Reported
   *  so an abstention is visible in the census rather than looking like absence. */
  maskAmbiguous: boolean;
}

/**
 * Extract every provider-asserted identity from one row's descriptor.
 *
 * Pure and total. `descriptor` is the already-stored `merchant` + `description`
 * text; nothing else is read, and no denied Plaid field is touched.
 */
export function extractProviderLinks(
  descriptor: string,
  ctx: ProviderLinkExtractionContext,
): ExtractedProviderLinks {
  // ── Correlation token — institution-scoped ────────────────────────────────
  let correlation: ProviderAssertedIdentity | null = null;
  const extractors = ctx.institutionId ? CORRELATION_EXTRACTORS[ctx.institutionId] : undefined;
  for (const ex of extractors ?? []) {
    const m = descriptor.match(ex.pattern);
    if (!m?.[1]) continue;
    correlation = {
      scope:   "COUNTERPARTY",
      linkKey: providerLinkKey({
        institutionId: ctx.institutionId as string,
        extractorId:   ex.id,
        rawToken:      m[1],
      }),
      source:  ex.id,
      version: PROVIDER_LINK_EXTRACTOR_VERSION,
    };
    break; // first registered extractor wins; ids are namespaced so order is stable
  }

  // ── Account mask — ownership-scoped, abstains on ambiguity ───────────────
  const found = new Set<string>();
  for (const re of MASK_PATTERNS) {
    // `g` regexes carry lastIndex; matchAll is stateless per call.
    for (const m of descriptor.matchAll(re)) if (m[1]) found.add(m[1]);
  }
  const targets = new Set<string>();
  for (const mask of found) {
    for (const id of ctx.maskToAccountIds.get(mask) ?? []) {
      if (id !== ctx.selfAccountId) targets.add(id);
    }
  }
  const list = [...targets];
  return {
    correlation,
    maskedAccountId: list.length === 1 ? list[0] : null,
    maskAmbiguous:   list.length > 1,
  };
}

/**
 * Which institutions currently have a registered correlation extractor.
 * Read by the census/observability surface so provider-dependence stays
 * VISIBLE rather than becoming an invisible assumption.
 */
export function institutionsWithCorrelationExtractors(): string[] {
  return Object.keys(CORRELATION_EXTRACTORS).sort();
}
