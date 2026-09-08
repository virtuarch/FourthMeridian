/**
 * scripts/ai-baseline/interactive.ts
 *
 * OPERATOR MODE — talk to the experimental system yourself.
 *
 * ⚠️ NOT A PRODUCT SURFACE, AND NOT A NEW EXPERIMENT. This is the A2 arm of the
 * existing baseline harness with a keyboard on the front: the same thin-core
 * evidence, the same ten tools, the same ~140-word instruction, the same turn
 * executor, and the same artifact shape the recorded runs produce. Nothing about
 * the system under test changes — which is the point, because a dogfooding
 * session that drifted from the batch runs would not be comparable with them.
 *
 * ⚠️ IT FIXES NOTHING. Every failure the smoke run recorded is still here: the
 * current-versus-future instant confusion when `investment_scenario` meets
 * `project_cash`, the licensed forecast's refusal, the assessment-free arm's
 * silence on trends. They are what there is to dogfood.
 *
 * Read-only against real financial data, exactly as the batch runner is.
 */

import { createInterface } from 'readline/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { assembleFullContext, buildEvidence, ARM_QUESTION } from './evidence';
import { openAiToolSchemas, type ToolContext } from './tools';
import { executeTurn, sumTurns, supportsTools, SYSTEM_INSTRUCTION, type TurnRecord } from './run';
import { compactToolHistory, DEFAULT_COMPACTION, type CompactionPolicy } from './compaction';
import type { SpaceContext } from '@/lib/space';

/** The arm this mode is. Fixed — choosing it per session would make sessions incomparable. */
const ARM = 'A2' as const;

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface InteractiveArgs {
  spaceCtx: SpaceContext;
  agentId:  string;
  asOfISO:  string;
  model:    string;
  runDir:   string;
  /** null disables context compaction. */
  compaction?: CompactionPolicy | null;
}

