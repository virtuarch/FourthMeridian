/**
 * app/api/ai/chat/route-authority.aiarch.test.ts
 *
 * AI-ARCH boundary tripwires — the chat route must ORCHESTRATE, not own domain
 * intelligence, prompt-building, or financial-table reads. These are source
 * tripwires (house pattern; the route is a Next module that cannot export
 * arbitrary symbols for a runtime assertion), pinning the post-decomposition
 * architecture so a regression fails a test before it ships.
 *
 * Guarantees:
 *   1. The route performs NO raw financial-table read — every db.<model>.<op>
 *      access is limited to authorization (spaceMember) and audit (auditLog).
 *   2. The route does not re-import the debt data layer / assembler internals it
 *      used to query ad hoc; the per-liability rollup goes through the canonical
 *      intelligence module.
 *   3. Prompt serialization and message-analysis are consumed from their focused
 *      modules, not defined in the route.
 *   4. The prompt layer is deterministic-first: it imports no DB client, so no
 *      hidden financial calculation can leak into serialization.
 *   5. The route is materially thinned.
 *
 * Run from the repo root. Exits 0 on pass, 1 on failure.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

const ROOT = process.cwd();
const routeSrc = readFileSync(join(ROOT, 'app/api/ai/chat/route.ts'), 'utf8');

// ── 1. No raw financial-table reads — only spaceMember + auditLog ─────────────
{
  const ALLOWED = new Set(['spaceMember', 'auditLog']);
  const models = [...routeSrc.matchAll(/\bdb\.([a-zA-Z]+)\./g)].map((m) => m[1]);
  const disallowed = [...new Set(models)].filter((m) => !ALLOWED.has(m));
  check('route reads no financial tables (db.* limited to spaceMember + auditLog)',
    disallowed.length === 0,
    disallowed.length ? `found db.${disallowed.join(', db.')}` : '');
  // The removed redundant Space read must not reappear.
  check('route does not re-add the redundant db.space read',
    !/\bdb\.space\.findUnique/.test(routeSrc));
}

// ── 2. No ad-hoc domain data-layer / assembler imports in the route ───────────
{
  check('route does not import the debt data layer directly',
    !routeSrc.includes("from '@/lib/data/transactions'") &&
    !routeSrc.includes("from '@/lib/debt'"));
  check('route does not import assembler internals directly',
    !/from '@\/lib\/ai\/assemblers/.test(routeSrc));
  check('route does not import the money/conversion plumbing it no longer owns',
    !routeSrc.includes("from '@/lib/money/server-context'") &&
    !routeSrc.includes("from '@/lib/money/convert'"));
}

// ── 3. Canonical composition — consumes the focused modules ───────────────────
{
  check('per-liability rollup comes from the canonical intelligence module',
    routeSrc.includes("from '@/lib/ai/intelligence/debt-payments'") &&
    routeSrc.includes('fetchPerLiabilityDebtPayments('));
  check('context is assembled through buildContext (canonical assembler)',
    routeSrc.includes("from '@/lib/ai/context-builder'") &&
    routeSrc.includes('buildContext('));
  check('assessment comes from the canonical intelligence barrel',
    routeSrc.includes("from '@/lib/ai/intelligence'") &&
    routeSrc.includes('computeAssessment'));
  check('prompts are built by the prompt layer, not the route',
    routeSrc.includes("from '@/lib/ai/prompts/system-prompt'") &&
    routeSrc.includes('buildSpaceSystemPrompt(') &&
    routeSrc.includes('buildMasterSystemPrompt('));
  check('message analysis is consumed from its module',
    routeSrc.includes("from '@/lib/ai/chat/message-analysis'"));
  // The serializers must NOT be defined in the route anymore.
  check('route no longer DEFINES the prompt serializers',
    !/function serializeContextBlock\(/.test(routeSrc) &&
    !/function serializeAssessmentBlock\(/.test(routeSrc) &&
    !/const ADVISOR_PRINCIPLES\s*=/.test(routeSrc));
}

// ── 4. Deterministic-first: the prompt layer imports no DB client ─────────────
{
  const promptDir = join(ROOT, 'lib/ai/prompts');
  const files = readdirSync(promptDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const offenders = files.filter((f) => {
    const src = readFileSync(join(promptDir, f), 'utf8');
    return /from '@\/lib\/db'/.test(src) || /from '@\/lib\/prisma'/.test(src) || /\bprisma\b/.test(src);
  });
  check('prompt layer is DB-free (no hidden financial reads in serialization)',
    offenders.length === 0, offenders.join(', '));
  check('found the expected prompt modules', files.length >= 5, `only ${files.length} files`);
}

// ── 5. Route materially thinned ───────────────────────────────────────────────
{
  const loc = routeSrc.split('\n').length;
  check('route is materially thinned (was 2199 LOC; now < 700)', loc < 700, `${loc} LOC`);
}

if (failures.length > 0) {
  console.error(`\nAI-ARCH route authority: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`AI-ARCH route authority: all ${passed} checks passed.`);
process.exit(0);
