/**
 * lib/ai/coverage-envelope.ts
 *
 * CF-5 — WHAT EVIDENCE EXISTS, AS DISTINCT FROM WHAT WAS LOADED.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 * CF-R0 measured a Space holding 4,184 transactions across three and a half
 * years, and a prompt that carried 455 of them with no statement anywhere that
 * the rest existed. Every layer was honest about its own selection — CF-2 said
 * which period was loaded, CF-3 that the request was understood, CF-4 where the
 * period came from — and none of them could say what lay OUTSIDE the selection.
 *
 * So the model's only truthful sentence was "I can only see the last 90 days",
 * which is false about the product and reads as an apology for a system that
 * holds the data. The sentence it should be able to say is:
 *
 *     "I have transaction history back to March 2023. I'm using the last 90
 *      days for this answer."
 *
 * Both halves are needed. The first without the second invites the model to
 * answer from history it was not given.
 *
 * ── Four states, never collapsed ────────────────────────────────────────────
 *   AVAILABLE    evidence exists in the substrate and this Space may see it
 *   LOADED       evidence was actually assembled into THIS turn
 *   RETRIEVABLE  a production path exists that could fetch it
 *   UNAVAILABLE  the system cannot support the claim at all
 *
 * This module owns AVAILABLE. CF-2 owns LOADED and states it per turn; the two
 * are rendered together, by one function, precisely so no reader has to align
 * them and no future edit can drift them apart.
 *
 * ── What it must not become ─────────────────────────────────────────────────
 * Awareness, not retrieval. It answers "what exists?" in about two hundred
 * tokens of aggregates and never carries a row, a total, or a conclusion.
 * Answering "the model feels ignorant" by loading history into every prompt is
 * the failure this exists to avoid, not a shortcut to it.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * Four indexed aggregate queries, no row scan, no per-row work. Constant in the
 * size of the ledger: the same cost on a Space with four thousand transactions
 * and on one with four hundred thousand.
 */

import { adjudicateAbsence, EvidenceState } from '@/lib/ai/absence';
import type { ReadClient } from '@/lib/db/tenant-context';
import { bankingTransactionWhere } from '@/lib/data/banking-population';
import { resolveFullVisibleAccountIds } from '@/lib/accounts/space-account-link';
import { getSnapshotExtent } from '@/lib/data/snapshots';
import { isDigitalAssetAccountType } from '@/lib/account-classifier';
import { loadWalletHistoryMetadata } from '@/lib/crypto/wallet-history-metadata';

/**
 * Whether a class of evidence exists for this Space.
 *
 * UNKNOWN is a real answer and deliberately distinct from NONE: "we did not
 * establish this" and "there is none" license different sentences, and merging
 * them is how a system starts asserting absence it never checked.
 */
export const EvidenceAvailability = {
  AVAILABLE: 'AVAILABLE',
  NONE:      'NONE',
  UNKNOWN:   'UNKNOWN',
} as const;

export type EvidenceAvailabilityKind =
  typeof EvidenceAvailability[keyof typeof EvidenceAvailability];

/** An interval of available evidence, with how much of it there is. */
export interface EvidenceSpan {
  fromISO: string | null;
  toISO:   string | null;
  /**
   * How many records lie INSIDE `[fromISO, toISO]`.
   *
   * ⚠️ RLS-AI-S8 — THIS USED TO BE THE COUNT OF A DIFFERENT POPULATION FROM THE
   * RANGE BESIDE IT, and the two were rendered as one sentence. `_count` counted
   * every row in the banking population while `_min`/`_max(economicDate)` ranged
   * over the DATED ones only, because `Transaction.economicDate` is nullable
   * (`prisma/schema.prisma:2327`) and the `audit-economic-date-persistence` audit
   * is RED on the live corpus today — so this is a reachable production state, not
   * a hypothetical. A Space with 4,184 rows of which 500 carry no economic date was
   * described to the model as "4,184 records Mar 2023–Jun 2026": a true count and a
   * true range that are false TOGETHER. It is now the DATED count, and the
   * undatable remainder is a separate field rather than a silent addend.
   */
  count:   number;
  /**
   * Records that EXIST and cannot be placed in time. Omitted when zero.
   *
   * ⚠️ "EXISTS BUT UNDATABLE" IS A THIRD STATE, NOT A ROUNDING ERROR. Folding it
   * into `count` overstates the range; dropping it understates the record. Both
   * are false-absence shapes — one about a period, one about the ledger — and the
   * whole point of this module is that those are different sentences.
   */
  undatedCount?: number;
}

