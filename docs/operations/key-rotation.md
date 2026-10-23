# Key Rotation Runbook (OPS-4 S6)

**Audience:** the operator. **Documentation only — no runtime automation exists or is planned here.**
**Resolves:** the OPS-4 forward references in `INCIDENT_RESPONSE_RUNBOOK.md` §7.6 and `SECURITY_CHECKLIST.md` (Key rotation, Owner: OPS-4).
**Ground rules:** rotate one secret at a time · verify after each · every secret below is boot-validated (`instrumentation.ts` → `validateEnv()`), so a missing/typo'd value fails the deploy loudly rather than limping. Confirm **preview and production do not share values** for any secret on this page (check the Vercel env scopes; this is the SECURITY_CHECKLIST's standing item).

## Rotation order (when rotating everything, e.g. suspected broad exposure)

1. `CRON_SECRET` (cheapest, zero user impact) → 2. `RESEND_API_KEY` → 3. `PLAID_SECRET` → 4. `NEXTAUTH_SECRET` (user-visible: global sign-out) → 5. `ENCRYPTION_KEY` (heaviest — data re-encryption; do NOT do casually).
For a single-secret exposure, rotate just that secret; the order above is severity/blast-radius, not dependency — none of these depend on each other.

## CRON_SECRET

- **Used by:** Vercel cron → `Authorization: Bearer` exact-match in `/api/jobs/dispatch` + the three per-job fallback routes. Prod-required.
- **Procedure:** generate (`openssl rand -hex 32`) → set in Vercel env (production) → redeploy (Vercel injects the new value into cron requests on the next invocation) → done.
- **Downtime:** none. Worst case: a tick fired mid-rotation gets a 401 and that slot's jobs run a day late (self-healing bodies).
- **Validate:** next dispatch tick returns 200 in the Crons dashboard; new JobRun rows appear; a curl with the OLD secret gets 401.

## RESEND_API_KEY

- **Used by:** `lib/email/providers/resend.ts` (the single SDK import site) behind `sendEmail()`. Prod-required; without it prod emails silently capture.
- **Procedure:** create a NEW key in the Resend dashboard → set in Vercel env → redeploy → send a test (password-reset against a test account) → revoke the OLD key.
- **Downtime:** none (create-before-revoke).
- **Validate:** `NotificationDelivery`/reset flow shows `status="sent"` with a fresh `providerMessageId`; Resend dashboard shows the send under the new key.

## PLAID_CLIENT_ID / PLAID_SECRET

- **Used by:** `lib/plaid/client.ts` only (env-validated at import). Per-environment credentials (sandbox/development/production match `PLAID_ENV`).
- **Stored user access tokens are NOT affected** — they are Plaid-item credentials encrypted at rest under `ENCRYPTION_KEY`; rotating the API secret never invalidates them.
- **Procedure:** Plaid dashboard → rotate the secret for the matching environment → set new value in Vercel env → redeploy.
- **Downtime:** Plaid API calls fail between dashboard rotation and the redeploy going live — keep the window short; the 06:00 sync self-heals the next day, and users see refresh errors only inside the window.
- **Validate:** manual "Sync Now" on a connected item succeeds; 06:00 `sync-banks` JobRun row is `succeeded` next morning.

## OPENAI_API_KEY (+ OPENAI_PROJECT_ID, OPENAI_EXPECTED_ENVIRONMENT)

