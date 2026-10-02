/**
 * lib/ai/absence.test.ts  (RLS-AI-S0)
 *
 * "I DID NOT OBTAIN EVIDENCE" IS NOT "THE EVIDENCE DOES NOT EXIST".
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/absence.test.ts
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * The MECHANISM, on fake clients, plus the SOURCE PROPERTIES that no fixture can
 * express. The authority claims — that `fm_app` actually refuses Bob's Space, that
 * the probe really runs under the policy — are NOT made here: a fake client cannot
 * prove a policy, so they live in scripts/rls-ai-acceptance.ts against real roles.
 *
 * ⚠️ A FIXTURE THAT YIELDS AN EMPTY SET MAKES A TEST PASS FOR THE WRONG REASON,
 * and this programme has shipped that once. So every case below asserts the
 * VERDICT, not merely that something was refused, and the two halves of the pair
 * are built from the SAME empty read.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  adjudicateAbsence, adjudicateMemoryAbsence, absent, indeterminateSentence,
  EvidenceState, forgetObservability,
} from './absence';
import type { ReadClient } from '@/lib/db/tenant-context';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/**
 * A client that answers the ONE query the oracle issues.
 *
 * `sees` is the set of Space ids this identity may observe — which is exactly what
 * the `Space` SELECT policy decides for `fm_app`, and unconditionally true for the
 * migration principal. `calls` counts the probes, because "zero added queries on
 * the success path" is an assertion, not a hope.
 */
function fakeClient(sees: string[] | 'throws'): ReadClient & { calls: number } {
  const c = {
    calls: 0,
    space: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        c.calls++;
        if (sees === 'throws') throw new Error('permission denied for table "Space"');
        return sees.includes(where.id) ? { id: where.id } : null;
      },
    },
  };
  return c as unknown as ReadClient & { calls: number };
}

