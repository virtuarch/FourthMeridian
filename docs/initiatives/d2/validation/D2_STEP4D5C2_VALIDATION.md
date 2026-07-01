> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-5c-2 — Import Preview Endpoint (Implementation + Validation Report)

Implements `docs/initiatives/d2/D2_STEP4D5C2_IMPLEMENTATION_PLAN.md` (approved checklist) exactly. No scope beyond that checklist.

## 1. What changed

| File | Change |
|---|---|
| `lib/imports/authorize.ts` | New. `resolveImportableFinancialAccount(spaceId, id)` — the confirm route's inline account-resolution/auth check, extracted verbatim (same two `db` reads, same `NextResponse` bodies/status codes). |
| `app/api/accounts/[id]/import/route.ts` | Small edit. Inline auth block replaced with a call to the new helper; `ShareStatus` import dropped (no longer used directly here). `git diff --stat`: 1 file changed, 21 insertions(+), 24 deletions(-). |
| `app/api/accounts/[id]/import/preview/route.ts` | New. `POST /api/accounts/[id]/import/preview` — read-only preview, per the checklist's §3–§5. |

Nothing else touched. No `prisma/schema.prisma`, no migration, no UI.

## 2. tsc / lint

`npx tsc --noEmit` — clean (exit 0). `npm run lint` — 0 errors, the same pre-existing 4 `@next/next/no-img-element` warnings as every prior step's baseline.

## 3. No-write proof

Structural: `grep -n '\.create(\|\.update(\|\.upsert(\|\.delete(' "app/api/accounts/[id]/import/preview/route.ts"` → zero matches (exit 1). The route's module header mentions `importBatch.create`/`transaction.create`/`importMappingProfile.update` only in prose explaining what it *doesn't* call — confirmed those mentions are comment text, not invocations, by re-running the grep restricted to the call-syntax pattern above (the looser method-name grep used during implementation matched the comment lines; this stricter pattern, matching 4D-5c-1's convention, doesn't).

`lib/imports/authorize.ts` — same grep, zero matches.

Cross-check: the confirm route still contains its 4 expected write calls (`importBatch.create`, `transaction.create`, `importBatch.update`, `importMappingProfile.update`) — the auth-extraction edit didn't touch persistence.

## 4. End-to-end execution validation

The approved checklist's §7 anticipated this sandbox's missing Prisma engine might make a real execution test "more fragile than it's worth," and pre-authorized falling back to code-read-only validation for the DB-touching pieces if so. That fallback wasn't needed — full end-to-end execution against the real, unmodified route handlers turned out to be achievable, with one additional wrinkle beyond what the checklist anticipated.

**Mechanism:** a throwaway CJS `require.cache` preload (the same technique 4D-5c-1 used for `lib/db.ts`) pre-seeded three modules with controllable fakes:
- `lib/db.ts` — a fake `db` whose `spaceAccountLink`/`account`/`importMappingProfile`/`transaction` methods return scripted, per-scenario canned results (not just throw — this route reads, so the stub had to answer convincingly, not just prove absence).
- `lib/session.ts` / `lib/space.ts` — both depend on NextAuth's `getServerSession()` and (for space) `next/headers`'s `cookies()`, neither callable outside a live Next.js request context; stubbed to return a fixed test user/space.
- **New this slice:** `lib/api.ts` does `import "server-only"`. Next.js aliases that bare specifier to its own internal no-op (`next/dist/compiled/server-only/empty.js`) via webpack/Turbopack's `react-server` export condition — real apps never install it as a dependency. Outside Next's bundler, plain Node/tsx resolution can't find the package at all (correctly — it isn't installed, and shouldn't be), and even if it were resolvable, the package's *default* export condition (as opposed to the `react-server` one Next selects) unconditionally throws — it's a marker package, not a real no-op, outside Next's own build. Fixed by patching `Module._resolveFilename` to redirect the bare specifiers `server-only`/`client-only` to a synthetic path pre-seeded in `require.cache` with an empty exports object — same require.cache-interception idea as the other three stubs, just needing a resolution redirect first since there's no real on-disk package to anchor to.

With all four stubbed, the actual exported `POST` handlers from both `app/api/accounts/[id]/import/preview/route.ts` and `app/api/accounts/[id]/import/route.ts` were called directly with real `NextRequest`/`FormData`/`File` objects (real CSV/Excel fixture content, not mocked parsing) and real `Promise<{id}>` params — exercising the genuine route code, `runImportPipeline()`, `resolveFingerprintOutcome()`, and `findByFingerprint()` exactly as production would, with only the database/auth/session boundary faked.

