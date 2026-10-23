/**
 * lib/ai/evidence-authorities.test.ts  (RLS-AI-S10)
 *
 * THE PROOF THAT THE SPACE-PROBE THEOREM IS STILL TRUE.
 *
 * `adjudicateAbsence()` licenses an absence sentence about every empty read in a
 * turn from ONE `Space` probe. That is sound only while every evidence source the
 * AI graph reads belongs to a policy family the probe can adjudicate. This file
 * re-derives the real predicates from the committed migration SQL and fails the
 * build when they stop matching — so the theorem cannot quietly become false while
 * `adjudicateAbsence()` stays syntactically correct.
 *
 * ⚠️ IT PARSES THE MIGRATION, NOT THE REGISTRY'S OWN PROSE. A test that compared
 * the registry against itself would prove nothing; the whole point is that the
 * authority lives in `prisma/migrations/**`, which this slice may read and may not
 * change.
 *
 * ⚠️ AND IT DISCOVERS READS THROUGH RELATIONS, NOT JUST DELEGATE CALLS. The
 * authority audit this programme already shipped was blind to dynamic imports and
 * to a second import on a `.match()` first-match-only scan; the same class of
 * blindness here is the nested `select`. `SpaceAccountLink.addedByUser` reaches
 * `User` — a NON-Space-granular table — and no scan for `client.user.findMany`
 * would ever see it.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_EVIDENCE_AUTHORITIES, EVIDENCE_LEAF_MODULES, FAMILY_PREDICATE, PolicyFamily,
  SPACE_ADJUDICABLE, DECLARED_NARROWING_COUNT, AMBIGUOUS_RELATIONS,
} from './evidence-authorities';

const ROOT = process.cwd();
const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n     ${detail}`}`);
  assert.ok(ok, `${name}${detail ? `\n  ${detail}` : ''}`);
};

/** Comments quote the defects they closed, so the scan must read CODE. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ───────────────────────────────────────────────────────────────────────────
// 1. DERIVE the real fm_app SELECT predicate for every table, from the SQL.
// ───────────────────────────────────────────────────────────────────────────

const MIGRATIONS = join(ROOT, 'prisma', 'migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_rls/.test(d) || /^\d{14}_tenancy/.test(d))
    .sort()
    .map((d) => {
      try { return readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8'); }
      catch { return ''; }
    })
    .join('\n');
}

const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
/** Strip the outermost redundant parens the migration's formatting adds. */
function unwrap(s: string): string {
  let out = squash(s);
  while (out.startsWith('(') && out.endsWith(')')) {
    let depth = 0, closedEarly = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') { depth--; if (depth === 0 && i < out.length - 1) { closedEarly = true; break; } }
    }
    if (closedEarly) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

/** Read a balanced parenthesised group starting at `from` (which must be `(`). */
function balanced(src: string, from: number): { body: string; end: number } | null {
  if (src[from] !== '(') return null;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return { body: src.slice(from + 1, i), end: i }; }
  }
  return null;
}

/**
 * Every table whose fm_app SELECT policy is written by a `FOREACH t IN ARRAY …`
 * loop, mapped to that loop's USING expression (with `%I` already substituted).
 */
function derivePredicates(sql: string): Map<string, string> {
  const out = new Map<string, string>();

  // (a) DO-blocks: ARRAY[ … ] + a format($f$CREATE POLICY … FOR SELECT TO fm_app USING (…)$f$, t)
  for (const m of sql.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END LOOP;/g)) {
    const tables = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
    const body = m[2];
    const sel = body.match(/CREATE POLICY\s+\w+\s+ON\s+public\.%I\s+FOR SELECT\s+TO fm_app\s+USING\s*/);
    if (!sel) continue; // a loop that only GRANTs (the global-reference family)
    const at = body.indexOf('USING', sel.index!) + 'USING'.length;
    const open = body.indexOf('(', at);
    const bal = balanced(body, open);
    if (!bal) continue;
    for (const t of tables) out.set(t, unwrap(bal.body));
  }

  // (b) Individually written policies.
  const re = /CREATE POLICY\s+\w+\s+ON\s+public\."([A-Za-z]+)"\s+FOR SELECT\s+TO fm_app\s+USING\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const open = sql.indexOf('(', m.index + m[0].length - 1);
    const bal = balanced(sql, open);
    if (bal) out.set(m[1], unwrap(bal.body));
  }
  return out;
}

