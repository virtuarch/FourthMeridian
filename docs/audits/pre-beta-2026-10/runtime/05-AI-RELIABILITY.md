> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# Workstream AI (Phase 5 — AI reliability) — runtime verification report

Repo HEAD under test: `cde8fa0` (v2.6). Server: `http://127.0.0.1:3100` (Next dev, webpack, single process).
OpenAI MOCKED in-process (`$S/rtv/mock-openai.cjs`); no paid calls possible. Actor: `jane@example.com`
(`cmviisb5q0000sem79bf5s5in`), jar `$S/rtv/cookies/jane.txt`, `X-Forwarded-For: 10.4.0.x`, `Origin: http://127.0.0.1:3100`.
Mode file reset to `{"mode":"ok","delayMs":0}` at finish. No tokens/secrets/cookies printed.

Chat turn shape observed: **2 model calls per successful turn** — the answer call (`generateWithTools`, model `gpt-5.1`)
plus the guidance-classifier call (`engine.ts` `defaultGuidanceCall`, SEC-AI-008) — so **2 `AiInvocation` RETURNED rows per turn**.
Baseline before testing: jane had 0 `AiInvocation` rows, 0 in-flight buckets, no `ai_*` `PlatformSetting` rows.

Runtime observation (environment): rate-limit/in-flight buckets key on `X-Forwarded-For`; rotating the last octet
gives each probe its own bucket (confirmed — exhaustion/refusal probes never tripped the pacing limiter).

---

## Item 1 — Daily allowance enforcement + reservation atomicity + release on success/refusal
Finding IDs: SEC-AI-002, "AI: spending abuse", "AI: allowance bypass", "AI: reservation races", IDEMP (reserve/release row).

**Initial state.** jane: allowance `$5` (BETA default; confirmed from refusal body), 0 spend today, in-flight bucket 0,
enforcement ON (no `ai_daily_allowance_enforced` row ⇒ `enforcedFrom(null)=true`).

**Method & Actual.**
1. *Normal turn* (XFF `10.4.0.11`), mode `ok`, `{"messages":[{"role":"user","content":"What is my net worth?"}]}`:
   → **HTTP 200**, `{"message":"Mock answer: …"}`. Mock log **+2** lines (`/v1/chat/completions` ×2, `gpt-5.1`).
   `AiInvocation`: **2 RETURNED rows** written, `surface=chat`, `spaceId=cmviisb7p001hsem70jj8mm37` (Jane's Space,
   re-resolved), `conversationId` set, `userId=jane`, promptTokens 1200 / completionTokens 40. In-flight bucket **0** after.
2. *Reservation increment/release on success* (XFF `10.4.0.12`, mode `ok` `delayMs=4000`, turn fired in background,
   bucket polled each second): bucket `0 → 1` (held at 1 across t+1s…t+6s while the turn was in flight) `→ 0` after the
   turn returned 200. Confirms: one reserve per **turn** (not per model call), decremented in the route `finally`.
3. *Drive to exhaustion* (XFF `10.4.0.13`): seeded one `AiInvocation` (`id=rtv-ai-seed-exhaust-1`, OPENAI/gpt-5.1,
   RETURNED, surface=chat, today, `promptTokens=20,000,000` ⇒ ≈ `$25` at gpt-5.1 `$1.25/M` input). Next turn →
   **HTTP 429**, body `{"code":"AI_ALLOWANCE","reason":"ALLOWANCE_EXHAUSTED","spentUsd":25.01,"allowanceUsd":5}`,
   `Cache-Control: no-store`, **no `Retry-After`** (correct — only RESERVATION_UNAVAILABLE carries one).
   Mock log **+0** (refused before any model work). In-flight bucket stayed **0** (refused verdict ⇒ `release = NO_RELEASE`,
   no increment). A second refused request was also 429 / 0 mock calls. Seed row deleted afterward.

**Expected.** 200 + one RETURNED-row-per-call + in-flight returns to baseline on success; 429 ALLOWANCE_EXHAUSTED once
over the line, no model call, bucket unchanged on refusal. **Matched exactly.**

**Reproducibility.** Deterministic (mock). **Classification: CONFIRMED.**
**Remediation.** None for the behaviour tested. (Overshoot bound SEC-AI-002 and unreserved guidance call SEC-AI-008
remain as documented P2/P3 — not re-opened here; the reserve is `$0.315`/turn and the guidance call is a 2nd unreserved
paid call.)

---

