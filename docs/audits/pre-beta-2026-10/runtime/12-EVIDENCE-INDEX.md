# 12 — Evidence Index (runtime)

Runtime verification of the static pre-beta audit. HEAD under test `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` (v2.6), verified with `git rev-parse HEAD`. Date 2026-10-21. Every finding in `02`–`08` references its original static finding ID. No token, cookie, secret or password appears in any report.

## 1. The isolated stack

| Component | Detail |
|---|---|
| Source read (read-only) | `/Users/chrstn/dev/FourthMeridian` at `cde8fa0` — unmodified |
| Server source | clean detached worktree at `cde8fa0`, no `.env` files, shared `node_modules` symlink |
| Server | `next dev --webpack` on `127.0.0.1:3100`, launched by a Node launcher with a minimal explicit environment (dummy provider keys; throwaway DB; `FM_RLS_STRICT=true`; OpenAI mock preload); `/api/health` → `{status:ok, db:ok, commit:null}` |
| Database | disposable `postgres:16` container, random loopback port, DB `fintracker_rtv`, migrated + seeded; roles `fm_app`/`fm_auth`/`fm_system` provisioned; owner role `fmowner` for fixtures |
| OpenAI | in-process mock (`mock-openai.cjs` via `NODE_OPTIONS=--require`); modes ok/timeout/500/429/quota/refuse; call log; all non-loopback egress blocked and logged |
| Plaid | dummy credentials, `PLAID_ENV=sandbox`, all seeded Items set to REVOKED (no provider path reachable) |
| Runtime RLS proof | `/api/platform/platform-ops/db-authority`: strict true, 3 roles bound (non-superuser, non-BYPASSRLS, 0 owned tables), tenant identity transaction-local, 70 public tables / 62 ENABLE+FORCE / 246 policies |

Isolation verifications performed: server process holds only dummy keys and the `fintracker_rtv` URL; `localhost:5432` unreachable and never used; `.env.local`/`.env.preview`/Preview+Production credential files never read; `FM_DB_GUARD=clone-only` armed; egress block refused npm, Next telemetry and every provider host; no Production credential accessible.

## 2. Artifacts (scratchpad, not committed)

Under `…/scratchpad/rtv/`:
- Harness: `launch.cjs` (isolated launcher + child-env probe), `mock-openai.cjs`, `login.sh`, `openai-mode.json`, `openai-calls.log`, `server.log`, `README-RTV.md` (the shared briefing), `wt/` (clean worktree).
- `sec/`: `admin_body.html` (SSR'd `/admin` from a pending session after the `update` mutation — SEC-001), `export_extract/accounts.csv` (unescaped formula cell — SEC-004), `jane_spaces.json`.
- `fin/`: `fin001.ts`, `fin001-silent.ts`, `fin002.ts`, `fin003_005.ts`, `fin013.ts` (deterministic engine probes).
- `idemp/`: `run_concurrent_import.sh`, `import.csv`, `resp_A/B.json`, `rollback_resp.json`, `pd_A.json`, `disp_A/B.json`, `idemp009-swallow.ts`, `wh_*.json`.
- `ai/`: `resp-*.json` (baseline, exhaust, resv, postresv, pause/resume, paused-chat, 429, quota, fail500, own, 403) + the shared `openai-calls.log`.
- `spaces/`: `obs001-posture.ts`.
- `db/`: `accept-core.log`, `accept-app.log`, `accept-ai.log`, `accept-plaid.log`, `accept-foreground.log`, `accept-allowance.log` (the six suite runs).

## 3. Coordinator-run commands (independent checks)

- `git rev-parse HEAD` → `cde8fa0…`; `git worktree add --detach … cde8fa0`.
- Isolated stack bring-up: `docker run postgres:16`; `prisma migrate deploy` + `prisma db seed` on the throwaway DB; role password provisioning; `node launch.cjs 3100`.
- SEC-001 independent reproduction: login as `sysadmin@example.com` → `/api/admin/users` 403, `/admin` 307 → `POST /api/auth/session {data:{requireTotpSetup:false}}` 200 → `/api/admin/users` 403, `/admin` **200** with 4 user e-mails in the HTML (jar then deleted).
- Isolation and health polling throughout; role-URL fixture correction (`fm_app` connects, sees 246 policies).

## 4. Database acceptance suite results (authoritative RLS proof)

Run from the repo with Node 24 and `FM_DB_GUARD=clone-only`, each on its own `postgres:16-alpine` clone (logs in `db/`):

| Suite | Result |
|---|---|
| `rls:accept` | 34/34 |
| `rls:accept:app` | 98/98 |
| `rls:accept:ai` | 72/72 |
| `rls:accept:plaid` | 20/20 |
| `rls:accept:foreground` | 67/67 |
| `rls:accept:allowance` | 15/15 |
| **Total** | **306/306** |

## 5. Throwaway-database residue (acceptable per the brief; disposable DB only)

After all workstreams: 5 users (4 seed + 1 `@rtv.invalid` from SEC-008), 376 transactions (12 synthetic from the IDEMP-001 double import), 20 `AiInvocation` rows (the AI workstream's mocked turns; today-spend ≈ $0.02), 27 `JobRun` rows (dispatch pairs + evaluator runs), 2 `ImportBatch` rows (one stuck PROCESSING by design), 0 ACTIVE Plaid Items (all REVOKED). Fixtures the workstreams restored: the DB agent's transient `displayName` probe on 11 shared accounts (restored to NULL, verified); the AI agent's `hashtext` EXECUTE revoke (restored); the kill-switch and exhaust settings (removed); the Spaces agent's seeded `dead` JobRun (deleted, verified). The container and worktree are disposable.

## 6. Environment limitations

Dev server (single process, webpack); in-memory rate limiter; http session cookie; mocked OpenAI (SDK network timeout/retry inferred from code plus the mock honouring `retry-after`); no Vercel lambda kill; disposable PG16 (not Supabase PG17.6); no Sentry; no browser connected (all visual/focus/screen-reader/mobile behaviour UNVERIFIED). Cross-instance and Vercel-cron-overlap races were reproduced by in-process `await` interleaving (sufficient to prove the TOCTOU; easier at Production scale). Production-only facts (OPS-013/015, DB-003/007, edge exploitability, Preview env presence) remain UNVERIFIED by design.

## 7. Deliverables

`01-RUNTIME-EXECUTIVE-SUMMARY.md` · `02-SECURITY-VERIFICATION.md` · `03-FINANCIAL-VERIFICATION.md` · `04-IDEMPOTENCY-CONCURRENCY.md` · `05-AI-RELIABILITY.md` · `06-SPACES-FUNCTIONALITY.md` · `07-OBSERVABILITY.md` · `08-DATABASE-RLS.md` · `09-STATIC-RUNTIME-RECONCILIATION.md` · `10-UPDATED-SCORECARD.md` · `11-REMEDIATION-PRIORITIES.md` · `12-EVIDENCE-INDEX.md`. The original static reports in the parent directory were not modified.
