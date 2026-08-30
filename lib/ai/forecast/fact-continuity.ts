/**
 * lib/ai/forecast/fact-continuity.ts
 *
 * FORECAST-13 — A FACT SURVIVES THE TURN IT WAS STATED IN. AN ASSUMPTION DOES NOT.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * FORECAST-12 measured it end to end. "Forecast my cash" → "No — $5,286.645 is
 * take-home. And my normal spending is $4,000 a month" → "Forecast it again."
 * The middle turn resolves SPENDING+INCOME and not FORECAST, so no forecast was
 * assembled, so the corrections were never routed to an authority; the third
 * turn re-read its own sentence and found nothing. A user corrected two facts
 * and the system discarded both.
 *
 * ── Why there is no store ───────────────────────────────────────────────────
 * The obvious repair is to capture the fact on the turn it appears and keep it
 * somewhere. The repository already answers this, twice, and both answers say
 * don't:
 *
 *   CF-4 carries the conversation's temporal scope across turns and holds NO
 *   state at all — `resolveConversationScope` re-reads the user messages every
 *   turn. There is nothing to desynchronise, nothing to invalidate, and the
 *   history is the single source of what the user said.
 *
 *   The Knowledge Gaps doctrine tells the user, in the prompt, that a value
 *   supplied in conversation "has NOT been saved". A durable store of asserted
 *   financial facts would make that sentence false.
 *
 * So this mirrors CF-4 exactly: facts are DERIVED from the user's own messages
 * on every turn. §1's requirement — that a fact reach the authority even though
 * the turn stating it asked for no forecast — is met not by capturing it early
 * but by never losing it: the sentence is still in the history when a forecast
 * is finally built.
 *
 * ⚠️ USER MESSAGES ONLY (§8). The scan filters `role === 'user'`, so nothing the
 * assistant said can create an authority. That is a property of the loop, not a
 * rule someone has to remember — an assistant that says "your paycheck is net"
 * has said nothing the user asserted, and a system that read its own prose back
 * as evidence would manufacture facts out of its own hedging.
 *
 * ⚠️ FACTS ONLY. `REQUESTS_ASSUMPTION` and `REQUESTS_SCENARIO` statements are
 * skipped here and stay per-turn, exactly as FORECAST-10 pinned them. "Assume I
 * spend $4,000" three turns ago must not silently price today's answer, and the
 * two semantics are kept apart by which function reads them.
 */

import { AmountBasis, type AmountBasisKind } from '@/lib/forecast/future-cash-event';
import { PeriodBasis, type PeriodBasisKind } from '@/lib/forecast/spending-baseline';
import { StatementMode } from '@/lib/forecast/policy';
import { extractForecastStatements, type ExtractedStatement } from './statements';
import type { ResolvedIncomeStream } from './streams';

/** A conversation turn, in the shape the chat route holds it. */
export interface FactMessage { role: string; content: string }

/** One fact the user asserted, and where in the conversation it came from. */
export interface AssertedFact {
  /** 0-based index among USER turns. Higher supersedes lower. */
  turn: number;
  statedAs: string;
}

export interface AssertedSpending extends AssertedFact {
  amount: number;
  currency: string;
  periodBasis: PeriodBasisKind;
}

export interface AssertedBasis extends AssertedFact {
  sourceKey: string;
  basis: AmountBasisKind;
  /** The figure that identified the stream, when the sentence named one. */
  identityAmount: number | null;
}

/** A claim that could not be attached to exactly one stream. Never guessed at. */
export interface AmbiguousClaim {
  turn: number;
  statedAs: string;
  reason: string;
}

export interface AssertedFacts {
  /** The level in force. Null when the user never stated one. */
  spending: AssertedSpending | null;
  /** Basis in force, per stream. */
  basis: AssertedBasis[];
  /** Facts a later turn replaced. Kept so a correction can be explained. */
  superseded: (AssertedSpending | AssertedBasis)[];
  /** Claims dropped for ambiguity, so the gap is visible rather than silent. */
  ambiguous: AmbiguousClaim[];
}

/**
 * Which stream a basis claim is about.
 *
 * ⚠️ THE AMOUNT IS THE IDENTITY (§6). A stated figure matches the stream whose
 * established level equals it, to the cent — never the stream that happens to
 * be closest, because "closest" is how $5,286.645 would attach itself to a
 * $5,015.68 payroll on a quiet day. With no figure the claim can only be about
 * a single unambiguous candidate; two candidates and it is dropped.
 */
