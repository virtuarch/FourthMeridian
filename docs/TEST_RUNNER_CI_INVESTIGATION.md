# Test Runner + CI Foundation — Investigation

**Status:** Investigation only. No implementation. Stops after the checklist.
**Repo state at investigation:** branch `feature/v2.5-spaces-completion`, `v2.4.5-102-g2db97ef`, `package.json` version `2.4.5`.
**Node/tooling:** Node 22.22, tsx 4.23, Prisma client 5.22, Next 16, TypeScript 5.

> Note: the project config references a `feature/phase-2-architecture` branch at `v2.3.0`. The working tree is actually on `feature/v2.5-spaces-completion` at `v2.4.5`. Flagging in case the wrong branch is checked out.

---

## 1. Current test inventory

There is **no test runner** (no jest, no vitest). Every test is a **standalone tsx script** following one house pattern: import the unit under test (or `readFileSync` its source for a source-scan), run inline assertions, print a summary, and `process.exit(0)` on pass / `process.exit(1)` on first failure. This pattern is already CI-shaped — each file is its own pass/fail process.

**22 `*.test.ts` files.** None instantiate `PrismaClient`; none open a DB connection; none read external env (the one env user, `plaid/encryption`, sets its own key inline).

| # | Test file | Runtime deps beyond stdlib | CI today? |
|---|-----------|----------------------------|-----------|
| 1 | `app/api/ai/chat/attribution-guardrail.kd18.test.ts` | source-scan (fs) | ✅ |
| 2 | `lib/perspective-engine/liquidity.test.ts` | sibling lens modules | ✅ |
| 3 | `lib/perspective-engine/engine.test.ts` | sibling `./index` | ✅ |
| 4 | `lib/perspective-engine/route.test.ts` | source-scan (fs) | ✅ |
| 5 | `lib/perspective-engine/debt.test.ts` | sibling lens modules | ✅ |
| 6 | `lib/spaces/policy.test.ts` | `@prisma/client` **type-only** (erased) | ✅ |
| 7 | `lib/spaces/authorize.test.ts` | source-scan + `./policy`; prisma type-only | ✅ |
| 8 | `lib/space-nav.test.ts` | `./space-nav` (clean) | ✅ |
| 9 | `lib/transactions/plaid-flow-write.test.ts` | sibling tx modules | ✅ |
| 10 | `lib/transactions/plaid-flow-input.test.ts` | sibling tx modules | ✅ |
| 11 | `lib/transactions/merchant.test.ts` | `./merchant` | ✅ |
| 12 | `lib/transactions/flow-row-input.test.ts` | sibling tx modules | ✅ |
| 13 | `lib/transactions/flow-classifier.test.ts` | none | ✅ |
| 14 | `lib/ai/output-validator.test.ts` | `./output-validator` → **`server-only`** | ⚠️ needs shim |
| 15 | `lib/ai/assemblers/transactions.privacy.test.ts` | `VisibilityLevel` **enum value** → needs generated client | ✅ after `prisma generate` |
| 16 | `lib/ai/assemblers/transactions.kd17.test.ts` | `TransactionCategory` **enum value** → needs generated client | ✅ after `prisma generate` |
| 17 | `lib/ai/intent/classifier.test.ts` | sibling intent modules | ✅ |
| 18 | `lib/ai/intent/gap-intent.characterization.test.ts` | `@/lib/ai/provider` → **`server-only`** + openai | ⚠️ needs shim |
| 19 | `lib/perspectives.test.ts` | `./perspectives` | ✅ |
| 20 | `lib/plaid/encryption.test.ts` | crypto; sets own `ENCRYPTION_KEY` | ✅ |
| 21 | `lib/atlas/palette-ratchet.test.ts` | source-scan (node:fs) | ✅ |
| 22 | `lib/data/transactions.privacy.test.ts` | `VisibilityLevel` **enum value** → needs generated client | ✅ after `prisma generate` |

### Classification summary

- **DB-required tests: 0.** Nothing in the 22 connects to Postgres. No DB service is needed in CI today.
- **Pure / no special handling: 15.**
- **Need generated Prisma client (3):** #15, #16, #22 import enum *values* (`VisibilityLevel`, `TransactionCategory`) — runtime objects, so `prisma generate` must have run. `@/lib/ai/visibility` (their sibling) is clean of `server-only`.
- **Prisma type-only (2):** #6, #7 use `import type … from "@prisma/client"` — erased by tsx, no runtime requirement.
- **Need `server-only` shim (2):** #14 and #18 transitively import a module with `import 'server-only'` (`lib/ai/output-validator.ts`, `lib/ai/provider.ts`). Under plain tsx these fail with *Cannot find module 'server-only'* — Next aliases that package internally at build time; it is not a real installed dep.

### Already-solved blocker

A noop shim already exists: `scripts/lib/server-only-noop.cjs` (exports `{}`), installed via a `Module._resolveFilename` patch in `scripts/test-visibility-two-user-space.ts`. The runner should reuse that same shim as a **preload** so #14 and #18 pass. No new mechanism needs inventing.

### Excluded from the runner (not unit tests)

These match `test-*` but are **not** `*.test.ts`, so a `*.test.ts` glob already excludes them. Keep them out — they need a live DB / Plaid and are dev tools, not assertions:

- `scripts/test-visibility-two-user-space.ts` + `.impl.ts` — instantiates `PrismaClient`, `.create()`s users/spaces/transactions. Real DB. (End-to-end privacy check; run manually/locally.)
- `scripts/reset-chase-history-test.ts` — hits Plaid `/item/remove` + DB mutation. Dev/admin tool, not a test.

---

## 2. Recommended npm scripts

Smallest set that gives one-command local runs and a CI entry point:

```jsonc
"test":        "tsx scripts/run-tests.ts",   // glob + run all *.test.ts, one child process each
"test:ci":     "tsx scripts/run-tests.ts",   // same; kept separate so CI flags can diverge later
"pretest":     "prisma generate"             // guarantees the 3 enum-value tests have a client
```

Design of `scripts/run-tests.ts` (to be built in the implementation phase, not now):

1. Preload the existing `server-only` resolver shim (reuse `scripts/lib/server-only-noop.cjs`).
2. Glob `**/*.test.ts` under `app/` and `lib/` (naturally excludes `scripts/test-*`).
3. Spawn each file as its own `tsx` child process — required because each test calls `process.exit`, and it isolates the `encryption` test's `process.env` mutation.
4. Aggregate; exit `1` if any child exited non-zero, print a per-file pass/fail table.

Single-file runs need no script — `npx tsx <path>` already works (that is the current dev loop). A future `test:db` script is where DB-backed tests would go; empty today.

Rationale for a script over a shell one-liner: the two `server-only` tests need a preload, and per-file process isolation is cleaner in a script than in a `find | while` loop. The script is ~40 lines and adds no new dependency (tsx is already a devDependency).

---

## 3. CI strategy (GitHub Actions)

No `.github/workflows/` exists yet. Recommended first workflow — **no database service required**, because 0 tests need one:

```
runs-on: ubuntu-latest
steps:
  - checkout
  - setup-node 22, cache npm
  - npm ci
  - npx prisma generate        # for the 3 enum-value tests
  - npm test                   # scripts/run-tests.ts (shim preloaded inside)
  - npx tsc --noEmit           # typecheck gate
  - npm run lint               # eslint gate
```

Notes:

- **No Postgres service, no secrets** needed for the test job today. The `encryption` test supplies its own key; `provider.ts`'s `OPENAI_API_KEY` is read lazily at call time, not at import, so `gap-intent` loads without it.
- Order matters: `prisma generate` **before** `npm test`. It is already inside `build`, but the test job should run it explicitly rather than depend on `build`.
- Keep `tsc --noEmit` and `lint` as sibling steps so a test pass isn't blocked by lint noise and vice-versa (parallelizable later).
- The two DB/Plaid `scripts/test-*` files must **not** be added to CI. Leave a comment in the workflow saying so, to prevent drift.

---

## 4. Smallest implementation checklist (D-TEST-1)

Additive only. Nothing removed, no test files touched, no schema.

- [ ] **Impact map:** adds `scripts/run-tests.ts`, 3 `package.json` script keys, and `.github/workflows/ci.yml`. Touches no test file, no `lib/` source, no schema, no UI.
- [ ] Write `scripts/run-tests.ts` (glob → per-file `tsx` child → aggregate exit code), reusing `scripts/lib/server-only-noop.cjs` as preload.
- [ ] Add `test`, `test:ci`, `pretest` (`prisma generate`) to `package.json` scripts.
- [ ] Confirm the glob excludes `scripts/test-*.ts` and `*.impl.ts`.
- [ ] Add `.github/workflows/ci.yml` per section 3 (no DB service).
- [ ] **Rollback plan:** see section 6.
- [ ] **Validation checklist:** see section 5.
- [ ] Stop. Do not add a DB test job, jest/vitest migration, or coverage tooling in this step.

Out of scope for the first step (explicitly deferred): migrating the house pattern to jest/vitest, coverage reports, a `test:db` job, matrix builds, caching Prisma engines.

---

## 5. Validation plan

Run locally before opening the PR, then confirm green in Actions:

1. `npx prisma generate` — client present for enum-value tests.
2. `npm test` — expect all 22 to pass; specifically verify #14 and #18 pass (shim works) and #15/#16/#22 pass (client present).
3. Negative check: temporarily break one assertion, confirm `npm test` exits non-zero and names the failing file; revert.
4. Confirm `scripts/test-visibility-*` and `reset-chase-history-test` are **not** picked up by the runner.
5. `npx tsc --noEmit` — clean.
6. `npm run lint` — clean (lint the new script too).
7. Push branch; confirm the Actions workflow reproduces steps 1–2, 5, 6 green on `ubuntu-latest` with no DB service.

> Sandbox caveat: these tests could not be executed during this investigation because the mounted `node_modules` contains macOS (`darwin-arm64`) esbuild binaries while the analysis sandbox is Linux. This is an environment artifact only — it does not affect the developer machine or GitHub Actions, where `npm ci` installs the correct platform binary. Validation must be run on the real machine / in CI.

---

## 6. Rollback plan

Fully additive, so rollback is deletion — no data or schema risk:

- Revert the single commit, **or** delete `scripts/run-tests.ts`, remove the 3 `package.json` script keys, and delete `.github/workflows/ci.yml`.
- No migration to reverse, no test file was modified, no `lib/` source changed, `scripts/lib/server-only-noop.cjs` was reused not altered.
- If only CI is problematic but local runs are fine: delete `.github/workflows/ci.yml` alone and keep `npm test`.
- Blast radius: zero runtime/app impact — none of this ships in the Next build output.
