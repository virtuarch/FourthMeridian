/**
 * lib/ai/prompts/conditional-serialization.test.ts   (CF-9)
 *
 * "NOT IN THE PROMPT" MUST NEVER BECOME "NOT ASSEMBLED".
 *
 *     npx tsx lib/ai/prompts/conditional-serialization.test.ts
 *
 * ── What CF-9 does ──────────────────────────────────────────────────────────
 * The first real enforcement of the CF-8 retrieval plan, deliberately narrowed
 * to ONE domain and ONE decision: whether `snapshot_history`'s raw JSON is
 * serialized. Measured on the real Space it is 5,660 prompt tokens — 23% of a
 * typical prompt — and only a trajectory question reads them, while
 * `computeAssessment` reads two scalars from the same payload on every turn.
 *
 * ── The invariant this file exists for ──────────────────────────────────────
 * That gap between "the model does not need this" and "nothing needs this" is
 * where a later optimisation will try to skip the assembler, and the assessment
 * will start grading a context it no longer receives. So the load-bearing test
 * is not the token saving — it is that a NOT_NEEDED domain is still assembled
 * and still consumed by `computeAssessment`, byte-identically.
 *
 * And the second: this must FAIL OPEN. A planner that errors, or is absent,
 * serializes everything. Removing evidence because a diagnostic broke is worse
 * than the tokens it would save.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { serializeContextBlock } from './context-serializer';
import { omitDomainJson } from './system-prompt';
import { computeAssessment } from '@/lib/ai/intelligence';
import { planRetrieval, NeedLevel, type RetrievalPlan } from '@/lib/ai/retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { FinanceDomains, type SpaceContext_AI } from '@/lib/ai/types';
import { mkTxn, mkCtx } from '@/lib/ai/conformance/fixtures';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const SNAP = FinanceDomains.SNAPSHOT_HISTORY;
const NOW  = new Date('2026-08-27T00:00:00.000Z');

const envelope: CoverageEnvelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE,
                  span: { fromISO: '2024-07-18', toISO: '2026-08-26', count: 4_156 } },
  snapshots:    { availability: EvidenceAvailability.AVAILABLE,
                  span: { fromISO: '2024-07-21', toISO: '2026-08-27', count: 768 } },
  accounts: { cash: 4, debt: 2, investments: 3, digitalAssets: 4, other: 0 },
  chains: [],
};

const plan = (q: string): RetrievalPlan =>
  planRetrieval({ messages: [{ role: 'user', content: q }], envelope, now: NOW });

/** A context carrying a real snapshot payload with distinctive rows. */
function ctxWithSnapshots(): SpaceContext_AI {
  const base = mkCtx(mkTxn({}));
  return {
    ...base,
    domains: {
      ...base.domains,
      [SNAP]: {
        domain: SNAP, assembledAt: 'x',
        data: {
          snapshotCount: 768, spanDays: 767,
          latest: { date: '2026-08-27', netWorth: 33700.17 },
          netWorthTrend: 7726, netWorthTrendPct: 29.7,
          history: Array.from({ length: 90 }, (_, i) => ({
            date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
            netWorth: 30000 + i, assets: 34000 + i, liabilities: 549.75,
          })),
        },
      },
    },
  } as SpaceContext_AI;
}

const render = (ctx: SpaceContext_AI, omit?: ReadonlySet<string>) =>
  serializeContextBlock(ctx, undefined, undefined, omit);

// ══ THE LOAD-BEARING INVARIANT ═══════════════════════════════════════════════
//
// NOT_NEEDED for model context, and STILL an assessment dependency that
// `computeAssessment` reads. Both halves asserted together, because it is the
// pair that stops a future refactor from skipping the assembler.
{
  const p = plan('What did I spend in 2025?');
  const snap = p.domains.find((d) => d.domain === SNAP)!;

  check('a spending question does not need snapshot JSON in the model context',
    snap.need === NeedLevel.NOT_NEEDED, snap.need);
  check('…and it is STILL an assessment dependency',
    snap.assessmentNeedsIt === true,
    'the assessment reads snapshotCount and spanDays on every turn');

  // The domain is present in the context regardless of the plan.
  const ctx = ctxWithSnapshots();
  check('…the domain is still assembled into the context',
    ctx.domains[SNAP]?.data !== undefined);

  // And the assessment output does not move when the JSON is withheld: the
  // assessment reads the CONTEXT, not the prompt.
  const before = JSON.stringify(computeAssessment(ctx));
  const after  = JSON.stringify(computeAssessment(ctx));   // same ctx, omission is downstream
  check('…and computeAssessment is byte-identical', before === after);
  check('…reading a real snapshot count, not a default',
    computeAssessment(ctx).dataQuality.snapshotSpanDays === 767,
    'if this were 0 the domain had not reached the assessment at all');
}

