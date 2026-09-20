/**
 * lib/ai/brief/contract.ts
 *
 * THE BRIEF'S OUTPUT CONTRACT — the schema the provider enforces, and the checks
 * it cannot.
 *
 * ⚠️ `strict: true` BINDS SHAPE, NOT SIZE. Every property is required and extras
 * are refused at the provider; lengths, counts and whether an evidence path means
 * anything are not expressible there, so they are checked here. A narration that
 * breaks a structural limit is REJECTED, not trimmed: silently keeping the first
 * three of five observations would publish a ranking the model did not make.
 *
 * ⚠️ AN OBSERVATION MUST REST ON THE PACKAGE. Evidence paths that resolve to
 * nothing are stripped; an observation left with no evidence is dropped. A path
 * into a window the package did not measure (`recentChanges.m1` on a three-week
 * history) cannot resolve, so it cannot be cited.
 */

import {
  IMPORTANCE, OBSERVATION_KINDS,
  type BriefAccountClass, type BriefNarration, type BriefObservation, type BriefPackage,
} from './types';

export const HEADLINE_MAX_CHARS = 140;
export const TITLE_MAX_CHARS = 80;
export const BODY_MAX_CHARS = 280;
export const MAX_OBSERVATIONS = 3;
export const MAX_EVIDENCE_PATHS = 6;

