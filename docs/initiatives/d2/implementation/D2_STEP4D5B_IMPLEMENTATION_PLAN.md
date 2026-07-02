> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5b — `ImportMappingProfile` Schema + Resolver Architecture (Implementation Plan)

Planning only. No code, schema, or migration changes. Per the standing working style and your explicit "do not implement yet" instruction. Builds directly on the approved direction in `docs/initiatives/d2/D2_ARCHITECTURE_REVIEW_PRE_4D5B.md`: trial-apply matching (not a header-set hash), `ImportBatch.resolvedColumnMapping`, and centralized resolution/validation.

Scope: persist a Space-scoped saved column mapping and auto-use it on a matching upload. No UI, no preview, no fuzzy suggestions, no QuickBooks, no provider-adapter work, no widening of `HEADER_ALIASES`, no rework of CSV/Excel row normalization beyond the column-resolution stage.

---

## 1. `ImportMappingProfile` schema

```prisma
model ImportMappingProfile {
  id                String        @id @default(cuid())

  spaceId           String
  space             Space         @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  name              String
  source            ImportSource  // informational only — NOT part of the matching key (see §4)
  institutionLabel  String?       // informational only, e.g. "Chase" — same role as source

  // Resolved CsvColumnMap shape, all 8 keys present (header string or null).
  // This is applyExplicitMapping()'s second-parameter shape exactly — see §3.
  mapping           Json

  createdByUserId   String?
  createdByUser     User?         @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  lastUsedAt        DateTime?
  useCount          Int           @default(0)

  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  importBatches     ImportBatch[]

  @@unique([spaceId, name])
  @@index([spaceId])
  @@index([createdByUserId])
}
```

Notes against your starting point:

- No `headerSignature`/hash column. That was the one piece of the original Part B design this plan deliberately drops — see §4.
- `source`/`institutionLabel` mirror the sequencing proposal's §6 recommendation: display metadata, never consulted by the matcher.
- `lastUsedAt`/`useCount` included as you proposed. They cost nothing extra at write time (the auto-use path already touches this row to read `mapping`; bumping two columns on the same row is the same write, not a second round-trip) and give §4's deterministic tie-break something concrete to sort on. If you'd rather cut them until a profile-list UI actually needs them, that's a reasonable minimalism call too — flagging as the one piece of this schema that isn't strictly forced by 4D-5b's own matching logic.
- `@@unique([spaceId, name])` is new, not in your starting list — a cheap guard against silently accumulating duplicate-named profiles in one Space. Drop it if you'd rather allow duplicates.
- `createdByUserId` is display-only, mirroring `ImportBatch.createdByUserId`'s existing precedent exactly (nullable, `onDelete: SetNull`) — not used for any authorization decision (see §9).

Back-relations needed: `Space.importMappingProfiles ImportMappingProfile[]`, `User.importMappingProfiles ImportMappingProfile[]` (no `@relation` name required — this is the only `User`↔`ImportMappingProfile` relation).

## 2. `ImportBatch` schema change

```prisma
model ImportBatch {
  // ...existing fields unchanged...

  resolvedColumnMapping Json?    // snapshot of the actual CsvColumnMap used, all paths — see §2 of the review doc
  mappingProfileId      String?
  mappingProfile        ImportMappingProfile? @relation(fields: [mappingProfileId], references: [id], onDelete: SetNull)

  @@index([mappingProfileId]) // additive — existing indexes unchanged
}
```

`resolvedColumnMapping` is written once at batch-creation time on every import, regardless of which of the three resolver paths produced it (auto-detect, ad hoc explicit mapping, or saved-profile trial-apply) — this is the auditability fix the review flagged. `mappingProfileId` is set only on the third path (a saved profile was actually auto-used); it's `null` for the other two. Deliberately *not* adding a separate "which path was used" enum: `mappingProfileId` non-null already tells you "saved profile," and `resolvedColumnMapping` tells you exactly what was used either way — a finer-grained path label would be true but redundant with information these two fields already carry, and nothing today needs to distinguish "auto-detected" from "ad hoc explicit mapping, not saved" any more granularly than that. Flagging this as a considered-and-rejected addition rather than an oversight.