/** Tables that are GRANTed to fm_app and never have RLS enabled: global reference. */
function deriveGlobalReference(sql: string): Set<string> {
  const rlsOn = new Set<string>();
  for (const m of sql.matchAll(/ALTER TABLE public\."([A-Za-z]+)" ENABLE ROW LEVEL SECURITY/g)) rlsOn.add(m[1]);
  for (const m of sql.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END LOOP;/g)) {
    if (!/ENABLE ROW LEVEL SECURITY/.test(m[2])) continue;
    for (const x of m[1].matchAll(/'([A-Za-z]+)'/g)) rlsOn.add(x[1]);
  }
  const granted = new Set<string>();
  for (const m of sql.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END LOOP;/g)) {
    if (!/GRANT SELECT[^;]*TO fm_app/.test(m[2])) continue;
    for (const x of m[1].matchAll(/'([A-Za-z]+)'/g)) granted.add(x[1]);
  }
  return new Set([...granted].filter((t) => !rlsOn.has(t)));
}

const SQL = migrationSql();
check('the RLS migration SQL is readable and non-trivial', SQL.length > 10_000, `${SQL.length} bytes`);

const PREDICATE = derivePredicates(SQL);
const GLOBAL = deriveGlobalReference(SQL);

// The parser must be proven to WORK before its silence means anything — the
// recorded failure mode in this programme is a scan that reported clean over
// zero call sites.
check('the migration parser found the Space-granular family',
  PREDICATE.get('SpaceSnapshot') === '"spaceId" IN (SELECT fm_visible_space_ids())',
  String(PREDICATE.get('SpaceSnapshot')));
check('the migration parser found the account-subtree family',
  PREDICATE.get('Transaction') === 'fm_account_visible("financialAccountId")',
  String(PREDICATE.get('Transaction')));
check('the migration parser found an INDIVIDUALLY written policy',
  PREDICATE.get('FinancialAccount') === '"ownerUserId" = current_fm_user_id() OR fm_account_visible("id")',
  String(PREDICATE.get('FinancialAccount')));
check('the migration parser found the GLOBAL REFERENCE set (no RLS, granted)',
  GLOBAL.has('FxRate') && GLOBAL.has('Instrument') && GLOBAL.has('Merchant')
    && !GLOBAL.has('Transaction'),
  [...GLOBAL].join(','));

// ───────────────────────────────────────────────────────────────────────────
// 2. THE THEOREM: every registered model's family matches the real predicate.
// ───────────────────────────────────────────────────────────────────────────

const mismatches: string[] = [];
const unadjudicable: string[] = [];
for (const [model, a] of Object.entries(AI_EVIDENCE_AUTHORITIES)) {
  if (a.family === PolicyFamily.GLOBAL_REFERENCE) {
    if (!GLOBAL.has(model)) mismatches.push(`${model}: claimed GLOBAL_REFERENCE but RLS is enabled on it`);
    continue;
  }
  if (a.family === PolicyFamily.SPACE_ROOT) {
    const p = PREDICATE.get(model) ?? '';
    // ⚠️ PINNED TO ITS EXACT THREE ARMS, AND THE SECOND TWO ARE WHY THE ORACLE NO
    // LONGER READS THIS TABLE. `"isPublic" = true` and the platform-grant arm are
    // NOT membership, so `Space` visibility does not imply child-row visibility.
    // A FOURTH arm appearing here must be classified before anyone relies on
    // `Space` for anything, so this is an equality and not a prefix match.
    const SPACE_SEL_ARMS = '"id" IN (SELECT fm_visible_space_ids())'
      + ' OR "isPublic" = true'
      + ' OR ("platformArea" IS NOT NULL AND EXISTS (SELECT 1 FROM "PlatformGrant" g'
      + ' WHERE g."userId" = current_fm_user_id() AND g.status = \'ACTIVE\''
      + ' AND g.area = "Space"."platformArea"))';
    if (p !== SPACE_SEL_ARMS) {
      mismatches.push(`${model}: the Space SELECT policy changed shape. The absence oracle's `
        + `soundness argument quotes it, so a new arm must be classified before anything relies `
        + `on it.\n       expected: ${SPACE_SEL_ARMS}\n       actual:   ${p}`);
    }
    continue;
  }
  const real = PREDICATE.get(model);
  if (real === undefined) {
    // Not RLS-protected and not in the global set ⇒ fm_app has no SELECT policy
    // at all on it, which the registry must not have claimed a family for.
    mismatches.push(`${model}: no fm_app SELECT policy found in the migrations`);
    continue;
  }
  const expected = FAMILY_PREDICATE[a.family];
  if (a.family === PolicyFamily.NOT_SPACE_ADJUDICABLE) {
    // A declared narrowing must still be OUTSIDE every adjudicable family — if a
    // migration later made it Space-granular, the declaration is stale and the
    // entry should be re-classified rather than left scaring future readers.
    const adjudicableShapes = SPACE_ADJUDICABLE
      .map((f) => FAMILY_PREDICATE[f]).filter((x): x is string => x !== null);
    if (adjudicableShapes.includes(real)) {
      mismatches.push(`${model}: declared NOT_SPACE_ADJUDICABLE but its policy is now "${real}" — reclassify it`);
    }
    continue;
  }
  if (expected !== real) mismatches.push(`${model}: family ${a.family} expects "${expected}" but the migration says "${real}"`);
}

