/**
 * lib/ai/absence.ts  (RLS-AI-S0)
 *
 * THE ABSENCE CONTRACT — "I did not obtain evidence" is not "the evidence does
 * not exist".
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Every table the AI surface reads is GRANTED to `fm_app`, so no AI read can
 * fail loudly. Row-level security has exactly one failure mode here: the SILENT
 * EMPTY SET. And this surface converts empty sets into declarative English which
 * it hands to a model as orientation evidence —
 *
 *     "Transactions: none recorded in this Space."
 *     "no dated transactions are available for this Space"
 *     "Nothing has been remembered for this user yet. Say so plainly…"
 *
 * — three sentences that are true of an empty Space and false of a refused one,
 * and byte-identical in both. The modules that produce them exist PRECISELY to
 * stop false absence (the 2×2 causal-evidence experiment `bb2f6ec` measured 11
 * of 18 negative answers over-claiming), so arming RLS without this contract
 * inverts the two mechanisms built to prevent the failure.
 *
 * ── THREE STATES, NEVER TWO ─────────────────────────────────────────────────
 *   PRESENT        evidence exists and is observable
 *   PROVEN_EMPTY   the authoritative operation ESTABLISHED that none matches
 *   INDETERMINATE  the operation cannot establish presence OR absence
 *
 * A two-valued `rows.length === 0` cannot represent the third, which is why this
 * is a type and not a convention.
 *
 * ── THE ORACLE: A CAPABILITY, NEVER A CLIENT ────────────────────────────────
 * ⚠️ THE PROBE RUNS THROUGH THE SAME CLIENT AS THE READ IT ADJUDICATES, and that
 * is enforced STRUCTURALLY rather than by review: the oracle is DERIVED from the
 * client that came back empty (`adjudicateAbsence(client, …)`), so there is no
 * argument through which a caller could hand it a wider authority. A probe on a
 * wider authority answers "the data exists" for data the reader cannot see —
 * the original bug plus a round trip.
 *
 * ── WHY ONE MEMBERSHIP PROBE ADJUDICATES THE WHOLE SURFACE ──────────────────
 * This is the load-bearing soundness argument and it is a property of the
 * policies, not an assumption. Every table this surface reads is reachable from
 * `fm_app` under exactly one of four predicates
 * (prisma/migrations/20261002000100_rls_roles_and_policies):
 *
 *   spaceId  IN (SELECT fm_visible_space_ids())            — SpaceSnapshot, AiAgent,
 *                                                            SpaceAccountLink, SpaceGoal…
 *   spaceId  IN (…) AND ownerUserId = current_fm_user_id() — SpaceMemory, DailyBrief
 *   fm_account_visible("financialAccountId")               — Transaction, Holding,
 *                                                            TransactionEvent, DebtProfile…
 *   no RLS at all (granted outright)                        — Instrument, PriceObservation,
 *                                                            FxRate, Merchant…
 *
 * and `fm_account_visible(a)` is `EXISTS(SpaceAccountLink WHERE financialAccountId = a
 * AND status = 'ACTIVE' AND spaceId IN (SELECT fm_visible_space_ids()))`. So an
 * account ACTIVE-linked into a VISIBLE Space is visible, and every row beneath it
 * is visible. **The policies are Space-granular: within a visible Space there is
 * no partial RLS filtering of the account subtree.** Therefore "may this identity
 * see this Space?" is both NECESSARY and SUFFICIENT, and ONE probe adjudicates
 * every empty read in a turn. (What a Space may see of an account it IS linked to
 * — `visibilityLevel` — stays application-owned by owner decision §38 Q1, and
 * `bankingTransactionWhere` already applies it. An empty set produced by that tier
 * is a legitimate PROVEN_EMPTY for this viewer.)
 *
 * ── WHY IT IS CORRECT ON THE MIGRATION PRINCIPAL TOO ────────────────────────
 * The probe is a POLICY-MEDIATED read, not a `current_fm_user_id()` comparison.
 * On `db`/`fm_system` every ACTIVE `SpaceMember` row is returned, so the verdict
 * is PROVEN_EMPTY and today's behaviour is preserved. A probe written as
 * `WHERE userId = current_fm_user_id()` would have returned INDETERMINATE for
 * every read on the owner client, which is why it is not written that way.
 *
 * ⚠️ RLS-AI-S10 — AND IT PROBES `SpaceMember`, NOT `Space`. The theorem audit
 * (lib/ai/evidence-authorities.test.ts) falsified the `Space` probe on its first
 * run: that policy ORs in `"isPublic" = true` and a platform-grant arm, neither of
 * which is membership, while every child policy reads `fm_visible_space_ids()` —
 * which is membership and nothing else. See the body for the full table.
 *
 * ── COST: ZERO ON THE SUCCESS PATH ──────────────────────────────────────────
 * The oracle is called ONLY when a read came back empty. A turn whose reads all
 * return rows adds no queries at all. A turn with N empty reads adds ONE query,
 * not N — see the memo below.
 */