- **Used by:** `lib/ai/openai-credentials.ts` (the credential seam behind `lib/ai/provider.ts`, the single OpenAI SDK import site). **Optional, not boot-validated** — absent ⇒ AI refuses at the first call with a clear message; everything else runs. One key name, no fallback, one record per Vercel environment, one OpenAI project per environment (`docs/operations/openai-environment-separation.md`).
- **Nothing stored depends on it** — no data is encrypted or signed with it; rotation is create-before-revoke with zero data effect.
- **Procedure:** in the environment's OWN OpenAI project (`fourth-meridian-dev` / `-preview` / `-prod`) create a NEW service-account key → paste it into the Vercel record of that environment (Sensitive) → redeploy → verify per `openai-environment-separation.md` §4 (env-status pin shows `project key · pinned · proj_… · match`; one turn lands in that project's usage) → revoke the OLD key in the OpenAI dashboard. `OPENAI_PROJECT_ID` and `OPENAI_EXPECTED_ENVIRONMENT` do not rotate; they change only if the project changes.
- **Downtime:** none (create-before-revoke). Between revoke and redeploy, if done in the wrong order, every AI call fails 401 and is ledgered `FAILED`; customers see the provider-error sentence; nothing else is affected.
- **Validate:** a chat turn returns; `AiInvocation` rows `RETURNED` for the environment; the OpenAI usage dashboard for that project shows the requests and the other two projects show none; a call with the OLD key (from the OpenAI dashboard's key page, not from the app) is listed as revoked.
- **Production:** NOT AUTHORIZED in the AI COST CONTROLS milestone — owner only, later.

## NEXTAUTH_SECRET

- **Used by:** NextAuth JWT signing (`lib/auth.ts`, `strategy: "jwt"` — no DB sessions).
- **Consequence (unavoidable by design):** rotation invalidates every live session token — **all users are signed out** and must log in again. TOTP/passwords unaffected. No dual-key grace exists in this setup.
- **Procedure:** generate (`openssl rand -base64 32`) → set in Vercel env → redeploy → announce/expect the global sign-out.
- **Downtime:** none technically; user-visible session reset. Rotate off-peak.
- **Validate:** old session cookie → redirected to login; fresh login works; `UserSession` history unaffected.

## ENCRYPTION_KEY — the heavy one (do NOT rotate casually; see INCIDENT_RESPONSE_RUNBOOK §7.6)

- **Used by:** `lib/plaid/encryption.ts` — AES-256-GCM with HKDF per-purpose subkeys over ONE 64-hex root. Encrypted at rest under it: Plaid access tokens (`PlaidItem.encryptedToken`), TOTP seeds (`User.totpSecret`), DOB (`User.dateOfBirthEncrypted`), non-Plaid connection credentials (`Connection.credential`). Losing it = total loss of those fields; rotating it requires re-encrypting them.
- **Current state (verified 2026-07-07):** all ciphertext is v2 (SEC-1 complete, zero v1 rows — re-verify with `npx tsx scripts/audit-ciphertext-versions.ts`). **Named gap, deliberate:** no decrypt-with-old/encrypt-with-new script exists yet (S6 is documentation-only by its own fence). Writing `scripts/rotate-encryption-key.ts` is the FIRST step of any real rotation and its shape is fixed by this runbook: read each encrypted field → `decryptWithPurpose` under `OLD_ENCRYPTION_KEY` → `encryptWithPurpose` under the new `ENCRYPTION_KEY` → row-by-row update, idempotent (skip rows already decryptable under the new key), dry-run mode first, run against a restored backup before prod.
- **Procedure:**
  1. Full DB backup + verify a restore (non-negotiable precondition; see RELEASE_CHECKLIST backups item).
  2. `npx tsx scripts/audit-ciphertext-versions.ts` — expect 100% v2, 0 invalid (also run `scripts/diagnose-invalid-plaid-tokens.ts` if anything is off).
  3. Write/obtain the rotation script per the shape above; drill it against a restored backup copy first (record the drill in `docs/operations/`).
  4. Maintenance window: deploy with BOTH `OLD_ENCRYPTION_KEY` and new `ENCRYPTION_KEY` set → run the script → re-audit (100% decryptable under the new root) → remove `OLD_ENCRYPTION_KEY` → redeploy.
  5. Interim response for suspected exposure WITHOUT rotating (per §7.6): restrict access, assess exposure, plan the window.
- **Downtime:** a maintenance window sized by row count (small at current scale); decrypt failures during a half-rotated state are why the script runs inside the window with both keys available.
- **Validate:** audit script 100% v2-decryptable under the new root · a Plaid sync succeeds (token decrypt works) · a TOTP login succeeds (seed decrypt works) · old key destroyed from all env scopes and local files.

## After ANY rotation

Update `.env.local`/`.env.preview` copies deliberately (KD-13 history: live keys in cloud-synced files was the original sin — keep prod values out of local files); confirm preview/prod separation still holds; note the rotation (what, when, why) in the incident log if exposure-driven.