## Item 2 — Fail-closed when the reservation cannot run (SEC-AI / IDEMP core)
Finding IDs: "AI: reservation races", "AI: fail-open vs fail-closed", IDEMP reserve/release.

**Code evidence (HEAD, 89a46ad/e67fa58 merged).** `lib/platform/ai/allowance-reservation.ts:150`
`await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(${allowanceLockKey(userId)}))\`` is the first statement of a
single `client.$transaction` (`$executeRaw`, never `$queryRaw` — the P2010 "deserialize void" root cause). If the tx
throws, the outer `catch` (`:187`) falls through to `readEnforced(client)`; enforcement ON ⇒ returns verdict
`{allowed:false, reason:"RESERVATION_UNAVAILABLE", reservation:"UNAVAILABLE"}` ⇒ route 503 + `Retry-After` (`allowance-core.ts`).

**Runtime induction (throwaway DB only).** `hashtext`/`pg_advisory_xact_lock` are used **nowhere else** in the source
(only this file), and `fm_system` is non-superuser (`rolbypassrls=f`) holding `EXECUTE` on `hashtext(text)` only via
`PUBLIC`. `REVOKE EXECUTE ON FUNCTION hashtext(text) FROM PUBLIC, fm_system` → `SET ROLE fm_system; SELECT hashtext('x')`
returned **`ERROR: permission denied for function hashtext`**. Chat turn (XFF `10.4.0.41`, mode `ok`):
→ **HTTP 503**, body `{"code":"AI_ALLOWANCE","reason":"RESERVATION_UNAVAILABLE","retryable":true,"retryAfterSeconds":15,
"spentUsd":0.02,"allowanceUsd":5}`, header `retry-after: 15`, `cache-control: no-store`. Mock log **+0** (FAILED CLOSED —
provider never reached), in-flight bucket **0** (nothing reserved). `GRANT EXECUTE … TO PUBLIC` restored; next turn → 200.

**Expected.** Reservation failure ⇒ 503 RESERVATION_UNAVAILABLE, no model call, no reservation leaked. **Matched.**

**Reproducibility.** Deterministic. **Classification: CONFIRMED** (the fail-closed path is reached and refuses, not admits).
**Remediation.** None — this is the intended post-2026-10-16 behaviour.

---

## Item 3 — Emergency pause (kill switch)
Finding ID: "AI: emergency pause".

**Initial state.** No `ai_paid_requests_paused` row (absent ⇒ off).

**Method & Actual.**
1. `PATCH /api/platform/platform-ops/ai-cost-controls` as jane (CONTROL, fresh session), XFF `10.4.0.14`,
   `{"changes":[{"control":"killSwitch.paused","value":true,"expectedUpdatedAt":null}],"reason":{"code":"TESTING",…}}`
   → **HTTP 200**; read model `killSwitch.paused.value=true`, `origin="SETTING"`, `updatedByName="Jane Smith"`.
   Row `ai_paid_requests_paused='true'`. `AuditLog` **PLATFORM_POLICY_CHANGED** written.
   (First attempt without `expectedUpdatedAt` → 400 VALIDATION — the field is required; recorded.)
2. Chat turn while paused → **HTTP 503**, body `{"code":"AI_PAUSED","error":"AI features are paused…"}`,
   `cache-control: no-store`. Mock log **+0** — refused **before the allowance and before the provider** (route checks the
   kill switch after auth/entitlement/pacing). No `AiInvocation` row from this path.
3. Resume `PATCH …value:false` (with observed `expectedUpdatedAt`) → 200. **Immediately next** chat turn → **HTTP 200**,
   mock log **+2**. Effect visible on the very next request (no cache — the reader does a PK lookup per call).

**Expected.** Pause refuses before any mock call; resume works on the next request. **Matched.**
**Reproducibility.** Deterministic. **Classification: CONFIRMED.** **Remediation.** None.

---

## Item 4 — Provider failure + timeout + retry
Finding IDs: SEC-AI-003 ("AI: provider timeout / retry"), db1950b (quota no-retry), failure-fact ledger.

**Method & Actual** (one turn each; snapshotting mock-log line count and `AiInvocation` rows):

| mode | XFF | HTTP | elapsed | mock calls (one turn) | AiInvocation written |
|---|---|---|---|---|---|
| `500` | 10.4.0.21 | 502 (SAY.silent) | ~2s | **3** | 1 × **FAILED**, errorCode `500`, 0 tokens |
| `quota` | 10.4.0.22 | 502 | ~1s | **3** | 1 × **QUOTA**, errorCode `insufficient_quota`, 0 tokens |
| `429` | 10.4.0.23 | 502 | **88s** | **18** | 6 × **RATE_LIMITED**, 0 tokens |