// ⚠️ DELIBERATELY NO `import "server-only"`. This module holds no client and no
// secret — it takes an authority as a parameter and returns an enum — and it sits
// in the import graph of `coverage-envelope.ts` and `transaction-query.ts`, whose
// own suites run under plain `tsx` where that package does not resolve. The
// server-only guarantee is carried by the modules that hold the clients.
import type { ReadClient } from "@/lib/db/tenant-context";

/**
 * What an evidence operation established.
 *
 * ⚠️ `PROVEN_EMPTY` AND `INDETERMINATE` LICENSE DIFFERENT SENTENCES. The first
 * may be stated as absence; the second may only be stated as a failure to
 * establish. Collapsing them is the whole defect.
 */
export const EvidenceState = {
  PRESENT:       "PRESENT",
  PROVEN_EMPTY:  "PROVEN_EMPTY",
  INDETERMINATE: "INDETERMINATE",
} as const;

export type EvidenceStateKind = typeof EvidenceState[keyof typeof EvidenceState];

/** The two verdicts an EMPTY read can carry. `PRESENT` is not reachable here. */
export type AbsenceVerdict =
  | typeof EvidenceState.PROVEN_EMPTY
  | typeof EvidenceState.INDETERMINATE;

/**
 * Memo of POSITIVE verdicts only, keyed on the client object.
 *
 * ⚠️ ONLY `true` IS CACHED, AND THE ASYMMETRY IS THE SAFETY ARGUMENT. A cached
 * "visible" is sound because the only client it can outlive a request on is the
 * long-lived migration principal, for which the answer is unconditionally true;
 * on a tenant client the key is the transaction object itself, so the memo dies
 * at COMMIT. A cached "NOT visible" would be a cached INDETERMINATE: harmless in
 * direction but permanent for a Space that later becomes readable, so it is not
 * cached and the (rare, failure-path-only) probe simply runs again.
 *
 * WeakMap, so a finished transaction's client is collectable.
 */
const observable = new WeakMap<object, Set<string>>();

/** Exposed for tests only: forget what has been memoised for `client`. */
export function forgetObservability(client: ReadClient): void {
  observable.delete(client as unknown as object);
}

/**
 * How many probe queries this process has issued.
 *
 * ⚠️ DIAGNOSTIC ONLY, AND IT IS THE MEASUREMENT THE SLICE OWES. "Zero queries
 * added on the success path, one on the failure path" is a claim about THIS
 * counter, measured here rather than inferred from a driver log — `lib/db.ts`
 * does not enable Prisma's `query` event, and the acceptance suite must not need
 * it to (that file is not ours to configure).
 */
let probes = 0;
export const absenceProbesIssued = (): number => probes;
export const resetAbsenceProbeCount = (): void => { probes = 0; };

