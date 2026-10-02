/**
 * lib/ai/evidence-authorities.ts  (RLS-AI-S10)
 *
 * THE SPACE-PROBE THEOREM, WRITTEN DOWN WHERE IT CAN BE FALSIFIED.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `adjudicateAbsence()` performs ONE read — an ACTIVE `SpaceMember` row for the
 * Space — and from its outcome licenses or forbids an absence sentence about
 * EVERY empty read in the turn: transactions, snapshots, holdings, accounts,
 * memory. That is a very large claim resting on a very small query, and it is
 * sound only because of a property of the POLICIES rather than of this code:
 *
 *     every table the AI evidence graph reads is reachable by `fm_app` under a
 *     predicate DERIVED FROM `fm_visible_space_ids()` — which is itself
 *     `SpaceMember WHERE userId = current_fm_user_id() AND status = 'ACTIVE'` —
 *     so "is this identity an ACTIVE member of this Space?" is both necessary
 *     and sufficient to explain any empty read in it.
 *
 * ⚠️ THE FIRST RUN OF THE TEST BESIDE THIS FILE FALSIFIED THE PREVIOUS VERSION OF
 * THAT SENTENCE, WHICH IS THE BEST ARGUMENT FOR WRITING IT DOWN LIKE THIS. The
 * oracle used to probe `Space`, on the reasoning that Space visibility implies
 * child visibility. It does not: `fm_app_sel ON "Space"` ORs in
 * `"isPublic" = true` (added later, by 20261002000400_rls_membership_bootstrap)
 * and a platform-grant arm, and NEITHER puts the Space in
 * `fm_visible_space_ids()`. A non-member reaching a PUBLIC Space — a shape
 * RLS-C-S3 found the Spaces launcher already produces — was therefore told
 * PROVEN_EMPTY about evidence it simply could not read. The oracle now mirrors
 * the FUNCTION rather than a table that happens to be reachable.
 *
 * ⚠️ THAT THEOREM WAS ARCHITECTURAL PROSE IN `lib/ai/absence.ts`, AND PROSE
 * CANNOT FAIL. A future slice adding one evidence source on a `userId =
 * current_fm_user_id()` table — `CreditScore`, `Notification`, `PlaidItem`,
 * `Connection` are all granted to `fm_app` and all one import away — would leave
 * `adjudicateAbsence()` syntactically correct and semantically false, and nothing
 * would go red. This registry plus `evidence-authorities.test.ts` is the thing
 * that goes red.
 *
 * ── WHAT IS MECHANICAL AND WHAT IS CONVENTIONAL, STATED HONESTLY ────────────
 * MECHANICAL (the test fails the build, with no reviewer in the loop):
 *   1. every model listed below has its ACTUAL `fm_app` SELECT predicate
 *      re-derived from the committed migration SQL and compared against the
 *      family claimed here. A policy edit that changes a family breaks the build.
 *   2. every family claimed here must be in the ADJUDICABLE set, or carry an
 *      explicit `narrowing` — there is no third option and no default.
 *   3. every Prisma model read ANYWHERE under `lib/ai/**`, including through a
 *      nested relation `select`, must appear below. A new model read from the AI
 *      tree without a classification breaks the build.
 *   4. the leaf modules OUTSIDE `lib/ai/**` that the evidence graph calls are a
 *      pinned list, and a new `.<model>.<read>` in one of them that is not
 *      classified breaks the build.
 *
 * CONVENTIONAL (a reviewer is still in the loop):
 *   adding a NEW leaf module to the evidence graph. The test cannot discover a
 *   module the graph did not call yesterday, so `EVIDENCE_LEAF_MODULES` is a
 *   ratchet: the list is asserted to match what the AI tree imports, and growing
 *   the graph forces an edit here. That edit is the moment a human classifies.
 *
 * ⚠️ AND THE ONE PLACE A GREP WOULD HAVE LIED. `SpaceAccountLink.addedByUser`
 * reaches `User`, whose policy is `"id" = current_fm_user_id()` — NOT
 * Space-granular, and invisible to any scan for `client.user.findMany`. It is a
 * RELATION SELECT. The discovery pass below therefore resolves relation field
 * names through `prisma/schema.prisma` instead of looking for delegate calls,
 * because the delegate-call scan is exactly the blind spot that let this slice's
 * predecessor audit report clean over a dynamic import.
 */