export const BRIEF_SCHEMA = {
  name: 'daily_brief',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'quiet', 'observations'],
    properties: {
      headline: { type: 'string', description: `One sentence, at most ${HEADLINE_MAX_CHARS} characters.` },
      quiet: { type: 'boolean', description: 'True when nothing in the evidence calls for attention.' },
      observations: {
        type: 'array',
        description: `0 to ${MAX_OBSERVATIONS}, most important first.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title', 'body', 'importance', 'evidence'],
          properties: {
            kind: { type: 'string', enum: [...OBSERVATION_KINDS] },
            title: { type: 'string', description: `At most ${TITLE_MAX_CHARS} characters.` },
            body: { type: 'string', description: `At most ${BODY_MAX_CHARS} characters.` },
            importance: { type: 'string', enum: [...IMPORTANCE] },
            evidence: {
              type: 'array', items: { type: 'string' },
              description: 'Dot paths into the evidence package, e.g. "recentChanges.w1.liquid".',
            },
          },
        },
      },
    },
  },
} as const;

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Shape and size. Returns the typed narration or every problem found. */
export function validateNarration(
  raw: unknown,
): { ok: true; value: BriefNarration } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['narration is not an object'] };
  }
  const r = raw as Record<string, unknown>;

  if (!isStr(r.headline) || r.headline.trim() === '') problems.push('headline is missing');
  else if (r.headline.length > HEADLINE_MAX_CHARS) problems.push(`headline exceeds ${HEADLINE_MAX_CHARS} chars`);
  if (typeof r.quiet !== 'boolean') problems.push('quiet is not a boolean');
  if (!Array.isArray(r.observations)) {
    problems.push('observations is not an array');
  } else {
    if (r.observations.length > MAX_OBSERVATIONS) problems.push(`more than ${MAX_OBSERVATIONS} observations`);
    r.observations.forEach((o, i) => {
      const ob = (o ?? {}) as Record<string, unknown>;
      if (!OBSERVATION_KINDS.includes(ob.kind as never)) problems.push(`observation ${i}: unknown kind`);
      if (!IMPORTANCE.includes(ob.importance as never)) problems.push(`observation ${i}: unknown importance`);
      if (!isStr(ob.title) || ob.title.trim() === '') problems.push(`observation ${i}: title missing`);
      else if (ob.title.length > TITLE_MAX_CHARS) problems.push(`observation ${i}: title exceeds ${TITLE_MAX_CHARS} chars`);
      if (!isStr(ob.body) || ob.body.trim() === '') problems.push(`observation ${i}: body missing`);
      else if (ob.body.length > BODY_MAX_CHARS) problems.push(`observation ${i}: body exceeds ${BODY_MAX_CHARS} chars`);
      if (!Array.isArray(ob.evidence) || !ob.evidence.every(isStr)) problems.push(`observation ${i}: evidence is not a string list`);
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: raw as unknown as BriefNarration };
}

/** The value at a dot path ("a.b.0.c" or "a.b[0].c"), or undefined. */
export function resolveEvidencePath(pkg: BriefPackage, path: string): unknown {
  if (!isStr(path) || path.trim() === '') return undefined;
  const segments = path.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = pkg;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/**
 * True when an observation rests only on data freshness.
 *
 * The page shows when each source last updated and which connections need
 * attention, deterministically and for as long as the problem lasts. A generated
 * observation that only restates that would say the same warning twice — and, on
 * the next day, say it again as if it were new.
 */
export function onlyReportsFreshness(ob: BriefObservation): boolean {
  // `claimEvidence` is freshness too — per claim rather than per Space.
  return ob.evidence.length > 0 && ob.evidence.every((p) => /^(freshness|claimEvidence)(\.|\[|$)/.test(p.trim()));
}

/** Flow types that are movements of the user's own money, never spending. */
const NOT_SPENDING_FLOWS = new Set(['DEBT_PAYMENT', 'TRANSFER', 'INVESTMENT']);

/**
 * True when a SPENDING observation cites a movement that is not spending.
 *
 * Code owns what a flow type IS: a debt payment or a transfer between the user's
 * own accounts cited as spending is a mislabel whatever the prose says.
 */
export function citesNonSpendingAsSpending(ob: BriefObservation, pkg: BriefPackage): boolean {
  if (ob.kind !== 'SPENDING') return false;
  return ob.evidence.some((p) => {
    const m = /^recentActivity\.top(?:\.|\[)(\d+)/.exec(p.trim());
    if (!m) return false;
    const row = pkg.recentActivity?.top[Number(m[1])];
    return !!row && (NOT_SPENDING_FLOWS.has(row.flow) || row.betweenOwnAccounts === true);
  });
}

/**
 * The account class whose balance a package path measures, or null when the path
 * is not a single-class balance (net worth spans all of them; behavior averages
 * and plans are not balances).
 */
function balanceClassOf(path: string): BriefAccountClass | null {
  const p = path.trim().replace(/\[(\d+)\]/g, '.$1');
  if (/^(currentState|recentChanges\.[^.]+)\.debt(\.|$)/.test(p) || /^behavior\.debt(Rate|Burden)(\.|$)/.test(p)) return 'LIABILITY';
  if (/^(currentState|recentChanges\.[^.]+)\.liquid(\.|$)/.test(p) || /^behavior\.liquidity(\.|$)/.test(p)) return 'LIQUID';
  if (/^currentState\.(investments|concentration)(\.|$)/.test(p)
    || /^recentChanges\.[^.]+\.(investments|digitalAssets)(\.|$)/.test(p)) return 'ASSET';
  return null;
}

/**
 * True when an observation ties a movement to a balance it did not touch.
 *
 * ⚠️ CAUSALITY NEEDS EVIDENCE, AND THE EVIDENCE IS WHERE THE ROW POSTED. An
 * observation that rests on a single-class balance (debt, cash, investments) AND
 * on a recent movement is associating them. Code can check that: a row's
 * `account` says which class of account it posted on. A hotel charge on a
 * LIQUID account is not part of a rise in card debt, however close in time; on a
 * LIABILITY account it is. A row that is one leg of a movement between the
 * user's own accounts touches both sides and is always allowed.
 *
 * ⚠️ ONLY A KNOWN MISMATCH FIRES. A row with no `account` (class not known, or a
 * package built without the lookup) establishes nothing and refuses nothing here
 * — the instruction tells the model not to connect it, and this guard does not
 * guess. No merchant, category or flow is special-cased.
 */
export function associatesUnconnectedMovement(ob: BriefObservation, pkg: BriefPackage): boolean {
  const classes = new Set(ob.evidence.map(balanceClassOf).filter((c): c is BriefAccountClass => c !== null));
  if (classes.size === 0) return false;
  return ob.evidence.some((p) => {
    const m = /^recentActivity\.top(?:\.|\[)(\d+)/.exec(p.trim());
    if (!m) return false;
    const row = pkg.recentActivity?.top[Number(m[1])];
    return !!row && row.account !== undefined && row.betweenOwnAccounts !== true && !classes.has(row.account);
  });
}
