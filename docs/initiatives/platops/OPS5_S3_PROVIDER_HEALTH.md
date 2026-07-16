# OPS-5 S3 — Provider Health

**Status:** IMPLEMENTED · validated · committed (own files, explicit pathspec) · **not pushed**
**Date:** 2026-07-16 · branch `feature/v2.5-spaces-completion`
**Slice goal:** make Platform Operations understand external **providers** as first-class operational resources — *provider* health, NOT *job* health.

---

## 0. What shipped

A canonical **ProviderHealth** read-model that treats every external provider (Plaid, Open Exchange Rates today; price vendors, wallet/exchange providers, CSV importers tomorrow) as a first-class operational resource, and an **expandable Provider Health widget** on the Platform Operations Space.

| Artifact | Path |
|---|---|
| Read-model (registry + pure derive + injectable driver) | `lib/platform/provider-health.ts` |
| Unit tests (51 assertions, pure, no DB) | `lib/platform/provider-health.test.ts` |
| Read route (thin, `requirePlatformAccess READ`) | `app/api/platform/platform-ops/provider-health/route.ts` |
| Expandable provider-card widget | `components/platform/widgets/OpsProviderHealthWidget.tsx` |
| Section registration (order 7) | `lib/platform/policy.ts` |
| Widget registration + note | `components/platform/PlatformSpaceDashboard.tsx` |

Every field the brief enumerates is present: **availability, last success, last failure, quota, remaining quota, latency, coverage, freshness, sync failures, error rate, trust**.

---

## 1. Architecture — a synthesis over authorities, inventing nothing

Provider health creates **no new table, performs no write, makes no new external call, and invents no new freshness model.** It is a read-time synthesis; each field is sourced from the module that already owns that truth:

| Field | Authority consumed |
|---|---|
| availability · last success/failure · latency · error rate · sync failures | **JobRun ledger** (OPS-4) — windowed read (7d), `summarizeJobRuns()` |
| calls today / 30d | **ApiUsageCounter** (Wave 2 S7) |
| **freshness** | **CONSUMED, never recomputed** — archive providers (OXR → `fx-rates`) take the canonical `ResourceFreshnessReport` straight from **OPS-5 S1** (`lib/platform/resource-freshness.ts`); sync providers (Plaid) take recency from **`lib/connections/health.ts`** (the same derived STALE state its own widget shows) |
| coverage | S1's completeness frontier (currency pairs priced) |
| quota / remaining quota | honestly `null` today (see §3) |
| **trust** | the module's *only* judgement — a pure roll-up |

> **Brief directive "Provider health must consume Resource Freshness. Do NOT invent another freshness model."** — honored structurally. `provider-health.ts` imports freshness; it never derives staleness. A source-scan test locks this: the module must import `checkResourceFreshness` from S1 and `getConnectionHealth`, and must **not** reach into `fxRate` / `priceObservation` / `MAX(date)` to recompute freshness.

### Trust roll-up (the one judgement)
Content **or** execution, whichever is worse (the PLATOPS doctrine):

```
FAILING   execution broken (failure streak ≥3 / error-rate ≥50%) OR a hard
          connection fault (revoked / error / needs-reauth).
STALE     the DATA is behind or absent (freshness stale|empty) — the
          FALSE-GREEN catch: a green job over a stale/empty archive still
          reads STALE, because job success is not provider health.
UNKNOWN   no signal at all (no runs AND freshness un-assertable).
DEGRADED  some failures, a degraded connection, or un-assertable freshness
          despite an execution signal.
OPERATIONAL  fresh/idle data + clean execution.
```

### One reusable synthesis, N providers
The rule lives once (`buildProviderHealth` + `deriveProviderTrust`); each provider is a thin `ProviderSpec` (its producing job, its usage key, and **which freshness authority feeds it**). Adding a provider = adding one spec — the exact `SCHEDULED_JOBS`/`RESOURCE_FRESHNESS` registry idiom.

---

