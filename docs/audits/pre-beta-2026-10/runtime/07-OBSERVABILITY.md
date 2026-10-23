> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# 07 — Observability (Phase 7)

## PHASE 7 — OBSERVABILITY

### 7.0 /api/health — content + SELECT 1

- Live: `GET /api/health` → `{"status":"ok","db":"ok","commit":null,"time":"…"}`.
- Code (`app/api/health/route.ts:36-47`): the DB check is literally ``db.$queryRaw`SELECT 1` ``; `commit = VERCEL_GIT_COMMIT_SHA?.slice(0,7) ?? null`; limiter `limitByIp(…,{limit:30,windowSec:60})`.
- **Classification: CONFIRMED.** `commit:null` because no Vercel env (environment difference). "ok" = DB reachable only; limiter runs on the same DB it protects and fails open (OBS-010, code-confirmed, not separately exercised).

### 7.1 OBS-002 — `dead` job never alerted — CONFIRMED (end-to-end runtime)

Code: `lib/alerts/evaluate.ts:94-104` `evaluateSchedulerSilent` filters **`status === "overdue"` only**; `lib/jobs/health.ts:353-357` promotes `overdue` → **`dead`** at `expectedEveryHours × DEAD_CADENCE_MULTIPLE (3)`. So the worse state drops out of the firing set.

Runtime experiment (throwaway DB; `sync-crypto-continuation` chosen because it is the one registered job with **zero** JobRun rows, so the fixture collides with no other workstream and is fully reversible):

1. Seeded one JobRun `sync-crypto-continuation`, `startedAt = now − 60 days`, `status=succeeded`.
   - `GET /platform-ops/job-health` → that job reads **`status:"dead"`, `expectedEveryHours:6`**. (Dead confirmed at the runtime read model.)
   - Ran `run-now:evaluate-alerts` (jane) → **`scheduler-silent`: `firing:false, breaches:0`**. The dead job was **not** alerted.
2. Backdated the same row to `startedAt = now − 10h` (overdue: 6h cadence + 2h grace = 8h < 10h < 18h dead).
   - `job-health` → **`status:"overdue"`**.
   - Re-ran evaluate-alerts → **`scheduler-silent`: `firing:true, breaches:1, severity:critical`**, `fired[]` contains `Job "sync-crypto-continuation" is overdue (expected every 6h) — its schedule has gone silent`.
3. Deleted the seeded row (verified 0 rows ⇒ back to `never-ran`); re-ran evaluate-alerts ⇒ `scheduler-silent: false` again (ledger restored to reality).

- **Expected:** a dead job (silent for many cycles) is the *stronger* escalate-now signal and should alert.
- **Actual:** the identical job, identical ledger, **fires the alert when `overdue` (10h) but goes silent when `dead` (60d)** — the exact inversion OBS-002 describes. **Classification: CONFIRMED. Reproducibility: deterministic.** Remediation: include `dead` (critical) in `evaluateSchedulerSilent` (one line).

### 7.2 OBS-003 — `captured` email counts as delivered, suppresses 20h — CONFIRMED (live)

Code: `lib/email/send.ts:33-39` selects the **capture** transport when no `RESEND_API_KEY`; `lib/email/providers/capture.ts:25` returns `status:"captured"`; `lib/alerts/run.ts:174,178` `normalizeStatus` keeps `"captured"` and **`if (deliveryStatus === "sent" || "captured") delivered = toSend`** ⇒ breaches recorded in `fired[]`; `lib/alerts/evaluate.ts:42` `DEFAULT_RENOTIFY_HOURS = 20` ⇒ a fired dedupeKey is suppressed 20h.