- **429 bounded retry.** 18 = **6 app-level attempts** (1 + `DEFAULT_MAX_RATE_LIMIT_RETRIES=5`, `callWithRateLimitRetry`,
  no deadline on the chat path) **× 3 SDK-internal requests** (SDK default `maxRetries=2`). It terminates (bounded) and
  returns 502 after exhausting retries; 6 RATE_LIMITED facts, one per app attempt. The ~88s is the app backoff
  (5+10+15+20+25s fallback) plus SDK internal waits.
- **quota NO app-level retry (db1950b).** `isRateLimitError` excludes `insufficient_quota`, so
  `callWithRateLimitRetry` rethrows immediately — **1s elapsed, no 30s backoff**. (The 3 mock calls are the OpenAI SDK's
  own `maxRetries=2` firing on the 429 **status**, which does not inspect the body code — see SEC-AI-003 below.)
- **500 surfaced + FAILED fact.** Failure surfaced to the user (502), and a zero-token FAILED row with errorCode `500`
  written (`recordOpenAiFailure` → `classifyAiFailure`). 3 mock calls = SDK retrying the 5xx twice; no app retry.

**SEC-AI-003 (SDK defaults) — from code + runtime amplification.** `provider.ts` `getClient()` builds
`new OpenAI({ apiKey, organization:null, baseURL })` with **no `timeout` and no `maxRetries`** ⇒ SDK defaults apply:
**10-minute timeout, 2 retries**. The chat tool loop (`generateWithTools`) has **no per-call `AbortController`**; only the
structured path (`generateStructuredWithUsage`) wraps a 60s `STRUCTURED_TIMEOUT_MS`. Runtime consequence: (a) a hung
provider connection on a chat hop blocks up to ~10 min per attempt (dev has no lambda kill; prod relies on route
`maxDuration=300`); (b) the two retry layers **compound** — one 429 turn issued **18** provider requests. The 10-min hang
was not reproduced (per instructions; `timeout` mode reserved).

**Reproducibility.** Deterministic. **Classification:** 429 bounded retry / quota no-app-retry / 500 FAILED row —
**CONFIRMED**. SEC-AI-003 (no SDK timeout/maxRetries pin, compounding retries) — **SUPPORTED** (code + the 18-call amplification).
**Remediation.** Set explicit `timeout` and `maxRetries:0` on the client (let the app's own `callWithRateLimitRetry` be the
sole retry authority); add an `AbortController` deadline to `generateWithTools` as the structured path has.

---

## Item 5 — Ledger consistency (IDEMP-009)
Finding ID: IDEMP-009.

**Initial state / Method.** Across the 6 successful turns in this run (baseline, in-flight, resume, own-Space, etc.),
I queried `AiInvocation` for jane **immediately after** each 200 returned.

**Actual.** Every expected RETURNED row was already present at response time — **12/12** RETURNED rows (2 per turn) visible
with no delay.

**But (code).** `provider.ts:147,175` call `void recordAiInvocation(...)` / `void recordOpenAiFailure(...)` —
**fire-and-forget**, and `invocation.ts` swallows its own errors. The insert is **not awaited** before the HTTP response;
it lands first in the happy path only because awaited work after each model call (the guidance call + possessive
formatting + cookie sealing + `NextResponse.json`) overlaps the async insert. IDEMP-009's concern therefore stands: a turn
whose insert is slow or fails would return 200 having **under-counted** that spend against the daily allowance (bounded, while
the turn runs, only by the in-flight reservation).

**Expected per IDEMP-009.** Write not awaited; works in practice, risk on slow/failed insert. **Matched.**
**Reproducibility.** Observational (could not force a slow insert at runtime). **Classification: SUPPORTED** (corroborates
the static P2). **Remediation.** `await` the single insert before responding, or a durable outbox (as the doc recommends).

---

## Item 6 — Cross-user isolation
Finding IDs: "AI: tool authorisation" (403 on mismatch), "AI: cross-customer leakage".

**Code evidence.** Chat tools take no `spaceId`/`userId` argument; the route re-derives `spaceCtx` via
`resolveSpaceContext(user.id, parsed.spaceId)` and binds `aiPhaseRunner(user.id)` from `requireUser()`. A named Space that
does not resolve to itself is a hard refusal (`route.ts:182` — `parsed.spaceId !== null && spaceCtx.spaceId !== parsed.spaceId
⇒ 403`), never a silent fallback to the caller's own money under another label.