/** Per-chain digital-asset coverage. QUANTITY only — see `CoverageEnvelope`. */
export interface ChainQuantityCoverage {
  chain:    string;
  /** Earliest date the wallet is evidenced to have HELD something (UI-C2). */
  fromISO:  string | null;
  toISO:    string | null;
  /** False for a chain with a current position and no proven past. */
  claimsHistory: boolean;
}

/**
 * The universe of evidence this Space can draw on.
 *
 * Every field describes AVAILABILITY. Nothing here says anything about what a
 * given turn loaded — that is CF-2's `TemporalScope`, and the renderer takes
 * both so the distinction is made in one place.
 */
export interface CoverageEnvelope {
  transactions: { availability: EvidenceAvailabilityKind; span: EvidenceSpan };
  snapshots:    { availability: EvidenceAvailabilityKind; span: EvidenceSpan };
  /**
   * Which financial classes have evidence. Presence only — no balances, no
   * totals. CF-6 decides what to DO with this; CF-5 only establishes it.
   */
  accounts: {
    cash:          number;
    debt:          number;
    investments:   number;
    digitalAssets: number;
    other:         number;
  };
  /**
   * Per-chain QUANTITY coverage, from the persisted `PositionCoverage` licence.
   *
   * ⚠️ QUANTITY, NOT VALUATION. Ethereum's quantity is provable back to the
   * Byzantium block (2017-10-16) while its price history is a rolling year, so
   * "we know what you held" and "we know what it was worth" diverge by years on
   * a chain we support today. The renderer states that limit explicitly rather
   * than letting a span be read as a valuation claim.
   */
  chains: ChainQuantityCoverage[];
  /**
   * RLS-AI-S0 — WHY nothing could be established, when that is the answer.
   *
   * ⚠️ THE TWO FAILURES USED TO BE ONE, AND THEY RUN OPPOSITE WAYS. The census
   * `catch` swallowed every exception into an UNKNOWN envelope that renders as
   * `[]`, so a GRANT failure failed safe-and-silent — while a POLICY filter,
   * which does not throw at all, arrived as an empty count and rendered as the
   * declarative `"Transactions: none recorded in this Space."` On the AI read
   * path only the second is reachable, so the loud-and-wrong one was the live
   * one. They are separate values now:
   *
   *   null                   the census ran and established what it reports
   *   'CENSUS_FAILED'        an authority threw; nothing was established
   *   'SPACE_NOT_OBSERVABLE' the census ran, found nothing, AND the absence
   *                          oracle could not confirm this Space is readable by
   *                          the identity that asked — so the emptiness is
   *                          INDETERMINATE and must never be rendered as absence
   */
  unavailability: null | 'CENSUS_FAILED' | 'SPACE_NOT_OBSERVABLE';
  /**
   * RLS-AI-S8 — THE PROHIBITION, ON THE OBJECT, DERIVED FROM ITS OWN STATE.
   *
   * ⚠️ IT IS HERE BECAUSE THE RENDERER IS NOT ON THE LIVE PATH, AND THAT WAS THE
   * REAL DEFECT. `describeCoverageEnvelope` writes every careful sentence this
   * module owns — the UNKNOWN prohibition RLS-AI-S0 added, the undated-rows
   * sentence — and it has NO PRODUCTION CALLER. Search it: the only callers are
   * this module's own unit suite and the RLS acceptance script. The shipped A2
   * orientation (`lib/ai/conversation/evidence.ts`) puts the ENVELOPE OBJECT into
   * the prompt as JSON (`evidenceCoverage: envelope`), so what the model actually
   * received for a refused Space was `"availability":"UNKNOWN"`,
   * `"count":0` and a bare `"unavailability":"SPACE_NOT_OBSERVABLE"` — three
   * fields, no sentence, sitting next to a prompt full of invitations to assert
   * absence. The absence contract was being tested on a code path the product
   * does not use.
   *
   * ⚠️ DERIVED, NEVER WRITTEN BY A CALLER — the `applied-facts` rule (`54eb8e1`),
   * where a verbatim caller-supplied string rode a figure it could not model into
   * a durable checkpoint. The wording comes from the state alone.
   *
   * ⚠️ OMITTED WHEN THERE IS NOTHING TO PROHIBIT, so an ordinary envelope is
   * byte-for-byte what it was and costs no tokens.
   */
  meaning?: string;
}

