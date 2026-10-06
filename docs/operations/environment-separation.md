# Environment separation: Preview vs Production (verified 2026-10-06)

**Scope:** which secrets and settings Preview and Production share, what each one protects, and what changing it breaks. This supersedes the *Current* column of `docs/plans/PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md` §17.2 where they differ; the reasoning in §17 (rotation consequences, `ENCRYPTION_KEY` data inventory, threat model) still stands.

**Production was not touched.** No Production env record, deployment, secret, domain, database or Plaid setting was changed in this lane. The newest Production-targeted env record was last updated 2026-09-01. The newest Production deployment is from 2026-07-27, 71 days before this inventory.

## 1. How equality was established without reading values

Every variable on the project is a Vercel **Sensitive** variable. `vercel env pull` returns them empty, and neither the dashboard nor the API decrypts them. So a value comparison is impossible by design, which is good. Equality is established in three ways, and the matrix says which one applies:

- **SAME RECORD (proven).** One env record whose targets are `production, preview` holds one value for both. Applies to `NEXTAUTH_SECRET` (generic Preview), `ENCRYPTION_KEY` and `PLAID_CLIENT_ID`.
- **SEPARATE RECORDS (proven).** Two records, one per target. The values *may* still be equal: the record split says nothing about the value.
- **OWNER-STATED.** The owner's 2026-10-03 confirmation (§17.0) that `OPENAI_API_KEY` and `CRON_SECRET` held the same value in both environments. No machine check can confirm this without a runtime in each environment.

## 2. Vercel structure facts

- `preview.fourthmeridian.com` is the git-branch domain for `v2.6` and follows the newest `v2.6` deployment.
- **Vercel deployment protection (SSO) covers Preview.** Unauthenticated requests get a 302 to `vercel.com/sso-api`. Vercel's own cron requests are not affected (Production only).
- The only remote branches are `main` (Production) and `v2.6`. Any *other* branch pushed later builds with the **generic** Preview scope: everything below marked "generic Preview".
- **Old Preview deployments keep the env they were built with.** Every Preview deployment before `dpl_2pNvfNQ539juTzLSoouJ4sdPwNqi` still runs with the shared `NEXTAUTH_SECRET` and the old `CRON_SECRET`. They sit behind the same SSO protection.

## 3. Vercel crons never reach Preview (proven, not assumed)

`vercel.json` schedules `/api/jobs/resume-stale-imports` **every 5 minutes** and `/api/jobs/dispatch` 10× a day. Both go through `runJob()`, which writes a `JobRun` row with `trigger='cron'` on every authorised call. Preview has had a valid `CRON_SECRET` since 2026-06-30, yet **the Preview database has never held a single `JobRun` row** (read-only query, 2026-10-06 14:0xZ). If Vercel ran crons against Preview, there would be tens of thousands. Changing Preview's `CRON_SECRET` therefore cannot affect any schedule.

## 4. Matrix

Classes: **A** = launch blocker · **B** = safe intentional temporary sharing · **C** = post-launch hardening.