check('every registered evidence source\'s FAMILY matches its real migration predicate',
  mismatches.length === 0, mismatches.join('\n     '));

for (const [model, a] of Object.entries(AI_EVIDENCE_AUTHORITIES)) {
  if (!(SPACE_ADJUDICABLE as readonly string[]).includes(a.family)
      && a.family !== PolicyFamily.NOT_SPACE_ADJUDICABLE) {
    unadjudicable.push(`${model}: ${a.family} is neither adjudicable nor a declared narrowing`);
  }
}
check('every family is either Space-adjudicable or an EXPLICIT declared narrowing',
  unadjudicable.length === 0, unadjudicable.join('\n     '));

const declared = Object.entries(AI_EVIDENCE_AUTHORITIES)
  .filter(([, a]) => a.family === PolicyFamily.NOT_SPACE_ADJUDICABLE);
check('every declared narrowing says what it COSTS, in a sentence',
  declared.every(([, a]) => (a.narrowing ?? '').length > 80),
  declared.filter(([, a]) => (a.narrowing ?? '').length <= 80).map(([m]) => m).join(','));
check('no adjudicable entry carries a narrowing sentence it does not need',
  Object.entries(AI_EVIDENCE_AUTHORITIES)
    .filter(([, a]) => a.family !== PolicyFamily.NOT_SPACE_ADJUDICABLE)
    .every(([, a]) => a.narrowing === undefined));
check('the declared-narrowing count is PINNED — a new one is a deliberate decision',
  declared.length === DECLARED_NARROWING_COUNT,
  `${declared.length} declared, pin says ${DECLARED_NARROWING_COUNT}: ${declared.map(([m]) => m).join(',')}`);

// ───────────────────────────────────────────────────────────────────────────
// 3. DISCOVERY: nothing the AI tree reads may be missing from the registry.
// ───────────────────────────────────────────────────────────────────────────

/** Prisma relation FIELD name → the model(s) it can reach. Derived from the schema. */
function relationMap(): Map<string, string[]> {
  const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  const models = new Set<string>();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) models.add(m[1]);
  const rel = new Map<string, Set<string>>();
  for (const blk of schema.split(/^model\s+/m).slice(1)) {
    for (const line of blk.split('\n')) {
      const m = line.match(/^\s{2}(\w+)\s+(\w+)(\[\])?\??\s/);
      if (!m || !models.has(m[2])) continue;
      if (!rel.has(m[1])) rel.set(m[1], new Set());
      rel.get(m[1])!.add(m[2]);
    }
  }
  return new Map([...rel].map(([k, v]) => [k, [...v]]));
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'fixtures') continue;
    if (e.isDirectory()) out.push(...tsFilesUnder(join(dir, e.name)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(join(dir, e.name));
  }
  return out;
}

