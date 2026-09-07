/**
 * scripts/ai-conversation-baseline.ts
 *
 * MODEL-FIRST CONVERSATION BASELINE — CLI.
 *
 * The experiment from docs/plans/AI-CONVERSATION-INVESTIGATION.md §12: how LITTLE
 * architecture does Fourth Meridian need to produce the conversations in
 * docs/plans/AI-CONVERSATION-GOLDENS.md? Full contract:
 * docs/plans/AI-CONVERSATION-BASELINE-HARNESS.md.
 *
 *   npm run ai:chat                                 # interactive operator mode
 *   npm run ai:baseline -- --list
 *   npm run ai:baseline -- --probe projection --arm A0 --model mid
 *   npm run ai:baseline -- --probe projection --all-models
 *   npm run ai:baseline -- --arm A0 --model ceiling
 *   npm run ai:baseline -- --smoke                  # the 12 sanctioned cases
 *   npm run ai:baseline -- --all                    # 120 cases; must be asked for
 *
 * ⚠️ NOTHING RUNS WITHOUT AN EXPLICIT SELECTION. `--all` is 120 whole
 * conversations against a paid API; it is never the default and never implied.
 *
 * ⚠️ READ-ONLY AGAINST REAL FINANCIAL DATA. Every tool is a read or a pure
 * calculation. The Space is resolved explicitly and printed before anything runs.
 * Artifacts land under tmp/ (gitignored) because they contain real balances.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { todayUTCISO } from '@/lib/time/clock';
import { PROBES, PROBE_IDS } from './ai-baseline/probes';
import { ARMS, ARM_QUESTION, type Arm } from './ai-baseline/evidence';
import { runCase, supportsTools, type CaseResult } from './ai-baseline/run';
import { runInteractive } from './ai-baseline/interactive';
import { writeIndex } from './ai-baseline/artifacts';
import { createInterface } from 'readline/promises';
import type { SpaceContext } from '@/lib/space';

/**
 * The model tiers, chosen by probing the live API on 2026-09-07 rather than from
 * documentation. Recorded findings:
 *   gpt-4o-mini, gpt-4.1  classic params (max_tokens, temperature), tools OK
 *   gpt-5.x               max_completion_tokens, DEFAULT temperature only, tools OK
 *   gpt-5.6-*, gpt-6-*    tools REJECTED by /v1/chat/completions (Responses API only)
 * `frontier` is therefore usable on A0/A1 only, and the runner records why.
 */
export const TIERS: Record<string, string> = {
  control:  'gpt-4o-mini',   // the surviving production default
  mid:      'gpt-4.1',
  ceiling:  'gpt-5.5',       // strongest model that supports tools through this seam
  frontier: 'gpt-6-astra',   // no tools via chat.completions — A0/A1 only
};

const SMOKE_PROBES = ['projection', 'debt', 'investments'];

/**
 * The interactive default.
 *
 * ⚠️ THE SAME MODEL THE SMOKE RUN USED. A dogfooding session is only worth
 * anything beside the recorded transcripts, and it stops being comparable the
 * moment the default drifts to a different tier.
 */
const INTERACTIVE_DEFAULT_TIER = 'mid';

/** A raw model id, so an unlisted model stays reachable without free text passing through. */
const LOOKS_LIKE_MODEL_ID = /^(gpt|o\d|claude|chatgpt)[\w.-]*$/i;

/**
 * Ask which model to talk to.
 *
 * ⚠️ IT NAMES WHAT EACH ONE CANNOT DO. `gpt-6-astra` cannot call tools through
 * this seam, and the interactive mode is a TOOL arm — choosing it silently would
 * hand the operator a different experiment wearing the same label.
 */