| Variable | Preview | Production | Shared? | Persisted-data dependency | Action taken (2026-10-06) | Remaining owner action | Class |
|---|---|---|---|---|---|---|---|
| `NEXTAUTH_SECRET` | **v2.6: own value (new)**; generic Preview: the shared record | Shared record (2026-06-16) | v2.6: **no**. Generic Preview: **yes, same record** | None. It keys the session JWE and CSRF hash only. Cookies are `__Host-` host-only. `UserSession.sessionToken` is a random UUID | Preview(v2.6) override added and redeployed. Old Preview session rejected (§5) | **Production rotation (E-1)**, together with deploying P1 to Production (§6) | **A** (Production side) |
| `ENCRYPTION_KEY` | Shared record | Shared record | **Yes, same record** | **Yes.** HKDF root for `PlaidItem.encryptedToken`, `Connection.credential` (PLAID), `User.totpSecret`, `User.dateOfBirthEncrypted`, and the `fm_ai_state` cookie seal. No keyring; a change without re-encryption strands every one of them | **None (not authorised; no keyring migration exists)** | Preview separation via the §17.5 *recreate* path (Preview data is sandbox/test) or a P2 re-encryption script; Production stays as is | **B** now; **A** before Production holds real Plaid tokens *if* Preview keeps it. See §6 |
| `CRON_SECRET` | **v2.6: own value (new)**; generic Preview: own record (2026-06-30) | Own record (2026-06-30) | v2.6: **no**. Generic Preview: separate record, owner-stated equal | None. Nothing stores it. Vercel injects it only into Production cron calls (§3) | Preview(v2.6) override added and redeployed. No header → 401; random bearer → 401 | **Production rotation (E-2)** (its value was readable from Preview). Optionally delete the generic Preview record | **A** (Production side, operational) |
| `DATABASE_URL` | Own record → Preview project `lqagrryecvhbaqvczjgc` (`postgres`, legacy/migration principal) | Own record → separate Production project (Micro) | No | It *is* the data | None | — | — |
| `DIRECT_URL` | Own record (Preview `postgres`) | Own record | No | Migration principal | None | Remove from the Vercel **runtime** of both environments once nothing reads it at runtime (Vercel does not migrate) | C |
| `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM` | **v2.6 only**: `fm_app` / `fm_auth` / `fm_system` on the Preview pooler | **Absent** | No | Role passwords live in the Preview DB only | None. db-authority green before and after | Production values arrive with the Production RLS cutover | A for Production cutover (RLS lane) |
| `FM_RLS_STRICT` | **v2.6 only**: `true` | **Absent** | No | — | None | Production: `true` at cutover. Code now refuses Production start without it (`dc3755f`), which is **not yet deployed** to Production | A for Production cutover (RLS lane) |
| `OPENAI_API_KEY` | Own record (2026-07-01) | Own record (2026-07-02) | Separate records, **owner-stated same key** | None. Chat completions only, no `store`, files or assistants | **None. It needs owner action at OpenAI** (§7) | Create a Preview OpenAI project with a budget cap, then put its key on Preview | **B** → C (cost/quota blast radius, no data authority) |
| `PLAID_CLIENT_ID` | Shared record | Shared record | Yes, same record | None | None | — (Plaid's model: the secret selects the environment) | B (permanent, by design) |
| `PLAID_SECRET` | Own record (2026-06-16) | Own record (2026-06-22) | Separate records; equality **unknown** | Stored access tokens are **not** keyed to it | None (Plaid frozen) | In the Plaid lane: Preview gets the **sandbox** secret | **A**: see `PLAID_ENV` |
| `PLAID_ENV` | Own record; **value `production`** (owner-visible read, 2026-10-06) | Own record (`production`, enforced at boot) | Same value, separate records | Legacy Preview Items are **owner-verified sandbox** data whatever this says | None (Plaid frozen) | Plaid lane: Preview → `sandbox` + sandbox secret, then a fresh sandbox Item for provider acceptance | **A**: Preview currently holds Production Plaid authority (client id + a production-environment secret) |
| `PLAID_WEBHOOK_URL`, `PLAID_REDIRECT_URI` | **Absent** (derived from `NEXT_PUBLIC_APP_URL`) | **Absent** | n/a | Existing Items keep the webhook they were created with | None | Domain lane (§16.3 of the split doc) | — |
| `RESEND_API_KEY` | Own record (2026-07-06) | Own record (2026-07-06) | Separate records; equality **unknown** | None | None. Kept per owner instruction | Resend dashboard: confirm Preview's key is a **separate, sending-only** key (and domain-restricted if possible). Preview delivers real mail to **any** recipient (no non-production allowlist in `lib/email/send.ts`), so Preview test accounts must stay owner-controlled | B (C: a Preview recipient allowlist) |
| `ALCHEMY_API_KEY`, `COINGECKO_API_KEY`, `TIINGO_API_KEY`, `OXR_APP_ID` | Own records | Own records | Separate records; equality unknown | None | None | Separate keys where the provider meters per key | C (quota only) |
| `NEXT_PUBLIC_SENTRY_DSN` | Own record | Own record | Separate records | None (a DSN is public) | None | Confirm Preview events carry `environment=preview`, or use a separate Sentry project | C |
| `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | Own records | Own records | No (per-host values) | Email links / Plaid redirect derive from it | None | Domain lane | — |
| `DISABLE_SYSTEM_ADMIN`, `RATE_LIMIT_ENABLED`, investment/wealth flags, `AI_FORECAST_GUARD_MODE` | Own records | Own records | Config, not credentials | — | None | — | — |
| `TURNSTILE_SECRET_KEY`, `ETHERSCAN_API_KEY`, `HELIUS_API_KEY`, `ETH_RPC_URL`, `SOL_RPC_URL` | **Absent** | **Absent** | n/a | — | None | Decide per feature before launch (Turnstile: bot protection on sign-up) | C |

## 5. Preview mutations performed and their verification

Both are **branch-scoped** (`Preview`, git branch `v2.6`) records. A branch record overrides the generic Preview value for `v2.6` deployments only. The shared `production, preview` record was **not** edited: its `updatedAt` stayed 2026-06-16 before and after. Values were generated locally (`openssl rand`), piped straight into `vercel env add … --sensitive`, and never printed.

1. `NEXTAUTH_SECRET` (Preview, v2.6), created 2026-10-06T14:06:47Z.
2. `CRON_SECRET` (Preview, v2.6), created 2026-10-06T14:07:05Z.
3. Redeployed the `c3ba7fd` Preview deployment → `fintracker1-4xlyvyngl` (`dpl_2pNvfNQ539juTzLSoouJ4sdPwNqi`). `preview.fourthmeridian.com` follows it.

Verification:
- **Old session rejected.** The owner's existing Preview browser session went from `/api/auth/session` with a user to no user. `db-authority` went from 200 to 401, and the dashboard redirects to login. Same browser, same cookies; only the secret changed.
- **Fresh sign-in** first FAILED: not because of the rotation, but because of a latent RLS defect the rotation exposed (§5a). It succeeded after the fix; signed-in smoke: §8.
- **CRON:** `/api/jobs/fetch-fx-rates` gets 401 with no header and 401 with a random bearer. A 200 with the new value was **not** exercised: Preview sits behind SSO, and reaching it from a script would mean either creating a protection-bypass secret (a persistent project setting) or pasting the value into a browser. The owner can run that check from a signed-in browser console if wanted.
- **Database authority:** `fm_app` / `fm_auth` / `fm_system` bound, `bypassRls=false`, strict on.
- **Isolation (`fm_app`, user A):**
  - B's accounts 0, B's transactions 0, B's PERSONAL Space and the Space A has LEFT both invisible.
  - With no identity set: 0 accounts, 0 transactions. The only visible Space is the one with `isPublic=true`.
  - Platform Spaces are visible only through A's four ACTIVE grants. Merchant Operations (no grant) is invisible.
- **Database health:** 0 `fm_*` idle-in-transaction sessions, 0 lock waits, 0 transactions older than 30 s.

**Rollback:** `vercel env rm NEXTAUTH_SECRET preview v2.6` (or `CRON_SECRET`), then redeploy. v2.6 falls back to the generic Preview record. Rolling back NEXTAUTH_SECRET restores the shared Production secret to Preview, so prefer setting another new value instead.

## 5a. Login regression exposed by the rotation (fixed in `bfb6cbd` + `8358743`)

The rotation forced the first fresh login since the Preview RLS cutover, and it failed with "Invalid email, username, or password". The password was correct every time.

- **Cause.** fm_auth holds INSERT only on `AuditLog` (FORCE RLS, no fm_auth SELECT policy). Prisma's `create()` is `INSERT … RETURNING`, and RETURNING needs SELECT. So `authorize()` verified the password, then its `[userSession.create, auditLog.create]` transaction died with `42501 permission denied for table AuditLog`. NextAuth answered 401, and the UI maps every 401 to "invalid password".
- **Scope.** The last successful Preview login was at 01:06Z, before the cutover. Every `LOGIN_FAILED` audit since the cutover was swallowed by `recordLoginFailure`'s catch. Logout, recovery-code, reactivation, cancel-deletion and email-confirm audits had the same write.
- **Proof.** The Vercel logs for all three attempts show the 42501 on batch statement 1, which is only reached after bcrypt passes. Reproduced as fm_auth in a rolled-back transaction: a plain INSERT is allowed, `INSERT … RETURNING` is denied.
- **Fix.** `auditInsert()` in `lib/audit.ts` writes the row with `createMany`, a plain INSERT, and pre-generates the id. **The grant is unchanged**: fm_auth still cannot read the audit trail.
- **Gate.** `scripts/rls-foreground-acceptance.ts` cases 63–67:
  - the real `authorize()` on real roles;
  - a wrong-password audit;
  - recovery-code use;
  - a negative control showing `create()` and reads are still refused;
  - a source ratchet.

  On the old source, 63, 64, 65 and 67 fail.
- **Delivery.** Clean-copy CI green, then GitHub CI 37499024560 green on exact `8358743`, then deployed as `fintracker1-49golqcgb` (`dpl_E4mpC5xmaEaXtLbFPkYqkipT5QW8`).
- **Lesson.** No RLS suite had driven the credential path end to end through Prisma. SQL-level grant checks cannot see `RETURNING`.

## 6. 🚨 Finding: Production predates P1, so the shared `NEXTAUTH_SECRET` is still a direct Production credential

P1 (`0ac1012`, 2026-10-03) makes a validly signed JWT insufficient: the session row must exist, be unrevoked, and belong to the token's user. **Production's live deployment is from 2026-07-27 and does not contain P1.** So on Production today, anyone holding `NEXTAUTH_SECRET` can mint a session for any user id with any role, including `SYSTEM_ADMIN`, with no session row and no TOTP (§17.1).

That value is still in:
- every generic-Preview deployment;
- every Preview deployment built before today's redeploy.

Any code that runs in those deployments can read it. Today that means anyone who can push a branch to this repository, or who controls a dependency built into a Preview deployment.

The Preview override above stops *new* `v2.6` deployments from receiving it. It does **not** reduce Production exposure. Only these two steps, both Production mutations and **not authorised in this lane**, do:
- deploy P1 (any current `v2.6` commit) to Production;
- rotate Production's `NEXTAUTH_SECRET` (E-1) in that same deploy. A one-time Production sign-out, no data effect.

`CRON_SECRET` has the same shape at lower severity. Production jobs can be triggered at will (Plaid syncs, provider quota), but no data is exposed.

## 7. OpenAI: what only the owner can do

The repo cannot tell which OpenAI project a key belongs to without calling OpenAI with that key, and the keys are not readable. The owner's steps:

1. platform.openai.com → Projects → create `fourth-meridian-preview` with a monthly budget cap.
2. Create a service-account key in it.
3. Paste it **directly** into Vercel as `OPENAI_API_KEY`, Preview, branch `v2.6`, Sensitive. Never into chat.
4. Redeploy Preview, run one AI turn, and confirm usage appears only in the new project.
5. Production (later, E-3): its own project and key.

Until then, a Preview compromise can spend from and rate-limit the Production project. It cannot reach Production data.

## 8. Signed-in smoke after the rotation

Run on `dpl_E4mpC5xmaEaXtLbFPkYqkipT5QW8` (`8358743`), 2026-10-06 ~17:05Z, after the owner's one manual sign-in:

- **Sign-in:** one `UserSession` row and its `LOGIN` audit row committed together at 17:04:08Z.
- **Pages, all 200 signed in:** `/dashboard` overview, accounts and transactions tabs; Spaces; Connections; Credit; settings (account, security, preferences, data); `/api/user/sessions`; `/api/spaces`. The dashboard renders live data. `/merchant-ops` still redirects (no MERCHANT_OPS grant, as designed).
- **db-authority:** 200, `ok=true`, strict, with `fm_app` / `fm_auth` / `fm_system` all `bypassRls=false`.
- **Logs:** 500 Preview requests since the deploy, **0 × 5xx**, no `42501` / `P2028` / `EMAXCONN`.
- **Isolation (fm_app):** user A sees 0 of B's accounts and 0 of B's transactions. With no identity set, 0 transactions.
- **Database:** 0 `fm_*` idle-in-transaction sessions, 0 lock waits, 0 transactions older than 30 s.
- **Not exercised, deliberately:** AI / Brief pages (no OpenAI calls), Plaid, and any job route returning 200.