/**
 * The sentence an envelope's own state licenses. PURE.
 *
 * Exported so the renderer and the serialized object cannot disagree: both read
 * this, there is no second copy of the wording, and a test can assert the
 * sentence exists without a database.
 */
export function coverageMeaning(env: Omit<CoverageEnvelope, 'meaning'>): string | undefined {
  if (env.unavailability !== null) {
    // ⚠️ BYTE-FOR-BYTE THE SENTENCE THE RENDERER ALREADY SHIPPED. It is prompt
    // text, so rewording it would be an unmeasured change to what a model reads —
    // and the suite beside this file pins its exact phrasing, including the
    // deliberate choice NOT to contain the sentence it forbids (the bb2f6ec
    // erratum: a word-presence check cannot tell a citation from a claim). S8
    // changes only WHERE the sentence is delivered, never what it says.
    return 'EVIDENCE COVERAGE COULD NOT BE ESTABLISHED for this Space'
      + (env.unavailability === 'SPACE_NOT_OBSERVABLE'
        ? ' — this request could not read its record'
        : ' — the coverage census failed')
      + '. Treat every class of evidence here as UNKNOWN: do not describe any record as empty, do '
      + 'not give a count, and do not state how far back history goes. If asked, say the record '
      + 'could not be checked for this request.';
  }
  const undated = env.transactions.span.undatedCount ?? 0;
  if (undated > 0) {
    return `${undated.toLocaleString()} transaction record(s) EXIST but carry no economic date, `
      + 'so they belong to no period and are NOT included in `count` or in the from/to range. '
      + 'Never fold them into a period total, and never describe them as absent or missing.';
  }
  return undefined;
}