/**
 * ⚠️ THE ABSENCE ORACLE — a capability, never a client.
 *
 * Called ONLY on the empty path: one indexed read of `Space` by primary key,
 * under the SAME policy and the SAME client as the read that came back empty.
 * `INDETERMINATE` ⇒ the emptiness must never be rendered as absence.
 *
 * ⚠️ A THROWN PROBE IS `INDETERMINATE`, NOT A THROWN TURN. If we cannot ask the
 * question we certainly cannot assert the answer, and the fail-safe direction is
 * the one that refuses to speak.
 */
export async function adjudicateAbsence(
  client: ReadClient, spaceId: string,
): Promise<AbsenceVerdict> {
  if (typeof spaceId !== "string" || spaceId.length === 0) return EvidenceState.INDETERMINATE;
  const key = client as unknown as object;
  if (observable.get(key)?.has(spaceId)) return EvidenceState.PROVEN_EMPTY;
  try {
    // By PRIMARY KEY. `findFirst` rather than `findUnique` deliberately: a
    // `findUnique` on some Prisma versions can be served from a request-scoped
    // cache, and a cached row is not a policy evaluation.
    probes++;
    // ⚠️ RLS-AI-S10 — THE PROBE READS `SpaceMember`, NOT `Space`, AND THAT CHANGED
    // BECAUSE THE THEOREM AUDIT FALSIFIED THE OLD ONE ON ITS FIRST RUN.
    //
    // The probe used to be one `Space` row by primary key, on the argument that
    // "may this identity see this Space?" is necessary and sufficient. It is not,
    // because `fm_app_sel ON "Space"` has THREE arms, and only the first is
    // membership:
    //
    //   "id" IN (SELECT fm_visible_space_ids())
    //   OR "isPublic" = true                                   ← 20261002000400
    //   OR ("platformArea" IS NOT NULL AND EXISTS (PlatformGrant … ACTIVE … area))
    //
    // Every Space-granular CHILD policy reads `fm_visible_space_ids()`, which is
    // `SpaceMember WHERE userId = current_fm_user_id() AND status = 'ACTIVE'` and
    // contains NEITHER a public Space you have not joined nor a platform Space you
    // merely hold a grant on. So on both of those the old probe answered
    // "visible — PROVEN_EMPTY" truthfully about `Space` and falsely about the
    // evidence, and licensed exactly the sentence this module exists to forbid.
    // That is not hypothetical: RLS-C-S3 recorded that the Spaces launcher hands
    // PUBLIC Spaces the viewer has NOT joined to a net-worth reader, so a
    // non-member reaching a public Space is a shape the product already has.
    //
    // ⚠️ SO THE PROBE IS NOW A STRUCTURAL MIRROR OF THE FUNCTION THE CHILD POLICIES
    // ACTUALLY CONSULT, rather than of a table that happens to be reachable. One
    // indexed read of `SpaceMember` by (spaceId, status), and it is correct on
    // every client for the same reason the old one was correct on one of them:
    //
    //   migration principal   every ACTIVE member row returns  → PROVEN_EMPTY
    //                         (today's behaviour, preserved — the probe is still
    //                          POLICY-MEDIATED and not a current_fm_user_id()
    //                          comparison, which is what would have broken it)
    //   ACTIVE member         own row matches the policy's `userId` arm → PROVEN_EMPTY
    //   foreign private Space no arm matches                   → INDETERMINATE
    //   PUBLIC, not a member  no arm matches                   → INDETERMINATE  ← fixed
    //   platform grant only   no arm matches                   → INDETERMINATE  ← fixed
    //   REVOKED membership    own row fails `status: ACTIVE`    → INDETERMINATE  ← fixed
    //
    // ⚠️ AND IT NEEDS NO `platformArea` OR `isPublic` BRANCH, which is the point.
    // A probe written against the derived FUNCTION cannot drift from it when a
    // fourth arm is added to `Space`; a probe written against `Space` already had.
    //
    // ⚠️ ONE EDGE, STATED: a Space with no ACTIVE member at all is INDETERMINATE
    // even on the migration principal. That is an orphaned row no identity can
    // reach through any child policy, so refusing to speak about it is right.
    const member = await client.spaceMember.findFirst({
      where: { spaceId, status: "ACTIVE" }, select: { id: true },
    });
    if (!member) return EvidenceState.INDETERMINATE;
    let set = observable.get(key);
    if (!set) { set = new Set(); observable.set(key, set); }
    set.add(spaceId);
    return EvidenceState.PROVEN_EMPTY;
  } catch (err) {
    console.error("[absence] visibility probe failed; emptiness is INDETERMINATE:", err);
    return EvidenceState.INDETERMINATE;
  }
}

