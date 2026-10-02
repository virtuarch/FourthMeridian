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
 * A client that answers the ONE query the oracle issues — a `SpaceMember` read.
 *
 * ⚠️ RLS-AI-S10 — THE PROBE MOVED FROM `Space` TO `SpaceMember`, AND THIS FIXTURE
 * HAD TO MOVE WITH IT RATHER THAN BE MADE TO SATISFY IT. Making the fake answer
 * whatever the probe happens to ask is how a suite becomes a tautology: a probe
 * that cannot see anything would then "approve" everything. So the fake holds
 * MEMBERSHIP ROWS and APPLIES THE PROBE'S OWN `where` to them, including
 * `status: 'ACTIVE'`. A probe that forgot the status filter, or asked about the
 * wrong Space, gets the wrong answer from this fixture — which is the only way a
 * fake client is worth anything.
 *
 * The reason the probe moved is in `lib/ai/absence.ts`: `fm_app_sel ON "Space"`
 * ORs in `"isPublic" = true` and a platform-grant arm, while every child policy
 * reads `fm_visible_space_ids()`, which is ACTIVE membership and nothing else.
 *
 * `calls` counts the probes, because "zero added queries on the success path" is
 * an assertion, not a hope. `lastWhere` is recorded so the QUESTION can be
 * asserted and not just the answer.
 */
type MemberRow = { spaceId: string; status: 'ACTIVE' | 'REMOVED' | 'LEFT' };

function fakeClient(
  membership: readonly MemberRow[] | 'throws',
): ReadClient & { calls: number; lastWhere: { spaceId?: string; status?: string } | null } {
  const c = {
    calls: 0,
    lastWhere: null as { spaceId?: string; status?: string } | null,
    spaceMember: {
      findFirst: async ({ where }: { where: { spaceId: string; status: string } }) => {
        c.calls++;
        c.lastWhere = where;
        if (membership === 'throws') {
          throw new Error('permission denied for table "SpaceMember"');
        }
        const row = membership.find(
          (m) => m.spaceId === where.spaceId && m.status === where.status);
        return row ? { id: `m_${row.spaceId}` } : null;
      },
    },
  };
  return c as unknown as ReadClient
    & { calls: number; lastWhere: { spaceId?: string; status?: string } | null };
}

/** An ACTIVE member of each named Space — the ordinary case, spelled once. */
const activeIn = (...spaceIds: string[]): MemberRow[] =>
  spaceIds.map((spaceId) => ({ spaceId, status: 'ACTIVE' as const }));