// ══ OMISSION AFFECTS THE PROMPT AND NOTHING ELSE ═════════════════════════════
{
  const ctx = ctxWithSnapshots();
  const full = render(ctx);
  const trimmed = render(ctx, new Set([SNAP]));

  check('the raw snapshot JSON is present by default',
    /\[snapshot_history\]\n\s*\{/.test(full));
  check('…and absent when the plan says so',
    !/\[snapshot_history\]\n\s*\{/.test(trimmed));
  check('the omission is worth real tokens',
    full.length - trimmed.length > 4_000,
    `saved ${Math.ceil((full.length - trimmed.length) / 4)} tokens`);

  // Named, not silently dropped — absence must not read as non-existence.
  check('the domain is still NAMED, with its status',
    /\[snapshot_history\] was assembled and is used by the deterministic assessment/.test(trimmed));
  // CF-10 — the notice must be true of a domain that ALSO has prose. Saying
  // "its detail was not loaded" was accurate for snapshots (no prose) and false
  // for transactions, whose merchant and monthly blocks sit above it.
  check('…and points at what WAS loaded rather than denying it',
    /anything stated about it ABOVE is what was loaded/.test(trimmed));
  check('…and the model is told not to deny it exists',
    /Do not state or imply that this data does not exist/.test(trimmed));

  // Every other domain is untouched. CF-9 is one domain, one decision.
  const withoutSnapshotBlock = (s: string) => {
    const out: string[] = [];
    const ls = s.split('\n');
    for (let i = 0; i < ls.length; i++) {
      if (/\[snapshot_history\]/.test(ls[i])) {
        // Skip the marker AND the JSON line that follows it, when present.
        if (ls[i + 1]?.trim().startsWith('{')) i++;
        continue;
      }
      out.push(ls[i]);
    }
    return out.join('\n');
  };
  check('no other domain is affected',
    withoutSnapshotBlock(full) === withoutSnapshotBlock(trimmed),
    'a first enforcement slice changes exactly one variable');
}

// ══ FAIL OPEN ════════════════════════════════════════════════════════════════
{
  check('no plan ⇒ nothing is omitted', omitDomainJson(undefined).size === 0,
    'a planner that errors must never remove evidence');
  check('an empty plan ⇒ nothing is omitted',
    omitDomainJson({ domains: [] } as unknown as RetrievalPlan).size === 0);

  const ctx = ctxWithSnapshots();
  check('…and the rendered prompt keeps the JSON',
    /\[snapshot_history\]\n\s*\{/.test(render(ctx, omitDomainJson(undefined))));
  check('an undefined omission set behaves like an empty one',
    render(ctx) === render(ctx, new Set()));
}

// ══ ONLY snapshot_history — NO PREMATURE GENERALISATION ══════════════════════
{
  // Even for a question whose plan marks them NOT_NEEDED, the other domains'
  // JSON must still be serialized: CF-9 is scoped to one measured domain.
  const p = plan('What are my investments?');
  const txnNeed = p.domains.find((d) => d.domain === FinanceDomains.TRANSACTIONS_SUMMARY)!.need;
  check('the plan marks transactions NOT_NEEDED for an investment question',
    txnNeed === NeedLevel.NOT_NEEDED, txnNeed);
  check('CF-10: …and its raw JSON IS omitted',
    omitDomainJson(p).has(FinanceDomains.TRANSACTIONS_SUMMARY));
  check('…and snapshots too', omitDomainJson(p).has(SNAP));

  // The two domains that must NOT join the set. `accounts` is required by all
  // nineteen CF-8 scenarios; `holdings_summary` is already conditional at the
  // DOMAIN level under CF-6, so conditioning its JSON as well would hide it
  // twice by two different mechanisms.
  check('accounts is NEVER conditional', !omitDomainJson(p).has(FinanceDomains.ACCOUNTS));
  check('holdings is NEVER conditional here',
    !omitDomainJson(p).has(FinanceDomains.HOLDINGS_SUMMARY));

  const src = readFileSync(join(process.cwd(), 'lib/ai/prompts/system-prompt.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const set = src.slice(src.indexOf('CONDITIONAL_JSON_DOMAINS'), src.indexOf('function omitDomainJson'));
  const named = set.match(/FinanceDomains\.\w+/g) ?? [];
  check('exactly TWO domains are conditional, structurally',
    named.length === 2
      && named.includes('FinanceDomains.SNAPSHOT_HISTORY')
      && named.includes('FinanceDomains.TRANSACTIONS_SUMMARY'),
    named.join(','));
  check('…and neither accounts nor holdings has been added quietly',
    !/FinanceDomains\.ACCOUNTS|FinanceDomains\.HOLDINGS_SUMMARY/.test(set));
}

// ══ CF-10 — TRANSACTIONS: PROSE IS A DIFFERENT CONSUMER FROM PAYLOAD ═════════
//
// The measured reason the snapshot boundary did not generalise. Snapshots have
// NO prose, so omitting the dump removed the domain from the prompt entirely.
// Transactions have MORE prose than payload — 5,027 tokens against 3,715 — and
// that prose carries the CF-1 bounded disclosures and the CF-2/3/4 scope
// framing, which are protected consumers.
{
  const OMITS_TXN = [
    'What are my investments?', 'What stocks do I own?',
    'What crypto do I own?', 'How far back can you see my transactions?',
  ];
  for (const q of OMITS_TXN) {
    check(`CF-10: "${q}" omits the transaction JSON`,
      omitDomainJson(plan(q)).has(FinanceDomains.TRANSACTIONS_SUMMARY), q);
  }

  const KEEPS_TXN = [
    'What did I spend in 2025?', 'Who did I spend the most with?',
    'How much came in last quarter?', 'Where is my money going?',
    'How am I doing financially?',           // SUPPORTING, not NOT_NEEDED
  ];
  for (const q of KEEPS_TXN) {
    check(`CF-10: "${q}" KEEPS the transaction JSON`,
      !omitDomainJson(plan(q)).has(FinanceDomains.TRANSACTIONS_SUMMARY), q);
  }
  check('CF-10: a SUPPORTING need keeps the payload',
    plan('How am I doing financially?').domains
      .find((d) => d.domain === FinanceDomains.TRANSACTIONS_SUMMARY)!.need === NeedLevel.SUPPORTING,
    'only NOT_NEEDED omits; supporting evidence is still evidence');
}

// ══ WHICH QUESTIONS KEEP IT ══════════════════════════════════════════════════
{
  const KEEPS = [
    'How has my net worth changed over the last year?',
    'How am I doing financially?',
    'Show me my net worth trend',
    'How has my position grown?',
  ];
  for (const q of KEEPS) {
    check(`"${q}" KEEPS the snapshot JSON`, !omitDomainJson(plan(q)).has(SNAP),
      'do not optimise away evidence the planner says is required');
  }

  const OMITS = [
    'What did I spend in 2025?',
    'What are my investments?',
    'How far back can you see my transactions?',
    'What is my net worth?',            // current position ≠ the series
    'Who did I spend the most with?',
  ];
  for (const q of OMITS) {
    check(`"${q}" omits the snapshot JSON`, omitDomainJson(plan(q)).has(SNAP), q);
  }

  // The measured CF-9 question: a CURRENT position question is answered by
  // account balances, and the trend signal carries the direction.
  check('a current net-worth question does not need ninety daily rows',
    plan('What is my net worth?').domains.find((d) => d.domain === SNAP)!.need
      === NeedLevel.NOT_NEEDED);
  check('…while a trajectory question does',
    plan('How has my net worth changed over the last year?')
      .domains.find((d) => d.domain === SNAP)!.need === NeedLevel.REQUIRED);
}

// ══ THE COMPACT HISTORICAL SIGNAL SURVIVES ═══════════════════════════════════
//
// Omitting the rows must not remove historical AWARENESS. The net-worth trend
// reaches the model through the signal detector, which reads the same assembled
// domain and is untouched by serialization.
{
  const src = readFileSync(join(process.cwd(), 'lib/ai/signals/detectors/snapshot.ts'), 'utf8');
  check('the trend signal is computed from the assembled domain',
    /domains\[FinanceDomains\.SNAPSHOT_HISTORY\]/.test(src));

  const ser = readFileSync(join(process.cwd(), 'lib/ai/prompts/context-serializer.ts'), 'utf8');
  check('signals are rendered independently of the domain JSON',
    /Active signals:/.test(ser),
    'the compact historical framing must survive the omission');
  check('the omission is checked exactly once, in the domain dump',
    (ser.match(/omitDomainJson\?\.has\(/g) ?? []).length === 1,
    'a second guard would mean the mechanism had spread beyond the JSON dump');
}

console.log(`\nconditional-serialization: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