/**
 * How a table is reachable by `fm_app`, by the SHAPE of its SELECT predicate.
 *
 * ⚠️ THESE ARE THE SHAPES THE MIGRATION ACTUALLY WRITES, not a taxonomy invented
 * here. Each one is re-derived from `prisma/migrations/**` by the test beside
 * this file; the strings in `FAMILY_PREDICATE` are what it compares against.
 */
export const PolicyFamily = {
  /** `"spaceId" IN (SELECT fm_visible_space_ids())` */
  SPACE_GRANULAR: 'SPACE_GRANULAR',
  /** …that, `AND "ownerUserId" = current_fm_user_id()`. */
  SPACE_AND_OWNER: 'SPACE_AND_OWNER',
  /** `fm_account_visible("financialAccountId")` — the account subtree. */
  ACCOUNT_SUBTREE: 'ACCOUNT_SUBTREE',
  /** `"ownerUserId" = current_fm_user_id() OR fm_account_visible("id")`. */
  ACCOUNT_ROOT: 'ACCOUNT_ROOT',
  /** The `Space` row itself — three arms, only one of which is membership. */
  SPACE_ROOT: 'SPACE_ROOT',
  /** `SpaceMember`: the Space arm OR your own row. WHAT THE ORACLE PROBES. */
  SPACE_MEMBERSHIP: 'SPACE_MEMBERSHIP',
  /** No row-level security at all: granted outright, belongs to no tenant. */
  GLOBAL_REFERENCE: 'GLOBAL_REFERENCE',
  /**
   * Reachable, but under a predicate the Space probe CANNOT adjudicate.
   *
   * ⚠️ AN ENTRY HERE IS A DECLARED DEFECT, NOT A CATEGORY. It must carry a
   * `narrowing` sentence saying exactly what the tenant flip costs, and the count
   * of such entries is pinned by the test — so one appearing by accident fails
   * the build and one appearing on purpose is a decision somebody wrote down.
   */
  NOT_SPACE_ADJUDICABLE: 'NOT_SPACE_ADJUDICABLE',
} as const;

export type PolicyFamilyKind = typeof PolicyFamily[keyof typeof PolicyFamily];

/**
 * The normalised SELECT predicate each family asserts, exactly as the migration
 * writes it (whitespace-collapsed). The test re-derives the real one and compares.
 */
export const FAMILY_PREDICATE: Record<string, string | null> = {
  [PolicyFamily.SPACE_GRANULAR]:
    '"spaceId" IN (SELECT fm_visible_space_ids())',
  [PolicyFamily.SPACE_AND_OWNER]:
    '"spaceId" IN (SELECT fm_visible_space_ids()) AND "ownerUserId" = current_fm_user_id()',
  [PolicyFamily.ACCOUNT_SUBTREE]:
    'fm_account_visible("financialAccountId")',
  [PolicyFamily.ACCOUNT_ROOT]:
    '"ownerUserId" = current_fm_user_id() OR fm_account_visible("id")',
  [PolicyFamily.SPACE_MEMBERSHIP]:
    '"spaceId" IN (SELECT fm_visible_space_ids()) OR "userId" = current_fm_user_id()',
  // SPACE_ROOT and GLOBAL_REFERENCE are checked structurally, not by this string:
  // the first is pinned to its exact three arms inside the test (a fourth one must
  // be classified before anything relies on `Space`), and the second is defined by
  // the ABSENCE of `ENABLE ROW LEVEL SECURITY`.
  [PolicyFamily.SPACE_ROOT]: null,
  [PolicyFamily.GLOBAL_REFERENCE]: null,
  [PolicyFamily.NOT_SPACE_ADJUDICABLE]: null,
};

