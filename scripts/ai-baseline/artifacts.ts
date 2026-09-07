/**
 * scripts/ai-baseline/artifacts.ts
 *
 * The index a human reads. Mechanical facts only.
 *
 * ⚠️ THE AUTOMATED METRICS ARE DELIBERATELY TINY: did the provider succeed, was
 * there an answer, how long, how many tokens, how many tool calls. No claim
 * extraction, no prose sweep, no rubric, no LLM judge. The transcripts are the
 * result; this file only makes them findable and comparable.
 */

import { writeFileSync } from 'fs';
import { join, basename } from 'path';
import type { CaseResult } from './run';
import { ARM_QUESTION, type Arm } from './evidence';
import { findProbe } from './probes';

export function writeIndex(
  runDir: string,
  runId: string,
  meta: { spaceId: string; spaceName: string; asOfISO: string },
  results: readonly CaseResult[],
): void {
  const probes = [...new Set(results.map((r) => r.probe))];
  const arms   = [...new Set(results.map((r) => r.arm))] as Arm[];
  const models = [...new Set(results.map((r) => r.model))];

  const L: string[] = [];
  L.push(`# AI conversation baseline — run \`${runId}\``, '');
  L.push(`**Space:** ${meta.spaceName} (\`${meta.spaceId}\`) · read-only · as of ${meta.asOfISO}`);
  L.push(`**Cases:** ${results.length} · **failed:** ${results.filter((r) => !r.ok).length}`, '');
  L.push('⚠️ Artifacts contain real balances and merchant names. `tmp/` is gitignored — keep it that way.', '');

  L.push('## Every case', '');
  L.push('| Probe | Arm | Model | Status | Latency | Prompt tok | Completion tok | Total tok | Tool calls | Round trips | Rate-limit retries | Artifact |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    L.push(`| ${r.probe} | ${r.arm} | \`${r.model}\` | ${r.ok ? 'ok' : '**error**'} | ` +
      `${(r.totals.latencyMs / 1000).toFixed(1)}s | ${r.totals.promptTokens} | ` +
      `${r.totals.completionTokens} | ${r.totals.totalTokens} | ${r.totals.toolCalls} | ` +
      `${r.totals.roundTrips} | ${r.totals.retries}${r.totals.retries ? ` (+${(r.totals.rateLimitWaitMs / 1000).toFixed(0)}s wait)` : ''} | ` +
      `\`${basename(r.artifactPath)}\` |`);
  }
  L.push('');

  L.push('## Human review', '');
  L.push('Open the artifact, read `turns[].assistant`, fill `humanReview` in the file.', '');
  L.push('| Field | 1–5 |'); L.push('|---|---|');
  for (const f of ['Accuracy', 'Relevance', 'Conversation', 'Conciseness', 'Judgment', 'Follow-up']) {
    L.push(`| ${f} | |`);
  }
  L.push('| Notes | |', '');

  // ── Dimension 1: evidence strategy (same probe + model, arms side by side) ──
  L.push('## Compare EVIDENCE ARMS — same probe, same model', '');
  L.push('The retrieval question. **A0 vs A1 is the highest-value comparison in the run.**', '');
  for (const model of models) {
    for (const probe of probes) {
      const row = arms.map((a) => results.find((r) => r.probe === probe && r.arm === a && r.model === model));
      if (row.every((r) => !r)) continue;
      L.push(`### \`${model}\` · ${probe}`, '');
      L.push('| Arm | What it asks | Tokens | Latency | Tool calls | Artifact |');
      L.push('|---|---|---|---|---|---|');
      for (const [i, r] of row.entries()) {
        if (!r) continue;
        L.push(`| ${arms[i]} | ${ARM_QUESTION[arms[i]]} | ${r.totals.totalTokens} | ` +
          `${(r.totals.latencyMs / 1000).toFixed(1)}s | ${r.totals.toolCalls} | \`${basename(r.artifactPath)}\` |`);
      }
      L.push('');
    }
  }

  // ── Dimension 2: model quality (same probe + arm, models side by side) ──────
  L.push('## Compare MODEL TIERS — same probe, same arm', '');
  for (const arm of arms) {
    for (const probe of probes) {
      const row = models.map((m) => results.find((r) => r.probe === probe && r.arm === arm && r.model === m));
      if (row.filter(Boolean).length < 2) continue;
      L.push(`### ${arm} · ${probe}`, '');
      L.push('| Model | Tokens | Latency | Tool calls | Artifact |');
      L.push('|---|---|---|---|---|');
      for (const [i, r] of row.entries()) {
        if (!r) continue;
        L.push(`| \`${models[i]}\` | ${r.totals.totalTokens} | ${(r.totals.latencyMs / 1000).toFixed(1)}s | ` +
          `${r.totals.toolCalls} | \`${basename(r.artifactPath)}\` |`);
      }
      L.push('');
    }
  }

  // ── The two called-out diagnostics ─────────────────────────────────────────
  const a0a1 = results.filter((r) => r.arm === 'A0' || r.arm === 'A1');
  if (a0a1.length > 0) {
    L.push('## Diagnostic — A0 vs A1 (does the assessment help or hurt?)', '');
    L.push('On this Space `computeAssessment` turns **$25.46 of liabilities with a null APR** into');
    L.push('`APR_MISSING_FOR_DEBT`, `DEBT_PAYOFF_BLOCKED_BY_DATA`, a blocked capital-allocation');
    L.push('recommendation, an `IMPROVE_DATA_QUALITY` opportunity, an `APR_REQUIRED_FOR_PRECISE_PAYOFF`');
    L.push('heuristic and an ungraded debt section. **A0 does not see any of that; A1 sees all of it.**', '');
    L.push('Read the `debt`, `broad` and `strategy` probes side by side and answer one question:', '');
    L.push('> Does A0 say something like *"you basically don\'t have debt"*, while A1 talks about');
    L.push('> missing APRs and blocked comparisons?', '');
    L.push('If A1 is worse, that is a finding, not a bug.', '');
  }

  const inv = results.filter((r) => r.probe === 'investments');
  if (inv.length > 0) {
    L.push('## Diagnostic — investment scope', '');
    L.push('The composition is ~79% digital assets. The position detail can price 4 of 13 positions');
    L.push('and reports a ~75% single-name concentration over **$11.62**, with its population attached.', '');
    L.push('- **Wrong:** "TTWO is 75% of your portfolio" / "your portfolio is highly concentrated in TTWO".');
    L.push('- **Acceptable:** leading with the composition; qualifying any narrow statistic by its population.', '');
    L.push('This is a test of SEMANTIC SCOPE, not of wording.', '');
  }

  const proj = results.filter((r) => r.probe === 'projection');
  if (proj.length > 0) {
    L.push('## Diagnostic — projection state and the two forecast paths', '');
    L.push('Eight turns, no state machine. Check that the $6k assumption survives *"February?"*,');
    L.push('that the bitcoin assumption stacks, and that *"what\'s actually realistic"* drops the');
    L.push('user\'s suppositions but keeps the evidence.', '');
    L.push('`project_cash` returns BOTH paths deliberately: the strictly-licensed one **refuses**');
    L.push('on this Space, the evidence-based projection answers. Watch which the model quotes and');
    L.push('whether it says which it used. **The harness does not choose for it.**', '');
  }

  L.push('## Probe notes (not sent to the model)', '');
  for (const p of probes) {
    const probe = findProbe(p);
    if (probe) L.push(`- **${probe.id}** — ${probe.whatItDiscriminates}`, '');
  }

  writeFileSync(join(runDir, 'INDEX.md'), `${L.join('\n')}\n`);
  writeFileSync(join(runDir, 'index.json'), `${JSON.stringify({ runId, meta, results }, null, 2)}\n`);
}
