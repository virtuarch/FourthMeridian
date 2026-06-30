# D2 Step 6 — Closure Decision

**Decision-prep review only. No code, schema, or migration changes. No edits
to `D2_ROADMAP.md`, `provider-identity.ts`, or any other file.** Branch:
`feature/phase-2-architecture`. Baseline: `v2.3.0`.

Reviews `D2_STEP6_FIRST_PROVIDER_INVESTIGATION.md`'s conclusions against the
current code directly (not taken on trust) and decides what, if anything,
should close before D2-7 starts. See
`docs/initiatives/d2/D2_STEP7_PRODUCTION_HARDENING_INVESTIGATION.md` for the
D2-7 checklist this closure unblocks.

---

## 1. Should D2-6 simply be closed by updating D2_ROADMAP.md? **Yes.**

Re-verified directly, independent of the investigation's own claims:

- `app/api/accounts/wallet/route.ts` L103, L186, L269 — three
  `dualWriteProviderAccountIdentity(id, ProviderType.WALLET, walletAddress)`
  calls, confirmed by direct read of all three branches (active-match,
  archived-match, fresh create).
- `lib/imports/provider-capabilities.ts` — confirmed as written: a 20-line
  `Record<ImportSource, ImportProviderCapabilities>` covering all three
  `ImportSource` values, imported and called at
  `app/api/accounts/[id]/import/route.ts:344` and
  `.../import/preview/route.ts:271`, replacing what was a hardcoded
  `source === ImportSource.QUICKBOOKS` check.
- `lib/providers/plaid/adapter.ts` — confirmed as a 24-line pure re-export
  (`refreshItem`/`syncTransactions` pointing at the existing
  `lib/plaid/*` functions), matching the "D2-5 ✅ Plaid adapter boundary"
  status line.

Both Step 6 "first provider proof" candidates — wallet watch-only and
CSV import — are already real, shipped, exercised code, not something D2-6
needs to build. Recommend approving the investigation's §5 slices as
written:

- **D2-6-A**: split the Step 6 candidate list's single "Wallet/xpub" bullet
  into (1) wallet watch-only single-address — closed, cite
  `app/api/accounts/wallet/route.ts` + this investigation; (2) wallet xpub /
  multi-address / signed-message — stays open, unstarted, deferred to v2.7+.
  Also fix the Step 2 table's WALLET dual-write row (`D2_ROADMAP.md` L38,
  currently ⛔ "Not started") to ✅.
- **D2-6-B**: remove "CSV Import" from the Step 6 open-candidate list;
  record it as validated by D2-5 (commit `18f0922`).

This is a documentation-only edit, confined to `D2_ROADMAP.md`. No schema, no
migration, no application code, no UI.

## 2. Is the provider-identity.ts header comment worth fixing now?

**Recommend fixing now, bundled with D2-6-A — not deferred a fourth time.**

The same one-line staleness (`lib/accounts/provider-identity.ts` L18-19,
"nothing calls it with provider=WALLET today") has now been independently
flagged by three separate documents without ever being applied:
`D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md` §5 (first flag, explicitly
deferred), the WALLET-status finding in the untracked
`D2_STEP3_CLOSURE_REVIEW.md`, and now
`D2_STEP6_FIRST_PROVIDER_INVESTIGATION.md` §2/§5 again. Each rediscovery
costs a future investigation real effort re-confirming a fact already on
record twice.

The fix itself is a one-line comment edit with zero behavior risk —
confirmed by reading the function body (L40 onward): `dualWriteProviderAccountIdentity`'s
logic is untouched by anything in this recommendation. The project's
validation convention already runs `tsc`/`lint` on every change regardless
of size, so including this costs one extra file in the diff, not a second
approval cycle.

If the preference is to keep this docs-only step free of any `.ts` touch at
all, deferring again until the file is next opened for real work is a
reasonable alternative — just flagging that this is the third deferral, with
a near-certain fourth rediscovery otherwise.

## 3. Are any other roadmap/docs stale enough to justify updating now?

**One additional item, found in a document already sitting in the working
tree, not from a fresh audit:** `D2_ROADMAP.md` Step 3's WALLET phrasing —
L54 ("WALLET read cutover... blocked on the same WALLET identity semantics
question as 1C-C/Step 2") and the "Required notes" WALLET paragraph at L110
("stays blocked until those semantics are explicitly resolved").

The untracked `D2_STEP3_CLOSURE_REVIEW.md` (§4, §7) already established that
this phrasing is stale: the WALLET identity question isn't pending anymore —
`D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md` §5 resolved
it as a **permanent exclusion** (WALLET reads stay direct/owner-scoped by
design — a public address can't resolve through a globally-unique identity
table without leaking cross-owner existence) rather than an open decision
still awaiting resolution. That closure review recommended the wording fix
explicitly but didn't apply it, citing its own read-only scope.

Recommend bundling this as a third, independently-approvable edit in the
same `D2_ROADMAP.md` pass — same file, same WALLET-status thread already
being touched for D2-6-A, and it closes out the same kind of rediscovery risk
named in §2 above before a fourth investigation re-finds it.

No other staleness found. The rest of the D2 doc set was cross-checked
against current code only where this review's own claims depended on it
(Step 4/5 closure docs, the architecture doc's design-rationale sections) —
not re-audited line-by-line beyond that, per the task's "minimum necessary"
instruction.

## 4. Scope of documentation updates, if approved

All confined to `D2_ROADMAP.md`, plus one optional `.ts` comment:

1. Step 6 candidate list — split "Wallet/xpub" into closed (watch-only) /
   open (xpub) bullets. *(D2-6-A)*
2. Step 2 table, L38 — WALLET dual-write row, ⛔ → ✅. *(D2-6-A)*
3. Step 6 candidate list — remove "CSV Import," record as validated by D2-5.
   *(D2-6-B)*
4. Step 3, L54 + Required-notes L110 — reword WALLET phrasing from "blocked,
   pending a decision" to "permanently excluded from read cutover by design
   (D2 Step 1D §5)." *(new, §3 above)*
5. *(Optional, separable)* `lib/accounts/provider-identity.ts` L14-19 — fix
   the stale "nothing calls it with provider=WALLET today" line.

Nothing else. No schema, no migration, no UI. No historical investigation or
closure report gets rewritten — `D2_STEP3G_READ_CUTOVER_AUDIT.md`,
`D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md`, etc. remain
point-in-time records, since none of them have become factually incorrect —
only the live roadmap's status lines have drifted.

## Validation, if approved

- `npx prisma generate` / `migrate dev` — not expected to run; no schema
  change.
- `npx tsc --noEmit`, `npm run lint` — relevant only if item 5 (the optional
  comment fix) is included; expected no-op.
- `git diff` review confirming every changed line is markdown prose/table
  cells, plus (if item 5 is included) a single comment line with no logic
  change.

## Stop point

Nothing above is applied by virtue of appearing in this document. Items 1-5
in §4 need explicit approval — together or individually — before
`D2_ROADMAP.md` or `provider-identity.ts` is touched.