async function chooseModel(preselected?: string): Promise<string> {
  if (preselected) return TIERS[preselected] ?? preselected;

  const keys = Object.keys(TIERS);
  console.log('\nModel:');
  keys.forEach((k, i) => {
    const m = TIERS[k];
    const dflt = k === INTERACTIVE_DEFAULT_TIER ? '  (default)' : '';
    const warn = supportsTools(m) ? '' : '  ⚠️  cannot call tools — not usable for this mode';
    console.log(`  ${i + 1}) ${k.padEnd(9)} ${m.padEnd(14)}${dflt}${warn}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let chosen = TIERS[INTERACTIVE_DEFAULT_TIER];
  try {
    // ⚠️ VALIDATED, BECAUSE UNVALIDATED FREE TEXT COST A WHOLE SESSION. Typing a
    // question at this prompt used to be accepted as a model id, and every turn
    // after it failed with `400 invalid model ID` while the prompt kept taking
    // input. An entry is now a listed number, a tier name, or a model id that
    // looks like one — anything else re-asks.
    for (;;) {
      const raw = (await rl.question(
        `\nChoose [1-${keys.length}, Enter for ${TIERS[INTERACTIVE_DEFAULT_TIER]}]: `)).trim();
      if (raw === '') break;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= keys.length) { chosen = TIERS[keys[n - 1]]; break; }
      if (TIERS[raw]) { chosen = TIERS[raw]; break; }
      if (LOOKS_LIKE_MODEL_ID.test(raw)) { chosen = raw; break; }
      console.log(`  ✗ "${raw.slice(0, 40)}" is not one of the listed options, a tier name, or a model id.`);
    }
  } finally {
    rl.close();
  }
  return chosen;
}

/**
 * Read `--name=value` OR `--name value`.
 *
 * ⚠️ BOTH FORMS, because the space-separated one is what anybody actually types
 * and the first version silently returned an empty selection for it — which
 * printed the usage text and looked like a typo rather than a parser bug.
 */
function flag(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const hit = process.argv[i];
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}
const has = (name: string) => process.argv.includes(`--${name}`);
const list = (raw: string | undefined) =>
  raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];

function usage(): void {
  console.log('\nFourth Meridian — model-first conversation baseline\n');
  console.log('Probes:');
  for (const p of PROBES) console.log(`  ${p.id.padEnd(14)} ${p.title}  (goldens ${p.goldens})`);
  console.log('\nArms:');
  for (const a of ARMS) console.log(`  ${a}  ${ARM_QUESTION[a]}`);
  console.log('\nModels:');
  for (const [k, v] of Object.entries(TIERS)) {
    console.log(`  ${k.padEnd(9)} ${v.padEnd(14)}${supportsTools(v) ? '' : '  (A0/A1 only — no tool support)'}`);
  }
  console.log(`
Interactive (arm A2 — thin core + tools, the same one the probes run):
  npm run ai:chat                    pick a model at startup, default gpt-4.1
  npm run ai:chat -- --model ceiling  skip the picker

Selection (nothing runs without one):
  --probe a,b        --all-probes
  --arm A0,A2        --all-arms
  --model mid,ceiling  (or a raw model id)   --all-models
  --smoke            projection+debt+investments × all arms × mid   (12 cases)
  --all              every probe × arm × tier                       (120 cases)
  --space <id>       override the Space (default: the PERSONAL Space with the most transactions)
  --dry-run          resolve and print the matrix, call no model
`);
}

async function resolveSpace(explicit?: string): Promise<{ spaceCtx: SpaceContext; agentId: string }> {
  const space = explicit
    ? await db.space.findUniqueOrThrow({ where: { id: explicit } })
    : await (async () => {
        // ⚠️ THE SPACE WITH THE MOST TRANSACTIONS, not the most accounts. The
        // seeded demo Spaces carry more account links than the real one and a
        // couple of hundred rows; the experiment is worthless against a fixture.
        // Deterministic, and printed before anything runs so the operator can
        // see what was chosen — pass --space to override.
        const candidates = await db.space.findMany({
          where: { type: 'PERSONAL', deletedAt: null, archivedAt: null },
          select: { id: true },
        });
        let best: { id: string; count: number } | null = null;
        for (const c of candidates) {
          const count = await db.transaction.count({
            where: { financialAccount: { spaceAccountLinks: { some: { spaceId: c.id } } } },
          });
          if (!best || count > best.count) best = { id: c.id, count };
        }
        if (!best) throw new Error('no PERSONAL Space found');
        return db.space.findUniqueOrThrow({ where: { id: best.id } });
      })();

  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId: space.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const agent = await db.aiAgent.findUnique({ where: { spaceId: space.id }, select: { id: true } });

  return {
    agentId: agent?.id ?? 'baseline-experiment',
    spaceCtx: {
      userId: owner.userId, spaceId: space.id, role: 'OWNER',
      permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
      space: { id: space.id, name: space.name, type: space.type, category: space.category,
        isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
    },
  };
}

async function main(): Promise<void> {
  if (has('list') || has('help') || process.argv.length <= 2) { usage(); return; }

  // ── Interactive operator mode ─────────────────────────────────────────────
  if (has('interactive') || has('chat')) {
    const { spaceCtx, agentId } = await resolveSpace(flag('space') || undefined);
    const asOfISO = todayUTCISO();
    const txnCount = await db.transaction.count({
      where: { financialAccount: { spaceAccountLinks: { some: { spaceId: spaceCtx.spaceId } } } },
    });
    console.log(`\nSpace: ${spaceCtx.space.name} (${spaceCtx.spaceId})  ${txnCount} transactions  [READ-ONLY]`);
    const model = await chooseModel(flag('model') || undefined);
    if (!supportsTools(model)) {
      console.error(`\n✗ ${model} cannot call tools through this provider seam, and this mode is a`);
      console.error('  tool arm. Pick another model rather than running a different experiment.\n');
      process.exitCode = 1;
      return;
    }
    const runDir = join(process.cwd(), 'tmp', 'ai-baseline',
      `interactive-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await runInteractive({ spaceCtx, agentId, asOfISO, model, runDir });
    return;
  }

  const smoke = has('smoke');
  const all   = has('all');

  const probes: string[] = all || has('all-probes') ? [...PROBE_IDS]
    : smoke ? SMOKE_PROBES
    : list(flag('probe'));
  const arms: Arm[] = (all || smoke || has('all-arms') ? [...ARMS]
    : list(flag('arm'))) as Arm[];
  const modelKeys: string[] = all || has('all-models') ? Object.keys(TIERS)
    : smoke ? ['mid']
    : list(flag('model'));

  if (probes.length === 0 || arms.length === 0 || modelKeys.length === 0) {
    console.error('\n✗ Nothing selected. Pass --probe/--arm/--model, or --smoke, or --all.\n');
    usage();
    process.exitCode = 1;
    return;
  }
  const badProbe = probes.find((p) => !PROBE_IDS.includes(p));
  if (badProbe) { console.error(`✗ unknown probe: ${badProbe}`); process.exitCode = 1; return; }
  const badArm = arms.find((a) => !ARMS.includes(a));
  if (badArm) { console.error(`✗ unknown arm: ${badArm}`); process.exitCode = 1; return; }

  const models = modelKeys.map((k) => TIERS[k] ?? k);

  const { spaceCtx, agentId } = await resolveSpace(flag('space') || undefined);
  const asOfISO = todayUTCISO();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(process.cwd(), 'tmp', 'ai-baseline', runId);

  const matrix: { probe: string; arm: Arm; model: string }[] = [];
  for (const probe of probes) for (const arm of arms) for (const model of models) {
    matrix.push({ probe, arm, model });
  }

  const txnCount = await db.transaction.count({
    where: { financialAccount: { spaceAccountLinks: { some: { spaceId: spaceCtx.spaceId } } } },
  });
  console.log(`\nSpace   : ${spaceCtx.space.name} (${spaceCtx.spaceId})  ${txnCount} transactions  [READ-ONLY]`);
  console.log(`As of   : ${asOfISO}`);
  console.log(`Probes  : ${probes.join(', ')}`);
  console.log(`Arms    : ${arms.join(', ')}`);
  console.log(`Models  : ${models.join(', ')}`);
  console.log(`Cases   : ${matrix.length}`);
  console.log(`Run dir : tmp/ai-baseline/${runId}\n`);

  if (has('dry-run')) { console.log('--dry-run: nothing called.\n'); return; }

  mkdirSync(runDir, { recursive: true });
  const results: CaseResult[] = [];
  for (const [i, cell] of matrix.entries()) {
    const label = `${String(i + 1).padStart(3)}/${matrix.length}  ${cell.probe.padEnd(14)} ${cell.arm}  ${cell.model.padEnd(13)}`;
    process.stdout.write(`${label} … `);
    try {
      const r = await runCase({ probeId: cell.probe, arm: cell.arm, model: cell.model,
        spaceCtx, agentId, asOfISO, runDir });
      results.push(r);
      console.log(`${r.ok ? 'ok ' : 'ERR'} ${(r.totals.latencyMs / 1000).toFixed(1)}s  ` +
        `${r.totals.totalTokens} tok  ${r.totals.toolCalls} tool call(s)`);
    } catch (err) {
      console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
      writeFileSync(join(runDir, `${cell.probe}__${cell.arm}__${cell.model}.error.json`),
        JSON.stringify({ ...cell, error: String(err) }, null, 2));
    }
  }

  writeIndex(runDir, runId, { spaceId: spaceCtx.spaceId, spaceName: spaceCtx.space.name, asOfISO }, results);
  console.log(`\nArtifacts: tmp/ai-baseline/${runId}/`);
  console.log(`Read     : tmp/ai-baseline/${runId}/INDEX.md\n`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await db.$disconnect();
    process.exit(1);
  });