const REL = relationMap();
/**
 * ⚠️ THE CLIENT ALIASES ARE NAMED EXPLICITLY AND `c` IS NOT ONE OF THEM. A first
 * draft included it and matched `c.fixedAmounts.count` in scenario-rules.ts,
 * inventing a Prisma model called `FixedAmounts`. A scan that reports a table
 * nobody reads is as useless as one that misses a table somebody does: it trains
 * the reader to add entries to silence it.
 */
const DELEGATE = /\b(?:client|tx|db|systemDb|prisma)\.([a-z][A-Za-z0-9]*)\.(?:findMany|findFirst|findUnique|findUniqueOrThrow|aggregate|groupBy|count)\b/g;
/** A relation name used as a key inside a select/include object literal. */
const RELATION_KEY = /(?:^|[\s{,])([a-zA-Z][A-Za-z0-9]*)\s*:\s*\{\s*(?:select|where|include|orderBy|some|every|none)\b/g;

const scanned = [...tsFilesUnder('lib/ai'), ...EVIDENCE_LEAF_MODULES];
const unclassified = new Map<string, string>();
const ambiguousUndeclared = new Map<string, string>();
let delegateHits = 0, relationHits = 0;

for (const f of scanned) {
  let src: string;
  try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  // Comments carry prose about tables that are NOT read; strip them so the scan
  // measures code. (This file's own header names PlaidItem and CreditScore.)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const m of code.matchAll(DELEGATE)) {
    delegateHits++;
    const model = m[1][0].toUpperCase() + m[1].slice(1);
    if (!(model in AI_EVIDENCE_AUTHORITIES)) unclassified.set(model, `${f} (delegate ${m[1]})`);
  }
  for (const m of code.matchAll(RELATION_KEY)) {
    const targets = REL.get(m[1]);
    if (!targets) continue;
    relationHits++;
    // An ambiguous relation name must have a DECLARED resolution; see
    // AMBIGUOUS_RELATIONS for why this is not guessed.
    if (targets.length > 1) {
      const decl = AMBIGUOUS_RELATIONS[m[1]];
      if (!decl) { ambiguousUndeclared.set(m[1], `${f}: resolves to ${targets.join(' | ')}`); continue; }
      if (!targets.includes(decl.model)) {
        ambiguousUndeclared.set(m[1], `${f}: declared ${decl.model}, schema says ${targets.join(' | ')}`);
        continue;
      }
      if (!(decl.model in AI_EVIDENCE_AUTHORITIES)) unclassified.set(decl.model, `${f} (relation ${m[1]})`);
      continue;
    }
    if (!(targets[0] in AI_EVIDENCE_AUTHORITIES)) unclassified.set(targets[0], `${f} (relation ${m[1]})`);
  }
}

// ⚠️ THE SCAN MUST BE PROVEN TO SEE THINGS BEFORE ITS SILENCE COUNTS.
check('the delegate scan found reads at all', delegateHits > 15, `${delegateHits} delegate reads`);
check('the RELATION scan found nested selects at all', relationHits > 5, `${relationHits} relation keys`);
check('the relation scan resolves addedByUser → User (the read a delegate grep CANNOT see)',
  (REL.get('addedByUser') ?? []).includes('User'), JSON.stringify(REL.get('addedByUser')));

check('every AMBIGUOUS relation name the graph uses has a DECLARED resolution',
  ambiguousUndeclared.size === 0,
  [...ambiguousUndeclared].map(([r, w]) => `${r} at ${w}`).join('\n     '));
check('the declared ambiguity resolution is the one the graph actually needs',
  AMBIGUOUS_RELATIONS.connections?.model === 'AccountConnection',
  JSON.stringify(AMBIGUOUS_RELATIONS.connections));

check('every model the AI evidence graph reads is CLASSIFIED in the registry',
  unclassified.size === 0,
  [...unclassified].map(([m, w]) => `${m} read at ${w}`).join('\n     '));

// The ratchet's own integrity: a named leaf module that has vanished is a stale
// pin, and a stale pin is how a ratchet silently stops ratcheting.
const missingLeaves = EVIDENCE_LEAF_MODULES.filter((f) => {
  try { readFileSync(join(ROOT, f), 'utf8'); return false; } catch { return true; }
});
check('every pinned evidence leaf module still exists', missingLeaves.length === 0, missingLeaves.join(','));

// ───────────────────────────────────────────────────────────────────────────
// 4. THE ASSEMBLERS HOLD NO CLIENT OF THEIR OWN (RLS-AI-S6).
// ───────────────────────────────────────────────────────────────────────────

const assemblerSrcs = tsFilesUnder('lib/ai/assemblers')
  .map((f) => [f, readFileSync(join(ROOT, f), 'utf8')] as const);
const holdsDb = assemblerSrcs.filter(([, s]) =>
  /^\s*import\s*\{[^}]*\b(?:db|systemDb)\b[^}]*\}\s*from\s*['"]@\/lib\/db['"]/m.test(s));
check('no assembler imports a Prisma client — the authority can only arrive as a parameter',
  holdsDb.length === 0, holdsDb.map(([f]) => f).join(','));
check('…and that scan goes RED when violated',
  /^\s*import\s*\{[^}]*\b(?:db|systemDb)\b[^}]*\}\s*from\s*['"]@\/lib\/db['"]/m
    .test("import { db } from '@/lib/db';"),
  'the scan matched nothing — it would have reported clean over a real import');