`onDelete: SetNull` on `mappingProfileId` (not `Cascade`) is deliberate: deleting a profile later (4D-5c) must not delete or corrupt historical `ImportBatch` rows — `resolvedColumnMapping`'s snapshot is independent of the profile still existing, so a batch's audit trail survives the profile's deletion.

## 3. Should `ImportMappingProfile.mapping` use the same shape as `columnMapping`?

Yes, with one refinement: persist the **resolved** `CsvColumnMap` (post-validation, all 8 keys present, each a header string or explicit `null`), not the caller's raw, possibly-partial input object. Two reasons:

- `Json` can't represent `undefined`, only absent keys or `null` — persisting the resolved, fully-keyed shape avoids any ambiguity about what an absent key in storage means.
- It means `profile.mapping` can be handed directly to `applyExplicitMapping()` unmodified for both matching (§4) and re-applying — no shape translation step between "the thing we matched with" and "the thing we stored," which is the same collapsing-two-operations-into-one property the review's centerpiece finding relies on.

Concretely: when a profile is created (4D-5c, out of scope here, but worth fixing the contract now since 4D-5b's schema is what locks it in), it stores the already-successful return value of `applyExplicitMapping()`, not `req.body.columnMapping` verbatim.

## 4. Matching mechanism

```ts
function profileMatches(profile: ImportMappingProfile, headers: string[]): boolean {
  const result = applyExplicitMapping(headers, profile.mapping as Record<string, string | null>);
  return !("error" in result);
}
```

That's the entire algorithm — no new code beyond this one-line wrapper, which exists only for readability at call sites, not because any new logic is needed. "Does this profile still apply" and "apply this profile" are the same call, per the review's §5/§6. An unrelated new column on the uploaded file is invisible to this check (it's just one more header `applyExplicitMapping()` never looks at); a renamed or removed column the mapping depends on correctly fails it, prompting re-mapping exactly as it would today. No `headerSignature` comparison, no hashing, nothing to keep in sync with `applyExplicitMapping()`'s own logic as a separate piece of code.

## 5. Centralizing column resolution

Two new functions in `lib/imports/csv.ts`, both pure (no DB access):

**`validateResolvedColumns()`** — extracts the three required-field rules `detectColumns()` (lines ~91–99) and `applyExplicitMapping()` (lines ~175–184) currently duplicate, *without* changing either function's existing error wording:

```ts
type ColumnValidationFailure = "date" | "merchantOrDescription" | "amountOrDebitCredit";

function validateResolvedColumns(resolved: {
  date: string | null; merchant: string | null; description: string | null;
  amount: string | null; debit: string | null; credit: string | null;
}): ColumnValidationFailure | null {
  if (!resolved.date) return "date";
  if (!resolved.merchant && !resolved.description) return "merchantOrDescription";
  if (!resolved.amount && !(resolved.debit || resolved.credit)) return "amountOrDebitCredit";
  return null;
}
```

`detectColumns()` and `applyExplicitMapping()` each call this and translate the returned code into their own existing, distinct message strings (so `detectColumns()`'s `"Could not find a date column. Expected one of: ..."` and `applyExplicitMapping()`'s `"Column mapping did not specify a date column."` both still appear exactly as today — centralizing the *rule*, not the *wording*, preserving every string in the 4D-5a validation report byte-for-byte).

This does mean `detectColumns()`'s body changes (its 3 inline `if` checks become a call to `validateResolvedColumns()` plus a switch producing the same 3 messages). Flagging explicitly since your brief says `detectColumns()` should stay untouched as the fast path: `HEADER_ALIASES` and the alias-matching algorithm itself are 100% untouched either way; the only question is whether its required-field check specifically gets extracted too, or stays duplicated a third time once the saved-profile path needs the same check. Recommend extracting it (Option A) since leaving it (Option B) means the exact duplication the review flagged persists indefinitely with no remaining reason to. Either is fine to approve — flagging as a explicit yes/no rather than assuming.

**`resolveColumns()`** — the new shared orchestrator both `route.ts` and `excel.ts` call instead of each independently writing `explicitMapping ? applyExplicitMapping(...) : detectColumns(...)`:

```ts
function resolveColumns(
  headers: string[],
  opts: { explicitMapping?: Record<string, string | null | undefined>; savedProfiles?: ImportMappingProfileLite[] }
): { columns: CsvColumnMap; matchedProfileId: string | null } | { error: string } {
  if (opts.explicitMapping) {
    const result = applyExplicitMapping(headers, opts.explicitMapping);
    return "error" in result ? result : { columns: result, matchedProfileId: null };
  }

  const detected = detectColumns(headers);
  if (!("error" in detected)) return { columns: detected, matchedProfileId: null };

  for (const profile of opts.savedProfiles ?? []) {
    const applied = applyExplicitMapping(headers, profile.mapping as Record<string, string | null>);
    if (!("error" in applied)) return { columns: applied, matchedProfileId: profile.id };
  }

  return detected; // surfaces detectColumns()'s own error — most actionable when no profile matched either
}
```

`ImportMappingProfileLite` is just `{ id: string; mapping: unknown }` — `resolveColumns()` doesn't need a profile's `name`/`source`/`useCount`/etc., keeping it a narrow, easily-testable pure function exactly like its two inputs already are. **Priority confirmed as you proposed: explicit mapping → `detectColumns()` → saved profiles**, deferring to the order already settled in Part B/the sequencing proposal rather than relitigating it — but one edge case worth flagging, not as a blocker: if a file's headers happen to satisfy `detectColumns()`'s generic aliases *and* a saved profile exists that would have picked a different (deliberately more correct, for that source) column, `detectColumns()` wins silently, since a successful auto-detect short-circuits before any profile is even consulted. This is narrow in practice (it requires the generic guess to also fully validate) and recoverable (an explicit mapping at upload time already overrides either), but it's the kind of thing 4D-5c's preview screen should surface ("matched via saved profile" vs. "auto-detected") so a wrong-but-passing auto-detect doesn't go unnoticed twice. Not a reason to change the order now — no concrete blocker has shown up, just a documented tradeoff.

Multiple matching saved profiles: tie-break deterministically by `lastUsedAt desc nulls last, createdAt desc` (most-recently-used profile wins) — the caller (`route.ts`) fetches `savedProfiles` already sorted this way, so `resolveColumns()` itself just takes the first match in array order. A "prefer the profile referencing the most headers" tie-break was considered and deferred — no evidence yet that recency isn't good enough, and adding it speculatively repeats exactly the pattern this project has consistently avoided elsewhere (D9/D10/D12).

`excel.ts`'s `parseExcelFile()` gains a `savedProfiles?` parameter alongside its existing `explicitMapping?` one (parity with 4D-5a's own precedent of threading a new optional param through both formats identically) and delegates to `resolveColumns()` instead of its current internal ternary; its return type gains `matchedProfileId` alongside `rows` so `route.ts` can stamp it.

## 6. Should `detectColumns()` stay untouched as the fixed-alias fast path?

Yes — confirmed, with the one caveat from §5: `HEADER_ALIASES` and the alias-resolution algorithm are unchanged; only the required-field check is proposed to move into the shared validator (pending your answer to §5's explicit yes/no). It remains the first thing tried after an explicit mapping and the only thing tried when no saved profiles exist for the Space — true of every Space on day one, since nothing in 4D-5b creates a profile-creation path (§7/§8).

## 7. Should explicit mapping optionally save a profile in 4D-5b?

**No — defer all profile *creation* to 4D-5c.** 4D-5b should ship schema + matching + auto-use of profiles that already exist, and nothing in 4D-5b creates a way for one to exist. Reasons:

- "Should every ad hoc explicit mapping silently become a saved profile?" is a real UX decision (most one-off mappings aren't meant to be reused) that needs an opt-in affordance — which needs a UI, which is 4D-5c.
- Dedup ("does this exact mapping already match an existing profile?") and naming ("what do we call it?") are both open design questions with no forcing function to answer them correctly without a UI in front of a person.
- Building a save path with zero callers (no opt-in flag exists yet to trigger it) is the same "persist ahead of a concrete consumer" pattern this project has consistently avoided — most directly, it's the same reasoning that kept `detectColumns()`'s alias list fixed and fuzzy-matching deferred.

Net effect: in 4D-5b, the only way an `ImportMappingProfile` row comes into existence is a direct `db.importMappingProfile.create()` call from a throwaway validation script (mirroring how 4D-5a/4D-3 validated against hand-built fixtures, not live routes) — there is no product surface that creates one yet. The auto-use/matching machinery is real and load-bearing; the supply of profiles to match against is, for this slice, manually seeded for testing only.

## 8. Should 4D-5b include profile CRUD routes?

**No.** Smallest safe slice = schema + `resolveColumns()`/`validateResolvedColumns()` + route wiring for auto-use only. No `app/api/.../mapping-profiles` routes of any kind (list/create/rename/delete) — there's no UI yet to call them, and per §7, nothing in this slice needs to create a profile through the API. CRUD routes land in 4D-5c, alongside whatever UI actually calls them.

## 9. Authorization and scoping

- **Space-scoped, confirmed.** Every `ImportMappingProfile` read filtered by `spaceId = getSpaceContext().spaceId` — the same Space the import route already resolves `financialAccountId` against via `SpaceAccountLink`. No cross-Space profile is ever visible to a request.
- **Active-Space visibility:** any active member of the Space sees (has profiles auto-used against) every profile in that Space — same blanket-visibility model `SpaceAccountLink`-linked accounts already use. Profiles hold header-name strings only, no credentials or financial values, so there's no sub-Space visibility tier to design.
- **Create/use/manage (specified now for 4D-5c's benefit, not implemented here):** auto-*use* requires no special permission beyond normal Space membership (mirrors read access to the account being imported into). Creating/renaming/deleting a profile, when 4D-5c builds it, should gate on `SpacePermissions.canWrite` (`OWNER`/`ADMIN`/`MEMBER`, per `lib/space.ts`) — the same tier that already gates other Space-scoped writes. Not enforced in 4D-5b since no creation path exists to gate.
- `createdByUserId` is display-only, exactly like `ImportBatch.createdByUserId` — Space membership is the actual authorization boundary, not row ownership.

## 10. Validation plan

No live Postgres in this sandbox — same constraint as every prior 4D slice. Split accordingly:

**Pure-function level (`tsx`, no DB), reusing the weird-header fixture plus a second "added column" variant:**

1. Saved profile still matches when a bank adds an unrelated new column — build a profile from the original 3-column-of-interest fixture, then trial-apply it against the same headers plus one extra unrelated column (e.g. `,Running Balance` appended). Must still resolve successfully. This is the direct test of the centerpiece fix.
2. Saved profile fails when a mapped *required* column is renamed or removed — same profile, headers with `Posting Date` renamed to `Txn Date`. Must return `{error}`, falling through to (in the live route) "no profile matched, no auto-detect match either" → the original `detectColumns()` error.
3. Explicit mapping still works, byte-identical to the 4D-5a validation report's recorded results (regression).
4. No mapping, no matching profile → still resolves via `detectColumns()` exactly as today (regression — confirms `resolveColumns()`'s fallthrough doesn't change the zero-profile case, the common case for every Space on day one).
5. `detectColumns()`/`applyExplicitMapping()` error strings are byte-identical post-`validateResolvedColumns()`-extraction (regression gate on §5's refactor, re-running the full error-string table from the 4D-5a/4D-3 fixture work verbatim).
6. Two saved profiles both match the same uploaded headers — confirm the `lastUsedAt`/`createdAt` tie-break is deterministic and reproducible across repeated runs, not order-of-array-insertion-dependent.

**Code-read + (if DB reachable) live insert/read-back:**

7. `ImportBatch.resolvedColumnMapping` is populated for all three resolver paths (auto-detect, ad hoc explicit, saved-profile) — not just the saved-profile path.
8. `ImportBatch.mappingProfileId` is set only on the saved-profile path; `null` for the other two.
9. `ImportMappingProfile.useCount`/`lastUsedAt` are bumped only when a profile is actually matched and used by a successful import — not on a failed import, not when a different path (explicit/auto-detect) was used instead. Bump implemented via Prisma's atomic `{ useCount: { increment: 1 } }`, not read-then-write, so concurrent imports against the same profile can't lose an update.
10. Rollback unaffected — same structural confirmation as 4D-5a/4D-3: `app/api/imports/[id]/rollback/route.ts`'s soft-delete is scoped by `importBatchId` + `deletedAt: null` only, with zero reference to `resolvedColumnMapping`, `mappingProfileId`, or any resolver function.

## Files expected to change

- **`prisma/schema.prisma`** — new `ImportMappingProfile` model (§1); `ImportBatch.resolvedColumnMapping` + `mappingProfileId` + relation (§2); back-relations on `Space` and `User`.
- **New migration** (`npx prisma migrate dev`) — additive only: one new table, two new nullable/optional columns + index on `ImportBatch`.
- **`lib/imports/csv.ts`** — add `validateResolvedColumns()`; refactor `detectColumns()`/`applyExplicitMapping()` to call it (pending §5's explicit approval; zero intended change to either function's returned error strings); add `resolveColumns()`.
- **`lib/imports/excel.ts`** — `parseExcelFile()` gains `savedProfiles?` param, delegates to `resolveColumns()` in place of its current internal ternary; return type gains `matchedProfileId`.
- **`app/api/accounts/[id]/import/route.ts`** — fetch the active Space's saved profiles (one indexed query, sorted per §5's tie-break) before parsing; call `resolveColumns()` (CSV branch) / pass `savedProfiles` through to `parseExcelFile()` (Excel branch) instead of the current ternary; stamp `resolvedColumnMapping`/`mappingProfileId` on `ImportBatch.create()`; bump the matched profile's `useCount`/`lastUsedAt` after a successful import.
- **New doc** — `D2_STEP4D5B_VALIDATION.md`, written after implementation, same paper trail as every prior 4D sub-step.

**Not touched:** any UI; `app/api/imports/[id]/rollback/route.ts`; `lib/transactions/fingerprint.ts`; `HEADER_ALIASES`; `normalizeRow()`/`normalizeExcelRow()`'s bodies; any CRUD route for `ImportMappingProfile` (§8); QuickBooks; provider-adapter work; `lib/audit-actions.ts`.

## Risks and rollback plan

**Risk: low, additive.**

- Schema change is additive-only (`Json?`, two nullable/optional FKs, one new table) — no existing column type changes, no existing row touched by this migration.
- The zero-profile case (every Space on day one) is provably unchanged: `resolveColumns()`'s saved-profile loop only runs if `savedProfiles` is non-empty, and nothing in 4D-5b populates that table outside a manual test seed (§7) — so the new path is inert for every real Space until 4D-5c ships a way to create a profile.
- The one real refactor risk is §5's `validateResolvedColumns()` extraction — a subtle bug there could silently change `detectColumns()`'s or `applyExplicitMapping()`'s observable error text. Mitigated by validation step 5 (byte-identical regression against the full existing fixture table) as a hard gate before merge.
- Resolver-priority edge case (§5, auto-detect winning over a more-specific saved profile) — accepted and documented, not blocking; mitigation deferred to 4D-5c's preview surfacing which path resolved a given import.
- `useCount` increment race under concurrent imports against the same profile — non-issue if implemented via Prisma's atomic increment expression (`SET "useCount" = "useCount" + 1` at the DB level) rather than read-then-write.

**Rollback plan:**

- Schema: additive migration, revertible via a down-migration dropping the new table/columns with zero impact on existing `ImportBatch`/`Transaction` data — nothing pre-4D-5b reads any of the new columns.
- Code: `resolveColumns()` is a new function alongside the still-present `detectColumns()`/`applyExplicitMapping()` — reverting `route.ts`/`excel.ts` to their pre-4D-5b direct ternary is a single-file diff each, no data migration required either direction.
- No flag needed to gate the rollout: since nothing creates a profile in 4D-5b (§7), the feature has zero observable effect for any Space until profiles exist by some other means — the safest possible rollout posture, independent of whether an explicit revert ever happens.

---

## Impact map

| Area | Affected? | Detail |
|---|---|---|
| `prisma/schema.prisma` / migration | Yes | New `ImportMappingProfile` model; `ImportBatch.resolvedColumnMapping`/`mappingProfileId` (§1/§2) |
| `HEADER_ALIASES` / `detectColumns()`'s alias logic | No | Untouched (§6) |
| `detectColumns()`'s required-field check | Maybe | Extracted into shared validator if §5 Option A is approved; zero error-string change either way |
| `applyExplicitMapping()` | Yes | Required-field check extracted into shared validator (§5) |
| `normalizeRow()` / `normalizeExcelRow()` | No | Downstream of column resolution; unaffected |
| `resolveFingerprintOutcome()` / `lib/transactions/fingerprint.ts` | No | Unaffected |
| Rollback route | No | Scoped by `importBatchId`/`deletedAt` only (§10.10) |
| `lib/imports/csv.ts` | Yes | New `validateResolvedColumns()`, `resolveColumns()` |
| `lib/imports/excel.ts` | Yes | `parseExcelFile()` gains `savedProfiles?`, delegates to `resolveColumns()` |
| `app/api/accounts/[id]/import/route.ts` | Yes | Fetch profiles, call `resolveColumns()`, stamp new `ImportBatch` fields, bump usage counters |
| CRUD routes for `ImportMappingProfile` | No | Deferred to 4D-5c (§8) |
| UI | No | Out of scope (§7/§8) |
| QuickBooks / provider adapters | No | Out of scope |

## Implementation checklist (for approval — not yet executed)

1. Add `ImportMappingProfile` model to `prisma/schema.prisma` (§1); add `ImportBatch.resolvedColumnMapping`/`mappingProfileId` + relation (§2); add back-relations on `Space`/`User`.
2. Run `npx prisma generate`; run `npx prisma migrate dev` (additive migration).
3. Add `validateResolvedColumns()` to `lib/imports/csv.ts`; refactor `detectColumns()` and `applyExplicitMapping()` to call it, preserving every existing error string exactly (§5 — pending your confirmation on touching `detectColumns()`'s body for this).
4. Add `resolveColumns()` to `lib/imports/csv.ts` (§5).
5. Update `parseExcelFile()` in `lib/imports/excel.ts` to accept `savedProfiles?` and delegate to `resolveColumns()`.
6. Update `app/api/accounts/[id]/import/route.ts`: fetch the Space's saved profiles (sorted per §5's tie-break), call `resolveColumns()`/pass `savedProfiles` through, stamp `resolvedColumnMapping`/`mappingProfileId` on `ImportBatch.create()`, bump the matched profile's `useCount`/`lastUsedAt` (atomic increment) after a successful import.
7. Run `npx tsc --noEmit` and `npm run lint`.
8. Run the validation plan in §10 (fixture regression + added-column/renamed-column matching tests + tie-break determinism + DB-level snapshot/usage-counter checks where reachable).
9. Write `D2_STEP4D5B_VALIDATION.md`.
10. Confirm scope via `git diff --stat` (expect exactly the files in "Files expected to change," plus the new doc and migration).

## Out of scope (4D-5b)

Any UI. Any CRUD route for `ImportMappingProfile` (§8). Saving a profile from an ad hoc explicit mapping (§7) — only manual test-seeded profiles exist in this slice. Fuzzy/string-similarity suggestion. Import preview. `headerSignature` hashing of any kind (§4 — deliberately not built, not even as an optional fast path, since profile counts per Space don't yet justify it). `transactionType`/`balanceAfter`/`currency`/`rawMetadata` mapping support. QuickBooks parsing. Step 5 provider/sync adapter work. Any widening of `HEADER_ALIASES`. Any change to `normalizeRow()`/`normalizeExcelRow()` beyond what's already true today (they keep consuming a `CsvColumnMap` regardless of which path produced it).

---

**Stopping here per your instruction — no code, schema, or migration changes made. Awaiting approval before implementing this checklist. Two explicit decisions need your sign-off before I start: (1) §5's choice to extract `detectColumns()`'s required-field check into the shared validator (Option A) vs. leaving it duplicated a third time (Option B); (2) whether to keep `lastUsedAt`/`useCount` on the schema or cut them until 4D-5c needs them.**