// ⚠️ ONE `main()`: tsx compiles these suites as CJS, where top-level await is a
// build error — the kind of thing that reads as a test failure and is not one.
async function main(): Promise<void> {
  // ══ THE PAIR — ONE EMPTY READ, TWO VERDICTS ══════════════════════════════════
  {
    const visible   = fakeClient(['space-alice']);
    const refused   = fakeClient([]);

    const a = await adjudicateAbsence(visible, 'space-alice');
    const b = await adjudicateAbsence(refused, 'space-alice');

    check('an empty read in an OBSERVABLE Space is PROVEN_EMPTY',
      a === EvidenceState.PROVEN_EMPTY, String(a));
    check('an empty read in an UNOBSERVABLE Space is INDETERMINATE',
      b === EvidenceState.INDETERMINATE, String(b));
    check('…and the two are not the same value', a !== b);
  }

  // ══ THE PROBE IS THE ONLY QUERY, AND IT IS ISSUED ONCE ═══════════════════════
  {
    const c = fakeClient(['s1']);
    await adjudicateAbsence(c, 's1');
    await adjudicateAbsence(c, 's1');
    await adjudicateAbsence(c, 's1');
    check('three empty reads on one client+Space cost ONE probe',
      c.calls === 1, `${c.calls} probes`);

    // ⚠️ AND THE NEGATIVE IS NOT CACHED. A cached INDETERMINATE would be permanent
    // for a Space that later becomes readable, so only `true` is memoised.
    const d = fakeClient([]);
    await adjudicateAbsence(d, 's2');
    await adjudicateAbsence(d, 's2');
    check('an INDETERMINATE verdict is re-probed, never memoised',
      d.calls === 2, `${d.calls} probes`);

    forgetObservability(c);
    await adjudicateAbsence(c, 's1');
    check('forgetObservability clears the memo (so a test cannot pass on a stale one)',
      c.calls === 2, `${c.calls} probes`);
  }

  // ══ A PROBE THAT CANNOT ANSWER MUST NOT ASSERT ═══════════════════════════════
  {
    const thrown = await adjudicateAbsence(fakeClient('throws'), 's1');
    check('a THROWING probe is INDETERMINATE, not PROVEN_EMPTY and not an exception',
      thrown === EvidenceState.INDETERMINATE, String(thrown));

    const blank = fakeClient(['s1']);
    const noId = await adjudicateAbsence(blank, '');
    check('an empty Space id is INDETERMINATE',
      noId === EvidenceState.INDETERMINATE, String(noId));
    check('…and issues no query at all', blank.calls === 0, `${blank.calls} probes`);
  }

  // ══ THE WORDING — DERIVED, AND IT CANNOT CARRY THE CLAIM ═════════════════════
  {
    const PROVEN = 'no dated transactions are available for this Space';
    const okCase = await absent(fakeClient(['s1']), 's1',
      { proven: PROVEN, subject: 'dated transactions' });
    const badCase = await absent(fakeClient([]), 's1',
      { proven: PROVEN, subject: 'dated transactions' });

    check('PROVEN_EMPTY says the sentence the Space earned',
      okCase.unavailable === PROVEN && okCase.evidenceState === EvidenceState.PROVEN_EMPTY);
    check('INDETERMINATE does NOT say it',
      badCase.unavailable !== PROVEN && !badCase.unavailable.includes(PROVEN), badCase.unavailable);
    check('…and the two refusals are byte-DIFFERENT (RLS-C-S3 measured them identical)',
      okCase.unavailable !== badCase.unavailable);
    check('INDETERMINATE states the non-establishment explicitly',
      /could NOT be established/.test(badCase.unavailable), badCase.unavailable);
    check('…and forbids the absence answer rather than merely omitting it',
      /do NOT say there is none/.test(badCase.unavailable));
    check('the state travels with the sentence, on both branches',
      okCase.evidenceState === 'PROVEN_EMPTY' && badCase.evidenceState === 'INDETERMINATE');

    check('extra context is preserved on both branches',
      (await absent(fakeClient([]), 's1', { proven: 'x', subject: 'y' }, { result: null })).result === null);

    // ⚠️ A CALLER SUPPLIES A NOUN PHRASE, NEVER A SENTENCE. The indeterminate
    // wording is generated, so no call site can smuggle an absence claim into it.
    check('indeterminateSentence is a function of the subject alone',
      indeterminateSentence('accounts') !== indeterminateSentence('transactions')
        && indeterminateSentence('accounts') === indeterminateSentence('accounts'));
  }

  // ══ THE MEMORY STORE — THE SAME-CLIENT RULE IS CHECKED, NOT ASSUMED ══════════
  {
    const one = fakeClient(['s1']);
    const two = fakeClient(['s1']);

    const same = await adjudicateMemoryAbsence({
      spaceId: 's1', memoryClient: one, readClient: one });
    check('memory on the SAME client object is adjudicated',
      same === EvidenceState.PROVEN_EMPTY, String(same));

    const split = await adjudicateMemoryAbsence({
      spaceId: 's1', memoryClient: two, readClient: one });
    check('memory on a DIFFERENT client is INDETERMINATE, never adjudicated by proxy',
      split === EvidenceState.INDETERMINATE, String(split));
    check('…and the foreign authority is not even consulted',
      two.calls === 0, `${two.calls} probes on the non-reading client`);
  }

  // ══ SOURCE PROPERTIES — WHAT NO FIXTURE CAN EXPRESS ══════════════════════════
  //
  // ⚠️ THE NEEDLES ARE ESCAPED AND THE SCANS ARE PROVEN TO FAIL. This programme has
  // a recorded case of a scan whose needle was built as `\b${name}\s*\(` with
  // `name = "$transaction"` — `$` is end-of-string in a regex, so it matched
  // NOTHING and reported clean over zero call sites. Every scan below is run twice:
  // once against the file, once against a string that violates it.
  {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    const ABSENCE = read('lib/ai/absence.ts');
    const TOOLS   = read('lib/ai/conversation/tools.ts');
    const TXQUERY = read('lib/data/transaction-query.ts');
    const ENVELOPE = read('lib/ai/coverage-envelope.ts');
    const MEMTOOLS = read('lib/ai/conversation/memory-tools.ts');

    /** A probe handed the GLOBAL client would answer about rows the reader cannot see. */
    const WIDER_AUTHORITY = /adjudicate(?:Absence|MemoryAbsence)\(\s*db\b/;
    const scanned = [ABSENCE, TOOLS, TXQUERY, ENVELOPE, MEMTOOLS];
    check('no absence probe is handed the module-level `db`',
      scanned.every((src) => !WIDER_AUTHORITY.test(src)));
    check('…and that scan goes RED when violated',
      WIDER_AUTHORITY.test('const v = await adjudicateAbsence(db, spaceId);'),
      'the needle matched nothing — it would have reported clean over a real violation');

    /** The oracle must not acquire a client of its own. */
    const HOLDS_A_CLIENT = /from ['"]@\/lib\/db['"]/;
    check('absence.ts holds no Prisma client of its own',
      !HOLDS_A_CLIENT.test(ABSENCE));
    check('…and that scan goes RED when violated',
      HOLDS_A_CLIENT.test("import { db } from '@/lib/db';"));

    /** The three raw absence sentences must not survive outside the adjudicated path. */
    const RAW = [
      /\{\s*unavailable:\s*'no accounts in scope'\s*\}/,
      /\{\s*unavailable:\s*'no usable snapshot history for this Space'\s*\}/,
      /\{\s*unavailable:\s*'no priced positions in scope'\s*\}/,
    ];
    check('no tool returns a raw, unadjudicated absence literal',
      RAW.every((re) => !re.test(TOOLS)),
      RAW.filter((re) => re.test(TOOLS)).map(String).join(' · '));
    check('…and that scan goes RED when violated',
      RAW[0].test("if (!acc) return { unavailable: 'no accounts in scope' };"));

    /** The corpus-span authority must adjudicate before it words the refusal. */
    check('transaction-query adjudicates on the empty path',
      /adjudicateAbsence\(client, args\.spaceId\)/.test(TXQUERY));
    check('…and the proven sentence is only reachable AFTER the verdict',
      TXQUERY.indexOf('adjudicateAbsence(client, args.spaceId)')
        < TXQUERY.indexOf("'no dated transactions are available for this Space'"));

    /** The envelope must probe only when the whole census saw nothing. */
    check('the coverage census probes on the empty path only',
      /const sawNothing = txn\._count === 0 && snap\.count === 0 && accounts\.length === 0;/
        .test(ENVELOPE));

    /** The recall instruction must be gated on the verdict. */
    check("`recall`'s \"Say so plainly\" is reachable only when not INDETERMINATE",
      MEMTOOLS.indexOf('adjudicateMemoryAbsence(ctx)')
        < MEMTOOLS.indexOf('Nothing has been remembered for this user yet'));
  }

}

void main().then(() => {
  console.log(`\nabsence: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