const COVERAGE = stripComments(readFileSync(join(ROOT, 'lib/ai/coverage-envelope.ts'), 'utf8'));
check('the coverage census holds no Prisma client, and has no `?? db` default',
  !/from ['"]@\/lib\/db['"]/.test(COVERAGE) && !/\?\?\s*db\b/.test(COVERAGE));

// ⚠️ THE `?? db` SCAN IS PROVEN TO BITE. The default it exists to catch was the
// quietest escape in the graph, so a scan that could not see one would be worse
// than no scan at all.
check('…and the `?? db` scan goes RED when violated',
  /\?\?\s*db\b/.test('const client = options?.client ?? db;'));

const LEAVES_WITH_NO_DEFAULT = [
  'lib/investments/current-positions.ts', 'lib/investments/valuation.ts',
  'lib/transactions/transfer-resolution.ts',
];
const stillDefaulting = LEAVES_WITH_NO_DEFAULT.filter((f) =>
  /\?\?\s*db\b/.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))));
check('no leaf converted by this slice still defaults its authority to `db`',
  stillDefaulting.length === 0, stillDefaulting.join(','));

const EVIDENCE = readFileSync(join(ROOT, 'lib/ai/conversation/evidence.ts'), 'utf8');
// ⚠️ THIS ASSERTION WENT STALE WITHIN THE SLICE THAT WROTE IT, which is the
// argument for pinning the PROPERTY and not the spelling. It read
// `client: ReadClient,` until the prologue stopped being one transaction: the
// authority is now a RUNNER (`read: PhasedRead`), because a client IS a
// transaction and one transaction round the whole prologue measured 5,906 ms
// against the 5 s default. What must hold is that the authority is the FIRST
// parameter and is REQUIRED — not which of the two shapes it has.
check('assembleFullContext takes its authority as the FIRST parameter, and requires it',
  /assembleFullContext\(\s*\n?\s*(?:read: PhasedRead|client: ReadClient),/.test(EVIDENCE),
  (EVIDENCE.match(/assembleFullContext\([\s\S]{0,60}/) ?? ['?'])[0]);
check('buildEvidence takes BOTH authorities as runners, and requires both',
  /buildEvidence\(\s*\n\s*read: PhasedRead,/.test(EVIDENCE)
    && /memoryRead: MemoryPhasedRead,/.test(EVIDENCE));
// ⚠️ AND NO FALLBACK CLIENT SURVIVED THE CONVERSION. A `readClient` left on this
// module would be the ambient authority wearing a parameter's clothes.
check('the evidence layer holds no client and no `?? db` fallback of its own',
  !/from ['"]@\/lib\/db['"]/.test(stripComments(EVIDENCE))
    && !/\?\?\s*db\b/.test(stripComments(EVIDENCE)));

console.log(results.join('\n'));
console.log(`\n[evidence-authorities] ${Object.keys(AI_EVIDENCE_AUTHORITIES).length} sources classified · `
  + `${declared.length} declared narrowing(s) · ${delegateHits} delegate reads + ${relationHits} relation keys scanned`);