function resolveStreamFor(
  identityAmount: number | null, streams: readonly ResolvedIncomeStream[],
): { sourceKey: string } | { reason: string } {
  const candidates = streams.filter((s) => s.projectionEligible && s.amount?.assertable);
  if (candidates.length === 0) return { reason: 'no income stream is licensed to carry a basis' };

  if (identityAmount !== null) {
    const matched = candidates.filter(
      (s) => Math.abs((s.amount as { value: number }).value - identityAmount) < 0.005);
    if (matched.length === 1) return { sourceKey: matched[0].sourceKey };
    return { reason: matched.length === 0
      ? `no income stream has an established amount of ${identityAmount}`
      : `${matched.length} income streams share an amount of ${identityAmount}` };
  }

  if (candidates.length === 1) return { sourceKey: candidates[0].sourceKey };
  return { reason: `${candidates.length} income streams could be meant and the statement names no amount` };
}

/**
 * Every fact the user has asserted in this conversation, latest in force.
 *
 * ⚠️ OLDEST TO NEWEST, LAST ONE WINS (§4). "$4,000 a month" then "actually make
 * that $5,000" leaves $5,000 in force and $4,000 in `superseded` — never an
 * average, never both, and never a choice left to the model. The ordering is
 * the conversation's own, so a correction is a correction by construction.
 */
export function resolveAssertedFacts(
  messages: readonly FactMessage[],
  asOfISO: string,
  streams: readonly ResolvedIncomeStream[],
): AssertedFacts {
  const userTurns = messages.filter((m) => m.role === 'user');
  const out: AssertedFacts = { spending: null, basis: [], superseded: [], ambiguous: [] };

  for (let turn = 0; turn < userTurns.length; turn++) {
    const ambiguousHere: AmbiguousClaim[] = [];
    // ⚠️ THE ANTECEDENT IS WHAT THE CONVERSATION HAS ALREADY ESTABLISHED, so a
    // correction can only revise something the user actually said. It is
    // rebuilt each turn from what is in force at that point, which is what
    // makes "actually make that $5,000" a correction of $4,000 and not a
    // free-floating number.
    const antecedent = out.spending
      ? { kind: 'SPENDING_LEVEL' as const, currency: out.spending.currency,
        periodBasis: out.spending.periodBasis }
      : undefined;
    const statements: ExtractedStatement[] = extractForecastStatements(
      userTurns[turn].content, asOfISO,
      (identityAmount) => {
        const r = resolveStreamFor(identityAmount, streams);
        if ('sourceKey' in r) return r.sourceKey;
        ambiguousHere.push({ turn, statedAs: userTurns[turn].content.trim(), reason: r.reason });
        return null;
      },
      antecedent);
    out.ambiguous.push(...ambiguousHere);

    for (const st of statements) {
      // ⚠️ Facts only. A supposition read here would become permanent, which is
      // the one thing FORECAST-10 pinned it must never be.
      if (st.mode !== StatementMode.ASSERTS_FACT) continue;
      if (st.routing.destination !== 'UPSTREAM_AUTHORITY' || !st.routing.reachable) continue;
      const sub = st.routing.subject;

      if (sub.kind === 'SPENDING_LEVEL') {
        if (out.spending) out.superseded.push(out.spending);
        out.spending = {
          turn, statedAs: st.statedAs, amount: sub.amount,
          currency: sub.currency, periodBasis: sub.periodBasis,
        };
      } else if (sub.kind === 'STREAM_AMOUNT_BASIS' && sub.basis !== AmountBasis.UNKNOWN) {
        const prior = out.basis.findIndex((b) => b.sourceKey === sub.sourceKey);
        const next: AssertedBasis = {
          turn, statedAs: st.statedAs, sourceKey: sub.sourceKey,
          basis: sub.basis, identityAmount: st.identityAmount,
        };
        if (prior >= 0) { out.superseded.push(out.basis[prior]); out.basis[prior] = next; }
        else out.basis.push(next);
      }
    }
  }
  return out;
}

/** A compact statement of what the user has established, for the prompt. */
export function describeAssertedFacts(f: AssertedFacts): string[] {
  const lines: string[] = [];
  if (f.spending) {
    lines.push(`  - ordinary spending ${f.spending.currency} ${f.spending.amount.toFixed(2)} per `
      + `${f.spending.periodBasis === PeriodBasis.MONTHLY ? 'month' : '28 days'}: "${f.spending.statedAs}"`);
  }
  for (const b of f.basis) {
    lines.push(`  - ${b.sourceKey}'s amount is ${b.basis}: "${b.statedAs}"`);
  }
  for (const s of f.superseded) {
    lines.push(`  - SUPERSEDED by a later correction, do not use: "${s.statedAs}"`);
  }
  for (const a of f.ambiguous) {
    lines.push(`  - NOT APPLIED (${a.reason}), ask which one is meant: "${a.statedAs}"`);
  }
  return lines;
}
