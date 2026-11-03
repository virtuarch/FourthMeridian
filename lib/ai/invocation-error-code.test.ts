/**
 * lib/ai/invocation-error-code.test.ts  (S2 P8 #2 — the ledger error-code shape)
 *
 * `AiInvocation.errorCode` is a CODE, never free text. `code()` used to trim and
 * clip to 64 characters but accept anything, so provider prose in `err.code`
 * reached the ledger (#331 fixed only the display). Now `code()` accepts only
 * `/^[A-Za-z0-9_.:-]{1,64}$/` and stores `"error"` otherwise.
 *
 *   1. unit: prose, over-long, empty, valid
 *   2. classification falls through a prose `e.code` to the status / class name
 *   3. the failure writer stores the gated value
 *   4. CENSUS: every write of the ledger error-code field goes through `code()`
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/invocation-error-code.test.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  code, classifyAiFailure, recordAiInvocationFailure,
  AI_LEDGER_ERROR_CODE_SHAPE, AI_LEDGER_ERROR_CODE_FALLBACK,
} from './invocation';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = join(__dirname, '..', '..');

async function main() {
  console.log('1. code() — the shape gate');
  {
    check('the fallback is "error"', AI_LEDGER_ERROR_CODE_FALLBACK === 'error');
    check('prose → "error"', code('You exceeded your current quota, please check your plan.') === 'error');
    check('prose with a prompt fragment → "error"', code('bad request: "my salary is"') === 'error');
    check('a URL with a query → "error"', code('https://example.test/x?y=1') === 'error');
    check('a newline → "error"', code('rate_limit\nretry') === 'error');
    check('65 identifier chars (over-long) → "error"', code('a'.repeat(65)) === 'error');
    check('64 identifier chars → kept whole', code('a'.repeat(64)) === 'a'.repeat(64));
    check('empty string → null (nothing written)', code('') === null);
    check('blank string → null', code('   ') === null);
    check('undefined / null / object → null', code(undefined) === null && code(null) === null && code({}) === null);
    check('NaN → null', code(Number.NaN) === null);
    for (const ok of ['insufficient_quota', 'rate_limit_exceeded', '429', 'AI_PAUSED', 'UNPRICED_MODEL', 'TypeError', 'attempt:2', 'context_length.exceeded', 'ERR-1']) {
      check(`valid "${ok}" → itself`, code(ok) === ok);
    }
    check('a finite number → its string', code(503) === '503');
    check('surrounding whitespace is trimmed before the check', code('  abort  ') === 'abort');
    check('the shape is exactly /^[A-Za-z0-9_.:-]{1,64}$/', AI_LEDGER_ERROR_CODE_SHAPE.source === '^[A-Za-z0-9_.:-]{1,64}$');
  }

  console.log('\n2. classification never returns prose');
  {
    const err = (over: Record<string, unknown>) => Object.assign(new Error('msg'), over);
    const prose = 'The server had an error while processing your request. Sorry about that!';
    check('prose code on a 500 → falls through to "500"', classifyAiFailure(err({ status: 500, code: prose })).errorCode === '500');
    check('prose code on a plain 429 → "429"', classifyAiFailure(err({ status: 429, code: prose })).errorCode === '429');
    check('prose code, no status → class name', classifyAiFailure(Object.assign(new TypeError('x'), { code: prose })).errorCode === 'TypeError');
    check('a valid code is still preferred', classifyAiFailure(err({ status: 500, code: 'server_error' })).errorCode === 'server_error');
    const odd = Object.assign(new Error('x'), { name: 'Weird Name With Spaces' });
    check('a non-identifier class name → "error"', classifyAiFailure(odd).errorCode === 'error');
  }

  console.log('\n3. the failure writer stores the gated value');
  {
    const rows: Record<string, unknown>[] = [];
    const client = { aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); } } };
    await recordAiInvocationFailure({ provider: 'OPENAI', model: 'm', outcome: 'FAILED', errorCode: 'a sentence of provider prose', latencyMs: 1 }, client);
    await recordAiInvocationFailure({ provider: 'OPENAI', model: 'm', outcome: 'FAILED', errorCode: 'server_error', latencyMs: 1 }, client);
    await recordAiInvocationFailure({ provider: 'OPENAI', model: 'm', outcome: 'FAILED', errorCode: '', latencyMs: 1 }, client);
    check('prose → stored "error"', rows[0]?.errorCode === 'error', JSON.stringify(rows[0]));
    check('valid → stored as-is', rows[1]?.errorCode === 'server_error');
    check('empty → no errorCode column', rows[2] !== undefined && !('errorCode' in rows[2]));
  }

  console.log('\n4. CENSUS — every ledger errorCode write goes through code()');
  {
    // A filesystem walk (not `git ls-files`) so the census runs in any checkout copy.
    const SKIP = new Set(['node_modules', '.git', '.next', 'docs', 'coverage', 'tmp', 'backups']);
    const walk = (dir: string, out: string[]): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, out); }
        else if (/\.([cm]?[tj]sx?)$/.test(e.name) && !/\.test\.[cm]?[tj]sx?$/.test(e.name)) out.push(relative(ROOT, full));
      }
      return out;
    };
    const files = ['lib', 'app', 'components', 'jobs', 'scripts', 'prisma']
      .flatMap((r) => { try { return walk(join(ROOT, r), []); } catch { return []; } })
      .concat(readdirSync(ROOT).filter((f) => /\.([cm]?[tj]sx?)$/.test(f)))
      .filter((f) => !f.startsWith('prisma/migrations/'));
    check('the census walked a real tree', files.length > 200 && files.includes('lib/ai/invocation.ts'), String(files.length));
    const prismaWrite = /\baiInvocation\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g;
    const rawWrite = /\b(insert\s+into|update)\s+"?AiInvocation"?/gi;
    const writers: string[] = [];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const m of src.matchAll(prismaWrite)) {
        writers.push(`${f}:${m[1]}`);
        // The call's argument span: to the matching close paren.
        let depth = 0, i = m.index! + m[0].length - 1, end = src.length;
        for (; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) { end = i; break; }
        }
        const span = src.slice(m.index!, end);
        for (const e of span.matchAll(/\berrorCode\s*:\s*([^,}\n]*)/g)) {
          if (!/^code\(/.test(e[1].trim())) offenders.push(`${f}: errorCode: ${e[1].trim()}`);
        }
        // A spread of something other than literal objects could smuggle errorCode in.
        for (const s of span.matchAll(/\.\.\.\s*([A-Za-z_$][\w$.]*)/g)) {
          if (!/^(attributionOf|ctx|input)\b/.test(s[1])) offenders.push(`${f}: spread ...${s[1]}`);
        }
        if (/\.\.\.\s*input\b(?!\.)/.test(span)) offenders.push(`${f}: spread ...input`);
      }
      for (const m of src.matchAll(rawWrite)) {
        const tail = src.slice(m.index!, m.index! + 600);
        const stmt = tail.split(';')[0];
        if (/errorCode/.test(stmt)) offenders.push(`${f}: raw SQL writes errorCode`);
      }
    }
    console.log(`     writers: ${writers.join(', ')}`);
    check('the two invocation.ts writers are found', writers.filter((w) => w.startsWith('lib/ai/invocation.ts:create')).length === 2, writers.join(', '));
    check('no writer outside the known set', writers.every((w) => /^lib\/ai\/invocation\.ts:create$|^lib\/account-deletion\/purge\.ts:updateMany$/.test(w)), writers.join(', '));
    check('every errorCode write is code(...)', offenders.length === 0, offenders.join(' | '));
    const inv = readFileSync(join(ROOT, 'lib/ai/invocation.ts'), 'utf8');
    check('invocation.ts writes errorCode exactly once, via code(input.errorCode)', (inv.match(/errorCode:\s*code\(input\.errorCode\)/g) ?? []).length === 1);
    check('attributionOf() carries no errorCode', !/errorCode/.test(inv.slice(inv.indexOf('function attributionOf'), inv.indexOf('export function classifyAiFailure'))));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
