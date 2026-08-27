/**
 * lib/ai/domain-relevance.ts
 *
 * CF-6 — WHICH DOMAINS THIS SPACE CAN LOAD, AND WHICH THIS QUESTION NEEDS.
 *
 * Pure and deterministic: no DB, no model, no clock. It is handed the CF-5
 * evidence census and the user's message and returns a domain list plus a
 * reason per decision.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * Measured through the production path at ed2dd93. A PERSONAL Space holding
 * three traditional-investment accounts, four digital-asset accounts, and
 * eleven live positions worth $24,021 was told, on EVERY question:
 *
 *     "No holdings data in this Space context — existing investments not
 *      visible here."
 *
 * Not because the data was missing, not because visibility forbade it, and not
 * because the assembler failed — running it directly returns eleven positions
 * in 110 ms. Because `getDomainManifest` keys on SpaceCategory, PERSONAL maps
 * to FINANCE_CORE, and FINANCE_CORE omits holdings. A label decided what
 * evidence existed.
 *
 * ── Three decisions that were one ───────────────────────────────────────────
 * The old resolver collapsed:
 *
 *   CAPABILITY    does the product have an assembler for this domain?
 *   AVAILABILITY  does this Space hold visible evidence of that kind?
 *   SELECTION     should THIS turn load it?
 *
 * into a single lookup on Space category. Each is a different question with a
 * different authority, and merging them means a Space cannot answer about data
 * it demonstrably holds.
 *
 *   CAPABILITY   → the assembler registry
 *   AVAILABILITY → the CF-5 coverage envelope (which already resolves
 *                  visibility through the canonical resolver)
 *   SELECTION    → this module, plus the manifest's defaults
 *
 * ── Why selection stays small ───────────────────────────────────────────────
 * CF-5 proved a great deal of evidence exists. Responding by loading all of it
 * on every question would turn a 21k-token prompt into a larger one and make
 * the retrieval problem worse, not better. So availability EXPANDS what a
 * question may reach and relevance decides whether it does — and a question
 * that does not ask about investments does not pay for them.
 *
 * This is deliberately not a planner. It answers one question — "does this
 * message concern a domain the manifest omits?" — with a keyword rule that can
 * be read in ten seconds, because the full retrieval plan is a later slice and
 * an under-built planner here would be harder to remove than to write.
 */