export async function runInteractive(args: InteractiveArgs): Promise<void> {
  const { spaceCtx, agentId, asOfISO, model, runDir } = args;
  const compaction = args.compaction === undefined ? DEFAULT_COMPACTION : args.compaction;

  const ctx = await assembleFullContext(spaceCtx, agentId);
  const evidence = await buildEvidence(ARM, ctx, spaceCtx.spaceId);

  // A2 is a tool arm. A model that cannot take tools would silently become a
  // different experiment, so it is stated rather than absorbed.
  const useTools = supportsTools(model);
  const toolSchemas = useTools ? openAiToolSchemas() : [];
  const toolCtx: ToolContext = { spaceCtx, spaceId: spaceCtx.spaceId, asOfISO };

  let messages: unknown[] = [
    { role: 'system', content: `${SYSTEM_INSTRUCTION}\n\nToday is ${asOfISO}.` },
  ];
  if (evidence.body) messages.push({ role: 'user', content: evidence.body });

  const startedAt = new Date();
  const sessionId = startedAt.toISOString().replace(/[:.]/g, '-');
  const artifactPath = join(runDir, `interactive__${ARM}__${model.replace(/[^\w.-]/g, '_')}.json`);
  mkdirSync(runDir, { recursive: true });

  const turns: TurnRecord[] = [];

  /**
   * ⚠️ WRITTEN AFTER EVERY TURN, not at the end. A dogfooding session ends by
   * being abandoned at least as often as it ends deliberately, and a transcript
   * that only survives a clean exit is a transcript that mostly does not survive.
   */
  const save = (): void => {
    writeFileSync(artifactPath, JSON.stringify({
      probe: {
        id: 'interactive',
        title: 'Operator session (free-form dogfooding)',
        whatItDiscriminates:
          'Nothing pre-declared — the turns are whatever the operator typed. Read it '
          + 'beside the recorded probe runs on the same arm and model.',
        goldens: 'n/a — free-form',
      },
      mode: 'interactive',
      sessionId,
      startedAt: startedAt.toISOString(),
      arm: ARM, armQuestion: ARM_QUESTION[ARM], model,
      compaction: compaction ?? null,
      toolsOffered: useTools
        ? toolSchemas.map((t) => (t as { function: { name: string } }).function.name) : [],
      toolsUnavailableReason: useTools
        ? null : `${model} does not support function tools via /v1/chat/completions`,
      spaceId: spaceCtx.spaceId, spaceName: spaceCtx.space.name, asOfISO,
      systemInstruction: SYSTEM_INSTRUCTION,
      evidence: {
        arm: evidence.arm, summary: evidence.summary,
        includesAssessment: evidence.includesAssessment,
        approxTokens: evidence.approxTokens, body: evidence.body,
      },
      turns,
      totals: sumTurns(turns),
      ok: turns.every((t) => !t.error),
      humanReview: {
        _instructions: 'Score 1–5. Leave blank until read. No automated scorer populates these.',
        accuracy: null, relevance: null, conversation: null,
        conciseness: null, judgment: null, followUp: null,
        notes: '',
        lookFor: 'Free-form session — judge it as a conversation, not against a probe.',
      },
    }, null, 2));
  };
  save();

  const acc = ctx.domains['accounts']?.data as
    { netWorth?: number; totalLiquid?: number } | undefined;

  console.log('');
  console.log('─'.repeat(72));
  console.log(`  Fourth Meridian — experimental assistant  ·  arm ${ARM}  ·  ${model}`);
  console.log('─'.repeat(72));
  console.log(`  Space      ${spaceCtx.space.name}   [READ-ONLY]`);
  if (acc?.netWorth !== undefined && acc?.totalLiquid !== undefined) {
    console.log(`  Position   net worth ${money(acc.netWorth)} · cash ${money(acc.totalLiquid)}`);
  }
  console.log(`  Evidence   ${evidence.summary}  (~${evidence.approxTokens} tok)`);
  console.log(`  Tools      ${useTools ? `${toolSchemas.length} available` : 'NONE — this model cannot call tools'}`);
  console.log(`  Context    ${compaction
    ? `raw tool results kept for the last ${compaction.retainCompletedTurns} completed turns, then elided`
    : 'no compaction — every tool payload is resent forever'}`);
  console.log(`  Transcript ${artifactPath.replace(`${process.cwd()}/`, '')}`);
  console.log('');
  console.log('  ⚠️  Experimental. Known failures are NOT fixed — see');
  console.log('     docs/plans/AI-CONVERSATION-BASELINE-HARNESS.md §14.');
  console.log('');
  console.log('  /tools   what the last turn called      /cost   tokens so far');
  console.log('  /exit    end the session (Ctrl-C also saves)');
  console.log('─'.repeat(72));
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl-C during a session should still leave a readable transcript.
  const onSigint = () => {
    console.log(`\n\nSaved: ${artifactPath.replace(`${process.cwd()}/`, '')}\n`);
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  for (;;) {
    let line: string;
    try {
      line = (await rl.question('you › ')).trim();
    } catch {
      break; // EOF
    }
    if (line === '') continue;

    if (line === '/exit' || line === '/quit') break;

    if (line === '/cost') {
      const t = sumTurns(turns);
      console.log(`\n  ${turns.length} turn(s) · ${t.promptTokens.toLocaleString()} in · `
        + `${t.completionTokens.toLocaleString()} out (${t.reasoningTokens.toLocaleString()} reasoning) · `
        + `${t.totalTokens.toLocaleString()} total · `
        + `${t.toolCalls} tool call(s) · ${(t.latencyMs / 1000).toFixed(1)}s`
        + `${t.retries ? ` · ${t.retries} rate-limit retry/retries (+${(t.rateLimitWaitMs / 1000).toFixed(0)}s)` : ''}\n`);
      continue;
    }

    if (line === '/tools') {
      const last = turns[turns.length - 1];
      if (!last || last.toolCalls.length === 0) { console.log('\n  (no tool calls on the last turn)\n'); continue; }
      console.log('');
      for (const c of last.toolCalls) {
        console.log(`  → ${c.name}(${JSON.stringify(c.arguments)})  ${c.latencyMs}ms`);
        console.log(`    ${JSON.stringify(c.result).slice(0, 600)}`);
      }
      console.log('');
      continue;
    }

    process.stdout.write('    …thinking\r');
    const rec = await executeTurn({
      messages, user: line, index: turns.length, model, toolSchemas, toolCtx,
      // The session already has an identity for its artifact; reuse it as the
      // opaque grouping key so a dogfood session's cost is summable (Slice 3).
      correlationId: `interactive:${sessionId}`,
    });
    turns.push(rec);
    // Only a completed turn is compacted; a failed one keeps its evidence.
    if (compaction && !rec.error) {
      const { messages: next, stats } = compactToolHistory(messages, compaction);
      messages = next;
      rec.compaction = stats;
    }
    save();
    process.stdout.write(' '.repeat(20) + '\r');

    if (rec.toolCalls.length > 0) {
      console.log(`    [${rec.toolCalls.map((c) => c.name).join(', ')}]`);
    }
    if (rec.error) {
      // ⚠️ A TURN THAT PRODUCED NO TEXT MUST SAY WHY. Two dogfood turns ended in
      // a blank line with no explanation; the reason was on the record and
      // nothing printed it.
      console.log(`\n  ⚠️  ${rec.error}`);
      if (rec.finishReason) console.log(`      finish_reason: ${rec.finishReason}`);
      console.log('');
    } else {
      console.log(`\n${rec.assistant ?? '(empty response)'}\n`);
    }
    const u = rec.usage;
    console.log(`    ${(rec.latencyMs / 1000).toFixed(1)}s`
      + (u ? ` · ${u.totalTokens.toLocaleString()} tok` : '')
      + (u?.reasoningTokens ? ` (${u.reasoningTokens.toLocaleString()} reasoning)` : '')
      + (rec.toolCalls.length ? ` · ${rec.toolCalls.length} call(s)` : '')
      + (rec.retries.length ? ` · ${rec.retries.length} retry` : '') + '\n');
  }

  process.off('SIGINT', onSigint);
  rl.close();
  save();

  const t = sumTurns(turns);
  console.log('');
  console.log('─'.repeat(72));
  console.log(`  ${turns.length} turn(s) · ${t.totalTokens.toLocaleString()} tokens · `
    + `${t.toolCalls} tool call(s) · ${(t.latencyMs / 1000).toFixed(1)}s`);
  console.log(`  Transcript: ${artifactPath.replace(`${process.cwd()}/`, '')}`);
  console.log('─'.repeat(72));
  console.log('');
}