## 2. Initial providers

| Provider | Kind | Job | Usage | Freshness authority | Coverage |
|---|---|---|---|---|---|
| **Plaid** | BANKING | `sync-banks` | `ApiUsageCounter[PLAID]` | connection-health (STALE recency) | — (see §3) |
| **Open Exchange Rates** | FX | `fetch-fx-rates` | — (FX not in ApiUsageCounter yet) | **S1 `fx-rates`** report | currency pairs priced (S1 frontier) |

---

## 3. Honest gaps (fields present, structurally ready, `null` today)

Per the honest-signal house idiom (`estimatedSpendUsd: null`), a field with no truthful source returns `null` **with a caveat**, never a fabricated number:

- **quota / remaining quota** — neither provider exposes a quota figure this app persists. The fields exist; OXR's separate `GET /api/usage.json` (`requests_quota`/`requests_remaining`/`days_remaining`) is the documented, **uncalled** path to populate them (PLATOPS investigation §6). Lighting it up = one gated daily read + persistence, then this model reads it — no shape change. Plaid exposes no pollable quota/billing API at all.
- **latency** — approximated by the most recent whole-job `JobRun.durationMs`; true per-provider/per-call latency needs a telemetry emission that does not exist yet.
- **Plaid coverage** — `getConnectionHealth()` returns global counts + a capped *unhealthy* list, not a per-source total or newest healthy sync time, so Plaid coverage is `null` and its fresh `asOf` is `null` when all connections are healthy. A future additive per-source rollup on the connection authority would fill these without any new staleness math here.

---

## 4. Validation

- **Full unit suite: 272/272 green** (`npm run test:unit`) — includes this slice's new `provider-health.test.ts` and the concurrently-landed S1/S2/S4 slices.
- **`tsc --noEmit`: 0 errors** project-wide (0 in any S3-owned file).
- **eslint: clean** on all four S3 files.
- **`provider-health.test.ts`: 51/51** — run-window summary, trust precedence (incl. the false-green catch and FAILING-beats-STALE), freshness consumption from both authorities, OXR + Plaid assembly, the driver over injected authorities, and source-scan fences (read-only · consumes-not-recomputes freshness · no live calls).

---

## 5. Concurrency finding (recorded per the working-tree discipline)

OPS-5 landed as **several concurrent slices in this shared working tree during this session.** Observed live: S1 Resource Freshness committed `b209978`, then S2 (rich job health) + S4 (manual operations) committed `a815219`, then an S5 alerting slice (`lib/alerts/`) began — all while this S3 work was in progress. Handling:

- **Consumed, did not recreate.** S1's `checkResourceFreshness` is this slice's freshness authority. An early attempt to author a parallel freshness module was abandoned the moment S1 was discovered — provider-health imports it.
- **No shared-file clobber.** S3's new code lives at unique paths. The two shared-file registrations (`policy.ts` +1 line, `PlatformSpaceDashboard.tsx` +3 lines) were applied **additively over the committed `a815219` baseline** and verified via `git diff` to contain only S3 lines immediately before commit. The commit uses an **explicit pathspec** (never `git add -A`) so no other slice's uncommitted work (the in-flight `lib/alerts/`) is swept in — the repo's standing concurrent-branch discipline.

---

## 6. Future extensibility (registry-ready, out of this slice)

- **More providers** — a price vendor (`fetch-security-prices` → S1 `security-prices`), a wallet/exchange provider (`sync-crypto` → connection-health WALLET), or a CSV importer is one more `ProviderSpec`.
- **Real quota** — OXR `/api/usage.json` daily read → persist → this model reads it; extend `ApiUsageCounter` emission to FX/price/crypto providers so volume is uniform.
- **Per-provider latency** — a telemetry emission at the provider seam replaces the whole-job `durationMs` approximation.
- **Provider Health Perspective** — quota/error/latency curves over time, once a rollup/history substrate exists (doctrine Addendum II; PLATOPS §8).