**Results — 48/48 checks passed**, covering every scenario the checklist's §7 manual-testing list called for:

| # | Scenario | Result |
|---|---|---|
| 1 | Normal CSV preview | 200; `source: "CSV"`; 2/2 rows CREATE; correct `dateRange`; no `matchedTransactionId` field present |
| 2 | Excel (.xlsx) preview | 200; `source: "EXCEL"`; same shape as CSV |
| 3 | Explicit `columnMapping` preview | 200; `resolvedColumnMapping` reflects the caller's mapping; `matchedProfileId: null` |
| 4 | Saved-profile preview (no explicit mapping, odd headers) | 200; `matchedProfileId` set to the matching profile's id |
| 5 | Resolution failure (unrecognizable headers) | 400 with a plain `{ error }` body — no `summary`/`rows` keys, confirming the approved decision (not the investigation's richer `resolved:false` shape) |
| 6 | Unauthorized/nonexistent account — preview vs. confirm parity | Both the not-found case (no link, no legacy account → 404) and the legacy-only case (legacy account exists, no active link → 400) produced **byte-identical** status and body between the preview and confirm routes |
| 7 | >50-row file (60 rows: 55 unparseable + 5 valid) | `summary.totalRows: 60`, `willFail: 55`, `willCreate: 5` (uncapped, reflects every row); `rows` and `errors` each capped to exactly 50, in file order, first row of the cap being file row 1 |
| 8 | Full classification matrix via scripted db responses | CREATE (no candidate), within-file duplicate of that same row **also** CREATE (the documented, not-a-bug preview/confirm difference), SKIP (2 ambiguous fingerprint candidates), MATCH (single fingerprint candidate), MATCH (exact `externalTransactionId`) — all five outcomes produced by the real `resolveFingerprintOutcome()`/`findByFingerprint()` code, not simulated |
| 9 | No-write proof, mechanically | The fake `db.importBatch.create`/`transaction.create`/`importMappingProfile.update` methods were wired to **throw** if ever called; the script ran to completion without any of them firing — runtime-enforced, not just a code read |

Scenario 6 doubles as the live test of the `lib/imports/authorize.ts` extraction itself: both routes, calling the identical shared helper, produced identical responses for both failure shapes (404 not-found, 400 legacy-only) — exactly the "must not drift" property the checklist's §2 extraction rationale was protecting.

One real bug-catching value of the throwing stubs: had the preview route's loop accidentally called any persistence method, the script would have crashed with a clear error naming the exact stubbed call, rather than silently passing. It didn't.

## 5. Scope confirmation

```
$ git status --short
 M app/api/accounts/[id]/import/route.ts
?? app/api/accounts/[id]/import/preview/
?? docs/initiatives/d2/D2_STEP4D5C2_IMPLEMENTATION_PLAN.md
?? lib/imports/authorize.ts
?? scripts/tmp-4d5c2-stub-preload.cjs
?? scripts/tmp-4d5c2-validation.ts

$ git diff --stat
 app/api/accounts/[id]/import/route.ts | 45 ++++++++++++++++-------------------
 1 file changed, 21 insertions(+), 24 deletions(-)
```

Exactly the 3 files §8 of the implementation plan named, plus this report and the now-empty leftover scripts (next section). No schema/migration/UI changes.

## 6. Known leftovers

`scripts/tmp-4d5c2-stub-preload.cjs` and `scripts/tmp-4d5c2-validation.ts` were throwaway validation artifacts, not part of the deliverable. This sandbox's mounted filesystem doesn't permit unlinking newly created files (`rm`, `os.remove`, and `mv` all returned "Operation not permitted" — the same constraint already noted for `.git/index.lock` in the 4D-5c-1 validation report). Both files have been overwritten in place with a one-line "intentionally emptied" placeholder rather than deleted; safe to delete by hand from outside this sandbox. Untracked, so they have no effect on the actual D2 Step 4D-5c-2 diff.

## 7. Not done (out of scope for this slice, per the approved checklist)

No suggestions/fuzzy-mapping response shape (4D-5c-3). No `matchedTransactionId` field. No UI. No rollback-route interaction. No schema change.

---

Stopping here per instruction — implementation and validation only. Awaiting next direction before any further D2 decision.