// ⚠️ ONE `main()`: tsx compiles these suites as CJS, where top-level await is a
// build error — the kind of thing that reads as a test failure and is not one.
async function main(): Promise<void> {
  // ══ THE PAIR — ONE EMPTY READ, TWO VERDICTS ══════════════════════════════════
  {
    const visible   = fakeClient(activeIn('space-alice'));
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
    const c = fakeClient(activeIn('s1'));
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

  // ══ THE PROBE ASKS THE RIGHT QUESTION, NOT MERELY A QUESTION ════════════════
  //
  // ⚠️ THIS IS THE CASE THAT STOPS THE FIXTURE BECOMING A TAUTOLOGY. The verdicts
  // above are only meaningful if the probe interrogates ACTIVE MEMBERSHIP OF THE
  // NAMED SPACE — the exact definition of `fm_visible_space_ids()`. A probe that
  // asked something laxer would still pass the pair above against a lax fake.
  {
    const c = fakeClient(activeIn('s-asked'));
    await adjudicateAbsence(c, 's-asked');
    check('the probe asks about THIS Space and about ACTIVE status, by name',
      c.lastWhere?.spaceId === 's-asked' && c.lastWhere?.status === 'ACTIVE',
      JSON.stringify(c.lastWhere));
  }

  // ══ MEMBERSHIP THAT IS NOT ACTIVE IS NOT MEMBERSHIP ═════════════════════════
  //
  // A REMOVED row exists for the Space, so a probe that merely checked "is there
  // a member row" would say PROVEN_EMPTY. `fm_visible_space_ids()` requires
  // ACTIVE, so the honest verdict is INDETERMINATE — and the pair proves the
  // fixture is not simply answering null to everything.
  {
    const removed = fakeClient([{ spaceId: 's-rev', status: 'REMOVED' }]);
    const stillIn = fakeClient([
      { spaceId: 's-rev', status: 'REMOVED' }, { spaceId: 's-ok', status: 'ACTIVE' }]);

    const v = await adjudicateAbsence(removed, 's-rev');
    check('a REMOVED membership is INDETERMINATE, even though a row exists',
      v === EvidenceState.INDETERMINATE, String(v));
    check('NOT VACUOUS — the same fixture answers PROVEN_EMPTY where membership IS active',
      (await adjudicateAbsence(stillIn, 's-ok')) === EvidenceState.PROVEN_EMPTY);
  }

  // ══ A PROBE THAT CANNOT ANSWER MUST NOT ASSERT ═══════════════════════════════
  {
    // ⚠️ THE MOST IMPORTANT CASE IN THE FILE, AND THE ONE A "HELPFUL" FIXTURE
    // DESTROYS. If a fake is written to make the probe SUCCEED whatever it asks,
    // this case is the only thing left distinguishing "the Space is empty" from
    // "I could not find out" — and it must stay on the refusing side.
    const thrown = await adjudicateAbsence(fakeClient('throws'), 's1');
    check('a THROWING probe is INDETERMINATE, not PROVEN_EMPTY and not an exception',
      thrown === EvidenceState.INDETERMINATE, String(thrown));
    check('…and a throwing probe is never memoised as observable',
      (await adjudicateAbsence(fakeClient('throws'), 's1')) === EvidenceState.INDETERMINATE);

    const blank = fakeClient(activeIn('s1'));
    const noId = await adjudicateAbsence(blank, '');
    check('an empty Space id is INDETERMINATE',
      noId === EvidenceState.INDETERMINATE, String(noId));
    check('…and issues no query at all', blank.calls === 0, `${blank.calls} probes`);
  }

  // ══ THE WORDING — DERIVED, AND IT CANNOT CARRY THE CLAIM ═════════════════════
  {
    const PROVEN = 'no dated transactions are available for this Space';
    const okCase = await absent(fakeClient(activeIn('s1')), 's1',
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
    const one = fakeClient(activeIn('s1'));
    const two = fakeClient(activeIn('s1'));

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

    /**
     * The envelope must probe only when the whole census saw nothing.
     *
     * ⚠️ RLS-AI-S8 — `txn._count` BECAME AN OBJECT, so the condition now reads
     * `allTxns === 0`. The aggregate asks for `{ _all, economicDate }` in one
     * query, because the old single count was measured over ALL rows while the
     * range beside it was measured over the DATED ones. The PROPERTY pinned here
     * is unchanged: the probe is on the empty path only.
     */
    check('the coverage census probes on the empty path only',
      /const sawNothing\s+= allTxns === 0 && snap\.count === 0 && accounts\.length === 0;/
        .test(ENVELOPE),
      (ENVELOPE.match(/const sawNothing[^\n]*/) ?? ['(not found)'])[0]);
    check('…and the census still derives the DATED count separately from the row total',
      /_count: \{ _all: true, economicDate: true \}/.test(ENVELOPE)
        && /const datedTxns\s+= txn\._count\.economicDate;/.test(ENVELOPE));

    /**
     * ⚠️ RLS-AI-S10 — THE ORACLE PROBES MEMBERSHIP, NOT THE `Space` ROW, and no
     * fixture can express why: the reason is two extra arms on a policy in a
     * migration this slice may read and may not change.
     */
    check('the oracle probes SpaceMember, filtered to ACTIVE',
      /client\.spaceMember\.findFirst\(\{\s*\n?\s*where: \{ spaceId, status: "ACTIVE" \}/
        .test(ABSENCE),
      (ABSENCE.match(/client\.\w+\.findFirst[\s\S]{0,80}/) ?? ['(not found)'])[0]);
    check('…and it no longer reads the `Space` row, whose policy is NOT membership',
      !/client\.space\.findFirst/.test(ABSENCE));

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
