# OPS-5 S1 — Resource Freshness

**Status:** IMPLEMENTED · validated green (tsc · eslint · unit 268/268 incl. oracle) · committed, not pushed
**Date:** 2026-07-16 · branch `feature/v2.5-spaces-completion`
**Trigger:** the FX incident — after a local DB rebuild the `FxRate` archive was empty, conversions silently defaulted, and Platform Operations gave **no** indication the sync had never produced data. A `succeeded` JobRun was treated as proof of a healthy resource. It is not.

---

## 0. The gap this closes

OPS-4 shipped the **execution** authority: the `JobRun` ledger + `lib/jobs/health.ts` (the dead-job detector). That answers *"did the job run and return?"*. It cannot answer *"is the underlying resource actually fresh?"* — and the two diverge:

- `fetch-fx-rates` returns `source:"none"` **without throwing** when every provider fails → a **`succeeded`** run over an archive that gained zero rows.
- `fetch-security-prices` returns `no-provider` (a successful no-op) **forever** while vendor-gated → **`succeeded`** while nothing is ever priced.

Job execution and resource freshness are **two authorities**. This slice adds the **second one**, deriving freshness from the *data* — never from `JobRun.status`.

---

## 1. The canonical model

One reusable authority — `lib/platform/resource-freshness.ts`. The freshness **semantics live once**, in the pure classifier `classifyResourceFreshness()`. Each refreshable resource contributes a thin **descriptor** to `RESOURCE_FRESHNESS` with a `probe()` that reads its *own* newest-observed-date + frontier completeness from the underlying data. Adding a resource = adding one descriptor. This mirrors the OPS-4 `SCHEDULED_JOBS` + `classifyJobHealth` split exactly.

Every field the brief enumerates is on `ResourceFreshnessReport`:

| Brief field | Report field | Source |
|---|---|---|
| resource | `resource` / `label` | descriptor |
| newest observed date | `newestObservedDate` | **`MAX(archive.date)`** (the content check) |
| freshness | `ageHours` / `ageDays` | now − newest |
| expected cadence | `expectedCadenceHours` / `cadenceLabel` | descriptor |
| stale threshold | `staleAfterHours` | descriptor (cadence + 24h grace) |
| health state | `healthState` | classifier (from the observation) |
| completeness | `completeness {expected, observed, ratio}` | probe frontier count |
| last successful refresh | `lastSuccessfulRefresh` | `JobRun` (execution — **surfaced, not derived**) |
| last attempted refresh | `lastAttemptedRefresh` / `lastAttemptStatus` | `JobRun` |
| trust | `trust {level, caveats}` | classifier |

### Health states (content-derived)

- **fresh** — newest observation within the stale threshold.
- **stale** — data exists but the newest observation is older than the threshold. *Catches the `source:"none"` succeeded FX run.*
- **empty** — the resource **should** have data (something is tracked) but the archive holds none. *The incident's cold-archive shape.*
- **idle** — nothing is tracked yet (no held instruments) — a legitimately empty archive, vacuously healthy.

### Trust

`high` (fresh + complete) → `medium` (fresh but partial frontier) → `low` (stale / empty-and-should-not-be) → `unknown` (empty **and** the pipeline is known-blocked, e.g. no price vendor — honest, not a false alarm). Caveats are ordered, human-readable reasons.

### The load-bearing invariant

The health state is a function of the **observation only**. The ledger contributes caveats — including the **false-green flag** ("a refresh reported success but the archive is stale/empty — job success is not resource freshness") — but never the state. A green `JobRun` over a stale or empty archive **still reads stale/empty**. This is pinned behaviorally in the tests (§4), and is the entire point of separating the authorities.

---

## 2. Investigation findings

| Question | Finding |
|---|---|
| **Current false-green cases** | (1) FX all-providers-empty → `source:"none"`, no throw → `succeeded` over an empty/stale archive. (2) Security prices vendor-gated → `no-provider` success forever. Both now surface as `stale`/`empty`/`idle` with a false-green caveat when a green run coexists with non-fresh data. |
| **Seed behavior** | `prisma/seed.ts` writes **zero** `FxRate` rows → every `db:reset` starts cold. The freshness surface now makes that cold archive **visible** as `empty`/low — which is the actual fix the incident wanted (an operator learns from Operations, not from the product). Seeding FX itself remains a separate, optional follow-up. |
| **Cold archive** | `newestObservedDate = null`, something tracked → `empty` (FX: always tracked → `low`; prices: gated → `unknown`). |
| **Empty archive** | Distinguished from cold-by-choice: `expectedUnits === 0` (nothing tracked) → `idle`, not `empty`. Held instruments with no prices → `empty`. |
| **Historical archive completeness** | Runtime metric is **frontier** completeness (units present on the newest date vs expected) — cheap and indexed. Deep window/gap completeness is deferred (needs a heavier scan; not required to catch the incident). |
| **Expected cadence** | Each descriptor names it (`Daily`, 24h) with a stale threshold of cadence + 24h grace, mirroring the dead-job detector's `expectedEveryHours` + `GRACE_HOURS`. |
| **Future resources** | The descriptor/probe registry is the extension seam. Snapshots, valuation archives, `PositionObservation`, provider caches, and historical series each become one descriptor — no freshness rule is duplicated. |

---

## 3. Surface (UI)

- **API:** `GET /api/platform/platform-ops/resource-freshness` — `requirePlatformAccess("PLATFORM_OPS","READ")`, thin over `checkResourceFreshness()`. Aggregate + non-monetary only (dates, counts, states) — no rates, no prices, no PII.
- **Widget:** `OpsResourceFreshnessWidget` (`ops_resource_freshness`) — one row per resource with the brief's columns: **Archive Fresh To · Age · Expected cadence · Status · Completeness · Trust** + the leading caveat.
- **Section:** `policy.ts` `PLATFORM_OPS` order 5; registered in `PlatformSpaceDashboard`. Materializes on live Spaces via the existing create-only `ensurePlatformSections` backfill (the `sec_anomalies` pattern) — **no migration**, no schema change.

---

## 4. Reuse / boundaries honored

- **Consumes, does not recreate:** reads the existing `FxRate` / `PriceObservation` / `PositionObservation` archives and the `JobRun` ledger read-only. Does **not** touch OPS-4 `lib/jobs/health.ts`, the dispatcher, or the SD-8 Space architecture.
- **Distinct from `lib/money/fx-freshness.ts`** — that is the SWR *trigger* gate (whether to kick a background refresh on a user conversion); this is the operator-facing *archive-freshness* authority. Different concern, no overlap.
- **Zero writes, zero new tables.** Freshness is computed read-time, exactly like the dead-job detector.

---

## 5. Validation

```
tsc --noEmit         → clean
eslint (changed)     → clean
npm run test:unit    → 268/268 (incl. financial-doctrine oracle)
lib/platform/resource-freshness.test.ts → 56/56 (pure classifier, driver, real-registry probes, false-green invariant, doctrine source-scans)
```

## 6. Deliberately deferred

- Alerting (push, not pull) — depends on the OPS-1 email seam.
- FX provider quota (OXR `/usage.json`) — one gated daily call; a Providers concern, not freshness.
- "Run Now" manual refresh — WRITE-grant action, separate slice.
- Deep historical/window completeness — frontier completeness ships now; gap-scan later.
- Seeding `FxRate` in `prisma/seed.ts` — the surface now makes cold visible; seeding is an optional convenience follow-up.