/** Empty envelope — every class UNKNOWN. Used when the census cannot run. */
function unknownEnvelope(
  unavailability: 'CENSUS_FAILED' | 'SPACE_NOT_OBSERVABLE' = 'CENSUS_FAILED',
): CoverageEnvelope {
  const none: EvidenceSpan = { fromISO: null, toISO: null, count: 0 };
  const base = {
    transactions: { availability: EvidenceAvailability.UNKNOWN, span: none },
    snapshots:    { availability: EvidenceAvailability.UNKNOWN, span: none },
    accounts: { cash: 0, debt: 0, investments: 0, digitalAssets: 0, other: 0 },
    chains: [] as ChainQuantityCoverage[],
    unavailability,
  };
  // ⚠️ THE NOTICE TRAVELS WITH THE OBJECT, so a caller that serializes the
  // envelope (which is what production does) cannot ship the state without it.
  return { ...base, ...(coverageMeaning(base) ? { meaning: coverageMeaning(base)! } : {}) };
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

/**
 * Census what evidence this Space can see.
 *
 * ── Visibility ──────────────────────────────────────────────────────────────
 * The transaction census reuses `bankingTransactionWhere` — the SAME predicate
 * the summary query uses — with no date filter. That is the whole visibility
 * story: an account whose link does not grant transaction detail contributes to
 * neither, so AVAILABLE and LOADED are measured over one population and the
 * envelope cannot advertise evidence the user is not entitled to see. Deriving
 * the count from a separate query would be the moment those two could disagree.
 *
 * Account presence is scoped the same way, through the link table.
 */
export async function loadCoverageEnvelope(
  /**
   * RLS-AI-S8 — REQUIRED, LEADING, AND NO LONGER `options?.client ?? db`.
   *
   * ⚠️ THE DEFAULT WAS THE ONE ESCAPE LEFT ON THE ABSENCE PATH, which is the worst
   * place for it: this census is the module that decides whether an emptiness may
   * be SPOKEN as absence, and it was deciding that on whatever client it happened
   * to reach. On the migration principal the probe below answers PROVEN_EMPTY for
   * every Space — correctly, since the owner can see them all — so a caller that
   * forgot the option got a confidently licensed absence over a population it had
   * never been scoped to.
   */
  client:  ReadClient,
  spaceId: string,
): Promise<CoverageEnvelope> {
  try {
    // Accounts this Space may see transaction-level detail for.
    //
    // Through the CANONICAL resolver, deliberately. Three resolvers already
    // hand-roll this traversal and a guard exists specifically to catch a fourth
    // (lib/visibility-resolver-parity.test.ts) — because the realistic
    // regression is not deleting the predicate, it is a new reader that quietly
    // drops `status: ACTIVE` and so sees slightly more than its siblings. On
    // THIS boundary a slightly larger set is one family member reading another's
    // private account.
    const visibleIds = await resolveFullVisibleAccountIds(client, spaceId);
    const accounts = visibleIds.size === 0 ? [] : await client.financialAccount.findMany({
      where:  { id: { in: [...visibleIds] } },
      select: { id: true, type: true, walletChain: true },
    });

    const [txn, snap, wallets] = await Promise.all([
      // Indexed min/max/count over the canonical banking population. No rows.
      // ⚠️ RLS-AI-S8 — TWO COUNTS, STILL ONE QUERY. Prisma's `_count` over a FIELD
      // counts its NON-NULL values, so `{ _all, economicDate }` returns the whole
      // banking population and the DATED subset from the same aggregate. The fix
      // for the mismatched populations therefore costs no extra round trip, which
      // is why it is a correction and not a trade.
      client.transaction.aggregate({
        where: bankingTransactionWhere(spaceId),
        _min: { economicDate: true },
        _max: { economicDate: true },
        _count: { _all: true, economicDate: true },
      }),
      // Through the snapshot authority — an aggregate is still a read, and
      // snapshot reads have one home (lib/data/snapshot-read-boundary.test.ts).
      // RLS-C-S3 — the extent runs on the SAME client this census was handed, so
      // the absence oracle below adjudicates the authority that actually read.
      getSnapshotExtent(client, spaceId),
      // The canonical wallet-history authority (UI-C1/C2). It already separates
      // the proof floor from the first date anything was actually held, and
      // already refuses to claim history for a chain that has not earned it.
      loadWalletHistoryMetadata(
        accounts.filter((a) => isDigitalAssetAccountType(a.type)),
        { client },
      ),
    ]);

    // A crypto account with no chain is a CUSTODIAL holding (an exchange
    // account), not a wallet. It has no on-chain quantity licence to report, so
    // it contributes to the digital-asset PRESENCE count and to nothing else —
    // emitting an "UNKNOWN chain" row would advertise a capability that does
    // not exist.
    const chainOf = new Map(
      accounts.filter((a) => a.walletChain).map((a) => [a.id, a.walletChain as string]),
    );

    // One row per CHAIN, not per wallet: two wallets on the same chain are one
    // capability statement, and listing both would leak account structure into
    // a block that is meant to describe evidence.
    const byChain = new Map<string, ChainQuantityCoverage>();
    for (const [accountId, meta] of wallets) {
      const chain = chainOf.get(accountId);
      if (!chain) continue;
      const existing = byChain.get(chain);
      const from = meta.activityFromISO;
      byChain.set(chain, {
        chain,
        // Widest evidenced interval across the chain's wallets.
        fromISO: existing?.fromISO && from ? (existing.fromISO < from ? existing.fromISO : from)
               : (existing?.fromISO ?? from),
        toISO:   existing?.toISO && meta.licensedToISO
               ? (existing.toISO > meta.licensedToISO ? existing.toISO : meta.licensedToISO)
               : (existing?.toISO ?? meta.licensedToISO),
        claimsHistory: (existing?.claimsHistory ?? false) || meta.claimsHistory,
      });
    }

    const count = (pred: (t: string | null) => boolean) =>
      accounts.filter((a) => pred(a.type)).length;

    // ── RLS-AI-S0: THE ABSENCE ORACLE, ON THE EMPTY PATH ONLY ────────────────
    //
    // ⚠️ ONE PROBE PER CENSUS, AND ONLY WHEN THE CENSUS SAW NOTHING AT ALL. A
    // single row from ANY of the three reads is itself proof that this identity
    // can observe this Space, so the probe is not merely cached on the success
    // path — it is never issued. The added cost is: zero queries whenever any
    // evidence exists, exactly ONE indexed read by primary key when none does.
    //
    // ⚠️ AND IT ADJUDICATES ALL THREE CLASSES, NOT JUST TRANSACTIONS. The
    // policies are Space-granular (see lib/ai/absence.ts), so "this Space is not
    // observable" is the one fact that explains every empty read in the census;
    // reporting NONE for snapshots while reporting UNKNOWN for transactions would
    // be two different claims about one refusal.
    const datedTxns   = txn._count.economicDate;
    const allTxns     = txn._count._all;
    const undatedTxns = allTxns - datedTxns;
    const sawNothing  = allTxns === 0 && snap.count === 0 && accounts.length === 0;
    if (sawNothing
        && await adjudicateAbsence(client as ReadClient, spaceId) === EvidenceState.INDETERMINATE) {
      return unknownEnvelope('SPACE_NOT_OBSERVABLE');
    }

    const established = {
      unavailability: null,
      transactions: {
        // ⚠️ AVAILABILITY IS ABOUT EXISTENCE, SO IT COUNTS EVERY ROW. An undatable
        // row is still evidence that the ledger is not empty; what it cannot do is
        // enter a range.
        availability: allTxns > 0 ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
        span: {
          fromISO: iso(txn._min.economicDate), toISO: iso(txn._max.economicDate),
          count: datedTxns,
          ...(undatedTxns > 0 ? { undatedCount: undatedTxns } : {}),
        },
      },
      snapshots: {
        availability: snap.count > 0 ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
        span: snap,
      },
      accounts: {
        cash:          count((t) => t === 'checking' || t === 'savings'),
        debt:          count((t) => t === 'debt'),
        investments:   count((t) => t === 'investment'),
        digitalAssets: count((t) => isDigitalAssetAccountType(t)),
        other:         count((t) => t === 'other'),
      },
      chains: [...byChain.values()].sort((a, b) => a.chain.localeCompare(b.chain)),
    } satisfies Omit<CoverageEnvelope, 'meaning'>;
    const meaning = coverageMeaning(established);
    return { ...established, ...(meaning ? { meaning } : {}) };
  } catch (err) {
    // Awareness is additive. A census failure must never cost the user an answer
    // — and it must not pass for one either, so UNKNOWN now renders as an
    // explicit "could not be established" rather than as silence.
    console.error('[coverage-envelope] census failed (non-fatal):', err);
    return unknownEnvelope('CENSUS_FAILED');
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** "Mar 2023" — coarse on purpose; a day-precise floor invites false precision. */
function month(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const [y, m] = isoDate.split('-');
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${NAMES[Number(m) - 1]} ${y}`;
}

/** What this turn actually assembled, as the renderer needs it. */
export interface LoadedTransactionInterval {
  fromISO: string;
  toISO:   string;
}

/**
 * The envelope, as the model reads it.
 *
 * AVAILABLE and LOADED are rendered by ONE function, on adjacent lines, from
 * two arguments. That is deliberate: the pair is the whole point, and a design
 * where one half is rendered here and the other three hundred lines away is a
 * design where they drift.
 *
 * Returns ONE line when nothing is known — see the UNKNOWN branch — so an
 * unestablished census advertises no range and no absence either.
 */
export function describeCoverageEnvelope(
  env: CoverageEnvelope,
  loaded: LoadedTransactionInterval | null,
): string[] {
  const lines: string[] = [];
  const t = env.transactions;

  // ⚠️ RLS-AI-S0 — THIS BRANCH USED TO RENDER AS SILENCE, AND SILENCE WAS NOT
  // ENOUGH. The module's original note was right that UNKNOWN must never cost an
  // answer, and nothing here costs one: no range is advertised, no total, no
  // conclusion. But a broken or refused authority that produces an answer with
  // NOTHING saying so is the second half of the same defect — the model has no
  // way to know the difference between "this Space holds nothing" and "we could
  // not look", and the rest of the prompt is full of invitations to assert the
  // first. One sentence, which is a PROHIBITION rather than a claim.
  if (t.availability === EvidenceAvailability.UNKNOWN) {
    // ⚠️ ONE WORDING, READ FROM `coverageMeaning`, NOT A SECOND COPY. The renderer
    // and the serialized object said the same thing in two places until S8; the
    // measured precedent for why that is a defect is `exact-temporal-predicates`,
    // where a hand-copied threshold drifted from the authority that owned it.
    lines.push(env.meaning ?? coverageMeaning(env) ?? 'EVIDENCE COVERAGE COULD NOT BE ESTABLISHED.');
    return lines;
  }

  lines.push(
    'EVIDENCE THAT EXISTS in this Space. This is NOT what was loaded below. ' +
    'Asked how far back your records go, answer from THESE ranges, not from the loaded window:',
  );

  if (t.availability === EvidenceAvailability.AVAILABLE && t.span.fromISO && t.span.toISO) {
    const wider = loaded !== null && loaded.fromISO > t.span.fromISO;
    // ⚠️ RLS-AI-S8 — THE UNDATABLE REMAINDER IS NAMED BESIDE THE RANGE, NOT ADDED
    // TO IT. The count is now the range's own denominator, so a reader can divide
    // it by the span without being wrong; the rows that could not be placed are
    // stated as existing-but-unplaceable, which licenses no claim about any period.
    const undated = t.span.undatedCount ?? 0;
    lines.push(
      `  Transactions EXIST ${month(t.span.fromISO)}–${month(t.span.toISO)} ` +
      `(${t.span.count.toLocaleString()} records)` +
      (undated > 0
        ? `, PLUS ${undated.toLocaleString()} further record(s) that exist but carry no economic `
          + 'date and so fall in NO period. Never fold those into a period total, and never '
          + 'describe them as missing.'
        : '') +
      (loaded
        ? wider
          // The sentence the whole slice exists for.
          ? `; this turn LOADED only ${loaded.fromISO} to ${loaded.toISO} — a selection from that ` +
            'record, not its limit. State the full range when asked what exists; quote figures ' +
            'only from the loaded period, since nothing else was computed.'
          : '; this turn loaded that full range.'
        : '.'),
    );
  } else if (t.availability === EvidenceAvailability.AVAILABLE) {
    // ⚠️ AVAILABLE WITH NO SPAN IS NOT ABSENCE, AND IT USED TO FALL THROUGH TO THE
    // `else` BELOW, which asserted the Space had none. Reachable today and nothing
    // to do with RLS: `economicDate` is nullable, so a ledger of entirely undated
    // rows makes the count positive and both bounds null.
    //
    // ⚠️ RLS-AI-S8 — AND THE FIGURE IT QUOTES IS NOW THE RIGHT ONE. `span.count` is
    // the DATED count, which is zero on this branch, so quoting it here would have
    // said "0 records exist" in the middle of a sentence insisting they do. The
    // undated count is the whole population here, by construction.
    const undated = t.span.undatedCount ?? 0;
    lines.push(
      `  Transactions EXIST (${undated.toLocaleString()} records) but none of them carries an `
      + 'economic date, so no range can be stated and no record belongs to any period. Do not '
      + 'say the Space has no transactions, and do not place them in a period.',
    );
  } else {
    // PROVEN_EMPTY. The census ran, it returned nothing, and the absence oracle
    // confirmed this identity can observe this Space — so this is the one state in
    // which asserting absence is licensed.
    lines.push('  Transactions: none recorded in this Space.');
  }

  const s = env.snapshots;
  if (s.availability === EvidenceAvailability.AVAILABLE && s.span.fromISO && s.span.toISO) {
    lines.push(`  Net-worth history: ${month(s.span.fromISO)}–${month(s.span.toISO)} (${s.span.count.toLocaleString()} daily points).`);
  }

  // Presence only. What these accounts HOLD is the accounts domain's business.
  const a = env.accounts;
  const present: string[] = [];
  if (a.cash)          present.push(`cash (${a.cash})`);
  if (a.debt)          present.push(`debt (${a.debt})`);
  if (a.investments)   present.push(`traditional investments (${a.investments})`);
  if (a.digitalAssets) present.push(`digital assets (${a.digitalAssets})`);
  if (a.other)         present.push(`other (${a.other})`);
  if (present.length > 0) {
    lines.push(`  Accounts with evidence: ${present.join(' · ')}.`);
    // Presence is not a licence to answer. Without this the model can read
    // "traditional investments (3)" as permission to describe a portfolio it
    // was never given.
    lines.push(
      '  Those accounts EXIST; their detail may not be loaded. If detail is missing, say so — ' +
      'never say the Space has none.',
    );
  }

  const claimed = env.chains.filter((c) => c.claimsHistory && c.fromISO);
  if (claimed.length > 0) {
    lines.push(
      `  Digital-asset QUANTITY history IS KNOWN for: ${claimed
        .map((c) => `${c.chain} ${month(c.fromISO)}–${month(c.toISO)}`)
        .join(' · ')}. Name these when asked what crypto history exists.`,
    );
    // The ETH case, stated as a rule rather than as a footnote about one chain.
    lines.push(
      '  Those prove HOW MUCH was held, not what it was worth. Valuation history is separate and ' +
      'shorter — never convert a quantity range into a portfolio-value range.',
    );
  }

  return lines;
}