/**
 * The families the ONE MEMBERSHIP probe can soundly adjudicate.
 *
 * ── THE SOUNDNESS ARGUMENT, PER FAMILY ──────────────────────────────────────
 * SPACE_GRANULAR / SPACE_AND_OWNER / ACCOUNT_SUBTREE
 *   All three are implied by Space visibility, and `fm_account_visible(a)` is
 *   itself `EXISTS(SpaceAccountLink … ACTIVE … spaceId IN fm_visible_space_ids())`,
 *   so an account linked into a visible Space carries its whole subtree. Visible
 *   Space ⇒ every row of it is readable ⇒ an empty read is genuinely empty.
 *
 * ACCOUNT_ROOT
 *   A strict SUPERSET of ACCOUNT_SUBTREE's reach (it ORs in your own accounts).
 *   A superset can only ADD rows, never hide ones the Space-granular arm would
 *   have shown — so PROVEN_EMPTY stays sound and INDETERMINATE stays safe.
 *
 * SPACE_MEMBERSHIP
 *   Same shape: the Space arm plus your own row. Superset again.
 *
 * SPACE_ROOT
 *   What the probe reads. Its second arm (platform grants) is NOT membership, so
 *   the oracle treats a Space carrying a `platformArea` as INDETERMINATE —
 *   see lib/ai/absence.ts. That handling is a PRECONDITION of this theorem and
 *   the test asserts the policy still has exactly that shape.
 *
 * GLOBAL_REFERENCE
 *   No RLS at all. An exchange rate, an instrument or a merchant belongs to no
 *   tenant, so an empty read of one is a fact about the deployment and not about
 *   this identity. Classified EXPLICITLY — the brief's requirement — rather than
 *   silently routed through migration authority.
 */
export const SPACE_ADJUDICABLE: readonly PolicyFamilyKind[] = [
  PolicyFamily.SPACE_GRANULAR,
  PolicyFamily.SPACE_AND_OWNER,
  PolicyFamily.ACCOUNT_SUBTREE,
  PolicyFamily.ACCOUNT_ROOT,
  PolicyFamily.SPACE_ROOT,
  PolicyFamily.SPACE_MEMBERSHIP,
  PolicyFamily.GLOBAL_REFERENCE,
];

export interface EvidenceAuthority {
  family: PolicyFamilyKind;
  /** Why this source is in the evidence graph at all. One line. */
  why: string;
  /**
   * REQUIRED on NOT_SPACE_ADJUDICABLE and forbidden elsewhere: what the tenant
   * flip costs on this source, in the user's terms.
   */
  narrowing?: string;
}

/**
 * EVERY Prisma model the live AI evidence graph reads, classified.
 *
 * ⚠️ CLOSED, NOT A DENYLIST. The test discovers reads (delegate calls AND nested
 * relation selects, resolved through the schema) and fails on anything absent
 * here — the same invariant shape the V26 memory payloads use, for the same
 * reason: a denylist is a list of the mistakes somebody already thought of.
 */