/**
 * The sentence an INDETERMINATE emptiness is allowed to produce, DERIVED from
 * the subject rather than quoted from the caller.
 *
 * ⚠️ DERIVED, BECAUSE A HAND-WRITTEN PAIR DRIFTS. `applied-facts` (54eb8e1) is
 * the recorded precedent: a verbatim `statedAs` rode a figure it could not model
 * all the way into a durable checkpoint. A caller here supplies a NOUN PHRASE,
 * never a sentence, so no caller can accidentally write an absence claim into the
 * indeterminate branch.
 */
export function indeterminateSentence(subject: string): string {
  return `whether this Space has ${subject} could NOT be established — this request could not `
    + "read the record. Say that the record could not be checked; do NOT say there is none, and "
    + "do not answer as though it were empty.";
}

/** An empty read, adjudicated, in the shape every tool in this layer refuses with. */
export interface AdjudicatedAbsence {
  unavailable: string;
  /** PROVEN_EMPTY or INDETERMINATE. Never omitted — the model reads this. */
  evidenceState: AbsenceVerdict;
}

/**
 * Turn an empty read into a refusal that says WHICH of the two it is.
 *
 * `proven` is the sentence for a Space that genuinely holds nothing; `subject` is
 * the noun phrase the indeterminate sentence is built from. Extra fields are
 * merged, so a caller keeps whatever context it already returned.
 */
export async function absent(
  client: ReadClient,
  spaceId: string,
  wording: { proven: string; subject: string },
  extra: Record<string, unknown> = {},
): Promise<AdjudicatedAbsence & Record<string, unknown>> {
  const verdict = await adjudicateAbsence(client, spaceId);
  return {
    ...extra,
    unavailable: verdict === EvidenceState.PROVEN_EMPTY
      ? wording.proven : indeterminateSentence(wording.subject),
    evidenceState: verdict,
  };
}

/**
 * The memory store's adjudication.
 *
 * ⚠️ MEMORY HAS A NARROWED CLIENT, SO THE SAME-CLIENT INVARIANT IS CHECKED, NOT
 * ASSUMED. `MemoryClient` is `Pick<TransactionClient, 'spaceMemory'>` — it cannot
 * reach `Space`, so the probe has to run through the context's read client. That
 * is only a probe of "the read that came back empty" when the two are the SAME
 * OBJECT, which is true at every construction site today (`memoryClient: db,
 * readClient: db`; one `tx` from `withTenantDb` on the memory API). When they are
 * not, this returns INDETERMINATE rather than adjudicating with an authority that
 * did not perform the read — the conservative direction, and the one that cannot
 * manufacture a false absence.
 */
export async function adjudicateMemoryAbsence(ctx: {
  spaceId: string; memoryClient: unknown; readClient: ReadClient;
}): Promise<AbsenceVerdict> {
  if ((ctx.memoryClient as unknown as object) !== (ctx.readClient as unknown as object)) {
    return EvidenceState.INDETERMINATE;
  }
  return adjudicateAbsence(ctx.readClient, ctx.spaceId);
}