import { FinanceDomains, type ContextDomain } from '@/lib/ai/types';
import type { CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import {
  resolveConceptBreadth, breadthNeedsPositionDetail,
} from '@/lib/ai/economic-concepts';

/** Why a domain is in, or out of, this turn's set. */
export const DomainReasons = {
  /** The Space category's manifest includes it. Unchanged behaviour. */
  MANIFEST:       'MANIFEST',
  /** Not in the manifest, but evidence exists and the question needs it. */
  EVIDENCE:       'EVIDENCE',
  /** The question needs it, but this Space has no visible evidence of the kind. */
  NO_EVIDENCE:    'NO_EVIDENCE',
  /** Evidence exists, but nothing in the question calls for it. */
  NOT_RELEVANT:   'NOT_RELEVANT',
  /** The agent's explicit scope excludes it. A permission, not a default. */
  OUT_OF_SCOPE:   'OUT_OF_SCOPE',
} as const;

export type DomainReason = typeof DomainReasons[keyof typeof DomainReasons];

export interface DomainDecision {
  domain:   ContextDomain;
  included: boolean;
  reason:   DomainReason;
}

export interface DomainResolution {
  domains:   ContextDomain[];
  decisions: DomainDecision[];
}

/**
 * Domains the category manifest may omit, and what makes each one reachable.
 *
 * ⚠️ `hasEvidence` reads ACCOUNT presence, which is a proxy — the assembler
 * remains the authority on whether there is anything to say. Investment Club is
 * the case that proves the difference: five investment accounts, zero positions,
 * and `assembleHoldings` correctly returns null. That costs one 7 ms query and
 * no tokens, and the domain is simply absent — which is the honest outcome and
 * why a cheap proxy is the right signal here rather than a second census.
 */
interface ConditionalDomain {
  domain:      ContextDomain;
  hasEvidence: (env: CoverageEnvelope) => boolean;
  /** CF-7 — does this question's concept breadth need this domain's evidence? */
  relevant:    (question: string) => boolean;
}

/**
 * Does this question need the position spine?
 *
 * CF-7 — relevance is the CONCEPT layer's breadth resolver, so there is ONE
 * investment vocabulary rather than two that can drift apart. BROAD and
 * TRADITIONAL_ONLY need the spine; DIGITAL_ONLY does not.
 *
 * ⚠️ `holdings_summary` is the canonical POSITION spine and already spans
 * securities AND digital assets — measured on the real Space, $19,012 of its
 * $24,021 is BTC and SOL. A crypto-only question therefore does not need it:
 * everything that question wants is already in the accounts domain and the CF-5
 * envelope, and the spine would spend tokens to add nothing. The same overlap
 * is why `lib/ai/economic-concepts.ts` composes from account totals rather than
 * from this domain's own total.
 */
const needsPositionSpine = (question: string): boolean =>
  breadthNeedsPositionDetail(resolveConceptBreadth(question));

const CONDITIONAL_DOMAINS: ConditionalDomain[] = [
  {
    domain: FinanceDomains.HOLDINGS_SUMMARY,
    // Either class can produce positions: the spine holds securities and
    // digital assets alike, so a Space with only wallets still has holdings.
    hasEvidence: (env) => env.accounts.investments > 0 || env.accounts.digitalAssets > 0,
    relevant:    needsPositionSpine,
  },
];

/**
 * Resolve the domains for one turn.
 *
 * `manifest` still supplies the defaults — CF-6 does not remove the category's
 * say, it removes the category's VETO. A domain the manifest omits becomes
 * reachable when evidence exists and the question calls for it; a domain the
 * manifest includes is unaffected.
 *
 * `agentScope` remains a hard filter. It is an explicit permission boundary set
 * on the agent, not a default that a question may argue with.
 */
export function resolveDomains(input: {
  manifest:   readonly ContextDomain[];
  agentScope: readonly string[];
  /** CF-5's census. Absent → manifest-only behaviour, exactly as before CF-6. */
  evidence?:  CoverageEnvelope;
  /** The user's latest message. Absent → no relevance signal, so no expansion. */
  question?:  string;
}): DomainResolution {
  const { manifest, agentScope, evidence, question } = input;
  const decisions: DomainDecision[] = [];
  const scoped = (d: ContextDomain) => agentScope.length === 0 || agentScope.includes(d);

  const domains: ContextDomain[] = [];
  for (const d of manifest) {
    const ok = scoped(d);
    decisions.push({ domain: d, included: ok, reason: ok ? DomainReasons.MANIFEST : DomainReasons.OUT_OF_SCOPE });
    if (ok) domains.push(d);
  }

  if (!evidence || !question) return { domains, decisions };

  for (const c of CONDITIONAL_DOMAINS) {
    if (domains.includes(c.domain)) continue;          // already a manifest default

    if (!scoped(c.domain)) {
      decisions.push({ domain: c.domain, included: false, reason: DomainReasons.OUT_OF_SCOPE });
      continue;
    }
    // Relevance first: a Space with no investment evidence and a spending
    // question should report NOT_RELEVANT, not NO_EVIDENCE — the domain was
    // never wanted, and reporting absence would read as a finding about the
    // Space rather than about the question.
    if (!c.relevant(question)) {
      decisions.push({ domain: c.domain, included: false, reason: DomainReasons.NOT_RELEVANT });
      continue;
    }
    if (!c.hasEvidence(evidence)) {
      decisions.push({ domain: c.domain, included: false, reason: DomainReasons.NO_EVIDENCE });
      continue;
    }
    decisions.push({ domain: c.domain, included: true, reason: DomainReasons.EVIDENCE });
    domains.push(c.domain);
  }

  return { domains, decisions };
}