export const AI_EVIDENCE_AUTHORITIES: Readonly<Record<string, EvidenceAuthority>> = {
  // ── The probe's own subject ────────────────────────────────────────────────
  Space: { family: PolicyFamily.SPACE_ROOT,
    why: 'assemblers read reportingCurrency from it; the oracle NO LONGER probes it (S10)' },

  // ── Space-granular ─────────────────────────────────────────────────────────
  SpaceAccountLink: { family: PolicyFamily.SPACE_GRANULAR,
    why: 'the account scope of every assembler and of fm_account_visible itself' },
  SpaceSnapshot: { family: PolicyFamily.SPACE_GRANULAR,
    why: 'the net-worth history domain' },
  SpaceDashboardSection: { family: PolicyFamily.SPACE_GRANULAR,
    why: 'the DECLARED monthly-expense baseline the transactions assembler reads' },
  AiAgent: { family: PolicyFamily.SPACE_GRANULAR,
    why: 'the agent id the chat route resolves before opening a transcript' },
  // ⚠️ NO SpaceGoal ENTRY, DELIBERATELY. The model still exists in the schema and
  // still carries a SPACE_GRANULAR policy, so deriving this registry from the
  // migration alone puts it here — which is how it first arrived, described as
  // "goal evidence on the Brief and the starter topics". That evidence does not
  // exist: the goals surface was tombstoned, lib/ai/assemblers/goals.ts and
  // lib/ai/signals/detectors/goals.ts are deleted, and no AI path reads the table
  // (grep: zero `spaceGoal` references under lib/ai/** or app/api/ai/**).
  //
  // scripts/audit-goals-tombstone.ts caught it: no runtime source may speak the
  // retired vocabulary. That audit and this registry are both right, and the
  // resolution is not to exempt one from the other — it is that THIS REGISTRY
  // CLASSIFIES SOURCES THE AI GRAPH ACTUALLY READS, not every table a policy
  // happens to cover. A registry that drifts toward "every policied table" stops
  // being a statement about the evidence graph and starts being a copy of the
  // migration, which is the thing it exists to be checked against.
  AiAdvice: { family: PolicyFamily.SPACE_GRANULAR,
    why: 'the seeded advice row the Brief reads' },

  // ── Space-granular AND user-private ────────────────────────────────────────
  SpaceMemory: { family: PolicyFamily.SPACE_AND_OWNER,
    why: 'what this user asked us to remember, in this Space' },
  DailyBrief: { family: PolicyFamily.SPACE_AND_OWNER,
    why: 'the per-(Space, owner) Brief row' },

  // ── Membership ─────────────────────────────────────────────────────────────
  SpaceMember: { family: PolicyFamily.SPACE_MEMBERSHIP,
    why: 'the ABSENCE ORACLE itself probes it (S10), plus the account-link owner scope' },

  // ── The account root and its subtree ───────────────────────────────────────
  FinancialAccount: { family: PolicyFamily.ACCOUNT_ROOT,
    why: 'the account rows every balance, holding and transaction read hangs off' },
  Transaction: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the ledger — the summary, the drilldown, the corpus span, the census' },
  TransactionEvent: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the one-row-per-logical-event projection the population filters on' },
  TransactionObservation: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'pending/posting observation history behind the balance authority' },
  PositionObservation: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the canonical investment and wallet quantity spine' },
  PositionReconstruction: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the reconciliation verdict the valuation residue guard reads' },
  PositionCoverage: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the persisted wallet-history licence the coverage envelope reports' },
  InvestmentEvent: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the quantity authority s decision ledger' },
  InvestmentEventCoverage: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'event coverage behind the quantity authority' },
  Holding: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'reachable as a FinancialAccount relation; the AI holdings path reads none (P2-4/W5)' },
  DebtProfile: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'user-entered APR, minimum and due day on the accounts assembler' },
  AccountConnection: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the needs-reauth check, through FinancialAccount.connections' },
  ImportBatch: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'the provenance source a transaction row derives' },
  ProviderAccountIdentity: { family: PolicyFamily.ACCOUNT_SUBTREE,
    why: 'wallet identity on the crypto current-value path' },

  // ── Global reference data: NO row-level security, classified EXPLICITLY ────
  Instrument: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'symbol, name and asset class; identical for every tenant' },
  InstrumentAlias: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'symbol resolution; identical for every tenant' },
  PriceObservation: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'the dated price archive every valuation reads' },
  CorporateActionTerms: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'split and dividend terms applied to a quantity timeline' },
  FxRate: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'the conversion archive behind buildSpaceConversionContext' },
  Merchant: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'resolved merchant display names on transaction rows' },
  MerchantAlias: { family: PolicyFamily.GLOBAL_REFERENCE,
    why: 'merchant resolution; reachable as a Merchant relation' },

  // ── Declared narrowings: the probe CANNOT adjudicate these ─────────────────
  User: {
    family: PolicyFamily.NOT_SPACE_ADJUDICABLE,
    why: 'SpaceAccountLink.addedByUser.{firstName,name} — who shared an account into the Space',
    narrowing:
      'The policy is `"id" = current_fm_user_id()`, which is NOT Space-granular, so in a '
      + 'SHARED Space a CO-MEMBER\'s display name comes back null under the tenant client and '
      + 'the accounts assembler renders its existing third fallback instead. It is a NARROWING '
      + 'of a NAME and never of a figure: no balance, total, transaction or date is affected, '
      + 'and nothing becomes visible that was not. The Space probe cannot explain this '
      + 'emptiness, which is why it is declared here rather than classified as adjudicable.',
  },
  PlaidItem: {
    family: PolicyFamily.NOT_SPACE_ADJUDICABLE,
    why: 'AccountConnection.plaidItem.status — the NEEDS_REAUTH flag on the accounts assembler',
    narrowing:
      'The policy is `"userId" = current_fm_user_id()`, NOT Space-granular. It costs nothing '
      + 'TODAY, and the reason is a conjunction worth writing down rather than rediscovering: '
      + 'the assembler only ever consults a connection for which '
      + '`connectedByUserId === spaceCtx.userId`, and a PlaidItem connected by a user is that '
      + 'user\'s own item — so the policy returns exactly the set the application had already '
      + 'filtered down to. If that `connectedByUserId` filter is ever relaxed, the flag '
      + 'silently becomes a FALSE NEGATIVE for a co-member\'s account, and this entry is the '
      + 'place that says so.',
  },
};