**Method & Actual** (jane, XFF `10.4.0.31`):
- `spaceId` = `cmviisb7s001isem75uw514hy` (John's Space; jane not a member) → **HTTP 403**
  `{"error":"You don't have access to that Space."}`, mock log **+0** (refused before the model).
- `spaceId` = `does-not-exist-zzz` → **HTTP 403**.
- `spaceId` = `cmviisb7p001hsem70jj8mm37` (jane's own) → **HTTP 200**; resolved `spaceId` on the written rows = jane's own.

**Expected.** Mismatched Space ⇒ 403, no model call, no cross-tenant read. **Matched.**
**Reproducibility.** Deterministic. **Classification: CONFIRMED** (bounded; not brute-forced).
**Remediation.** None for this path.

---

## Scores — AI-security items (static audit vs runtime)

| Item (finding) | Static disposition (audit) | Runtime result | Confidence | Residual uncertainty |
|---|---|---|---|---|
| Allowance enforcement + reserve/release (SEC-AI-002; "allowance bypass"; "reservation races") | reservation 8/10; both routes gated | **CONFIRMED** — 429 at the line; reserve 0→1→0 on success; no increment on refusal | High | Overshoot bound (SEC-AI-002) and unreserved guidance call (SEC-AI-008) not stress-tested (accepted P2/P3) |
| Fail-closed reservation ("fail-open vs fail-closed"; IDEMP reserve) | fail-closed by design (post-2026-10-16) | **CONFIRMED** — induced tx failure ⇒ 503 RESERVATION_UNAVAILABLE, Retry-After 15, no provider call, no leak | High | Induced via `hashtext` EXECUTE revoke, not a real lock-service outage (equivalent failure mode) |
| Emergency pause ("AI: emergency pause", 9/10) | immediate, mid-turn, no cache, CONTROL-gated | **CONFIRMED** — 503 AI_PAUSED before provider; resume effective next request; audited | High | Did not exercise the mid-turn provider-chokepoint pause (route-level pause verified) |
| Provider retry/timeout (SEC-AI-003, 4/10) | chat hops: 10-min timeout + 2 hidden SDK retries | **SUPPORTED** — no timeout/maxRetries on client; 1 turn = 18 provider calls (6 app × 3 SDK) | High | 10-min hang not reproduced (by instruction) |
| Quota no-retry (db1950b) | quota never app-retried | **CONFIRMED** — quota 1s/no backoff/1 QUOTA fact; vs 429 88s/18 calls | High | SDK still retries the 429 **status** 2× (body code not inspected) |
| Failure facts (ledger) | FAILED/QUOTA/RATE_LIMITED zero-token rows | **CONFIRMED** — 500⇒FAILED(500), quota⇒QUOTA(insufficient_quota), 429⇒6×RATE_LIMITED, all 0 tokens | High | — |
| Ledger await (IDEMP-009, P2) | fire-and-forget; under-count risk | **SUPPORTED** — rows present on all 12/12 happy-path writes, but code is `void` (not awaited) | Medium | Could not force a slow/failed insert to realise the under-count at runtime |
| Cross-user isolation ("tool authorisation" 8/10) | scope fixed server-side; 403 on mismatch | **CONFIRMED** — 403 on another user's / nonexistent Space, no model call | High | Bounded probe (not exhaustive) |

## Environment differences from Production
Dev server (webpack), single process, **in-process OpenAI mock** (no real SDK network, so SDK timeout/retry behaviour is
inferred from code + the mock's status/body, and the mock honours `retry-after`); in-memory rate limiter
(`NODE_ENV=development`); http cookies (`next-auth.session-token`, not `__Host-`); no Vercel lambda kill (so a `timeout`
mode would hang where prod `maxDuration=300` would cut it); throwaway Postgres with RLS strict; no Sentry DSN (capture
no-ops). The `hashtext` EXECUTE revoke (item 2) was applied to the throwaway DB only and restored immediately.

## Cleanup performed
Mode file → `{"mode":"ok","delayMs":0}`; `hashtext` EXECUTE restored to PUBLIC (verified); seeded exhaust row deleted;
`ai_paid_requests_paused` row deleted (back to pristine absent state); in-flight bucket at 0. Left as evidence (throwaway
DB): jane's test `AiInvocation` rows (12 RETURNED, 6 RATE_LIMITED, 1 QUOTA, 1 FAILED; today-spend ≈ $0.02, far under $5)
and 2 `AuditLog` PLATFORM_POLICY_CHANGED rows (kill-switch pause/resume).