Runtime evidence — the baseline evaluate-alerts `JobRun.summary` (this env has `PLATFORM_ALERTS_EMAIL` set, no `RESEND_API_KEY`):
```
destination    : alerts@rtv.invalid
deliveryStatus : captured
counts         : { evaluated:8, live:7, enabled:7, firing:1, delivered:1, suppressed:0 }
fired[0]       : resource-stale:fx-rates "archive is empty" (critical), deliveredAtISO set
```
On my subsequent runs the same `fx-rates` critical showed up as **`suppressed`** (counts.suppressed rose to 1 then 2) — i.e. a breach that went *nowhere* (captured in memory) was treated as delivered and silenced for 20h.

- **Expected:** with no mail provider, a breach is not "delivered".
- **Actual:** `deliveryStatus:"captured"`, `counts.delivered:1`, breach in `fired[]`, then suppressed. **Classification: CONFIRMED. Reproducibility: deterministic** (observed across 4 evaluations). Remediation: treat `captured` as `skipped` outside `NODE_ENV=development`; surface `deliveryStatus` in the Alerts widget.

### 7.3 OBS-001 — alerts posture has no age check — CONFIRMED

Code: `lib/platform/ops/overview-core.ts:352-363` `deriveAlertsPosture(a)` decides solely on `a.latest.rules.filter(r => r.firing)`. The input type (`:334`) carries `latest.evaluatedAtISO`, but **the function never reads it** — there is no staleness branch; `firing.length === 0` ⇒ `word:"Quiet", tone:"ok"`.

Runtime proof (isolated tsx, `$S/rtv/spaces/obs001-posture.ts`, no DB mutation): fed a `latest` with `evaluatedAtISO = now − 30 days` and `firing:0` →
```
posture chip: { word:"Quiet", tone:"ok", state:"observed",
                count:"0 of 1 firing", basis:"latest evaluate-alerts run (per-rule outcomes)" }
```
A 30-day-dead evaluator still reads green.

Live corroboration: `GET /platform-ops/overview` alerts chip =
```
{ word:"Firing (critical)", tone:"bad", count:"3 of 7 firing", state:"observed",
  basis:"latest evaluate-alerts run (per-rule outcomes)" }
```
— driven purely by the *stored* latest evaluation's content (it even showed "3 firing" from a run whose `scheduler-silent` condition I had already deleted, until I re-evaluated). The chip object has **no age/staleness field** (`state` is only observed/unknown/unavailable; `basis` names the source, not its age). The top-level `overview.checkedAt` is the *composition* time, not the evaluation age.

- **Classification: CONFIRMED.** Remediation: age-gate the chip (`latest.evaluatedAtISO` older than cadence+grace ⇒ "Unknown — evaluator silent"); expose `lastEvaluatedAt` on `/api/health` for an external dead-man's switch.

---


## Per-observability-item scores (static vs runtime)
### Per-observability item (Phase 7)

| Item / Finding | Static score | Runtime result | Confidence | Uncertainty |
|---|---|---|---|---|
| OBS-001 (posture no age check) | P1 OPEN, item 26 = 4/10 | **CONFIRMED** (tsx + live chip; no age field) | high | — |
| OBS-002 (`dead` never alerted) | P1 OPEN, item 10 = 4/10 | **CONFIRMED end-to-end** (dead→silent, overdue→fires, same job) | high | — |
| OBS-003 (`captured` = delivered, 20h suppress) | P1 OPEN, item 26 | **CONFIRMED live** (deliveryStatus=captured, delivered=1, suppressed) | high | Preview/Prod RESEND key presence still UNVERIFIED |
| Item 1 — /api/health | 3/10 (B, external) | **CONFIRMED** SELECT 1, `{status,db,commit:null}`, limiter fails open | high | external monitor presence UNVERIFIED |
| OBS-010 (commit public, limiter fails open) | P3 OPEN | SUPPORTED from code; `commit:null` here (no Vercel) | high | prod commit-exposure UNVERIFIED |

Aggregate observability score **5.2 / 10 holds** — the three P1 one-/few-line findings are all runtime-CONFIRMED on the throwaway stack. Runtime confirmation raises *confidence* (high on code paths and now on live behaviour) without changing the scores, which already assumed the defects.

### Fixtures / cleanup