/**
 * The modules OUTSIDE `lib/ai/**` that the live evidence graph calls.
 *
 * ⚠️ A RATCHET, AND THE HONEST NAME FOR IT. The test cannot discover a leaf the
 * graph does not call yet, so growing the graph requires editing this list — and
 * that edit is where a human classifies the new authority. Everything the list
 * NAMES is then scanned mechanically.
 */
export const EVIDENCE_LEAF_MODULES: readonly string[] = [
  'lib/data/transaction-query.ts',
  'lib/data/snapshots.ts',
  'lib/data/banking-population.ts',
  'lib/balances/pending-evidence.ts',
  'lib/accounts/space-account-link.ts',
  'lib/crypto/wallet-current-value.ts',
  'lib/crypto/wallet-history-metadata.ts',
  'lib/transactions/transfer-resolution.ts',
  'lib/investments/current-positions.ts',
  'lib/investments/valuation.ts',
  'lib/investments/reconstruction-read.ts',
  'lib/investments/quantity-authority.ts',
  'lib/investments/quantity-timeline.ts',
  'lib/money/server-context.ts',
  'lib/fx/archive.ts',
  'lib/prices/archive.ts',
];

/**
 * Relation FIELD names that exist on more than one model, and what they mean HERE.
 *
 * ⚠️ A HUMAN DECISION, DECLARED, BECAUSE THE SCAN CANNOT MAKE IT. `connections`
 * is `User.connections → Connection` AND
 * `FinancialAccount.connections → AccountConnection`; resolving it by name alone
 * would either classify a table nobody reads (inflating the declared-narrowing
 * count with a fiction) or pick one silently. The test asserts that every
 * ambiguous relation name the graph actually uses appears here, so the ambiguity
 * is resolved by a reviewer once rather than guessed on every run.
 *
 * ⚠️ AND THE RESOLUTION IS LOAD-BEARING, NOT COSMETIC. `AccountConnection` is in
 * the ACCOUNT_SUBTREE family and the Space probe adjudicates it; `Connection` is
 * `"userId" = current_fm_user_id()` and it does NOT. Getting this wrong in either
 * direction is a wrong answer about the theorem.
 */
export const AMBIGUOUS_RELATIONS: Readonly<Record<string, { model: string; why: string }>> = {
  connections: {
    model: 'AccountConnection',
    why: 'the accounts assembler selects it under `financialAccount`, so it is '
      + 'FinancialAccount.connections (AccountConnection), never User.connections. '
      + 'Verified against prisma/schema.prisma: FinancialAccount.connections is '
      + 'AccountConnection[]; the Connection relation on User is not reachable from '
      + 'any select in this graph.',
  },
};

/** Declared narrowings, pinned. A new one must move this number deliberately. */
export const DECLARED_NARROWING_COUNT = 2;
