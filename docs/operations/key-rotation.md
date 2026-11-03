# Key Rotation Runbook (OPS-4 S6)

**Audience:** the operator. **Documentation only, except ENCRYPTION_KEY**, whose re-encryption step has a script (`scripts/rotate-encryption-key.ts`, PRIV-004); every environment change on this page stays manual.
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

- **Used by:** `lib/plaid/encryption.ts` — AES-256-GCM with HKDF per-purpose subkeys over a **keyring** of 64-hex root keys: `ENCRYPTION_KEY` (current — every write) and, during a rotation only, `ENCRYPTION_KEY_PREVIOUS` (read-only). Every encrypted column is listed in ONE registry, `lib/plaid/encrypted-fields.ts` (`ENCRYPTED_FIELDS`), and a census test (`lib/plaid/encrypted-fields.test.ts`) fails if any `encryptWithPurpose(` / `sealWithPurpose(` call writes a column that is not in it: `PlaidItem.encryptedToken`, `User.totpSecret`, `User.dateOfBirthEncrypted`, `Connection.credential` (Plaid rows; a WALLET row holds a public descriptor in clear and is out of scope), `BetaAbuseEvidence.sealedPayload` (compact sealed form). The AI runtime-state cookie uses the same key but is never stored. Losing the key = total loss of those fields.
- **Formats and key ids.** A key's **kid** is the first 8 hex chars of SHA-256(key bytes) — a non-secret fingerprint. New writes are `v3:<kid>:<iv>:<tag>:<ct>` (v2's per-purpose HKDF derivation, plus the kid). Reads: a v3 value uses the key its kid names, and an **unknown kid throws** (fail closed). Legacy kid-less values (`v2:…`, v1 `iv:tag:ct`) and compact seals (`c1.…`, which carry no kid) are tried under current, then previous; a wrong key fails GCM authentication and the next key is tried. With `ENCRYPTION_KEY_PREVIOUS` unset nothing changes except that new writes are v3. A malformed `ENCRYPTION_KEY_PREVIOUS` refuses the deploy at boot (`validateEnv()`), naming the variable, never the value.
- **Tooling:** `scripts/rotate-encryption-key.ts` (engine: `scripts/lib/rotate-encryption-key.core.ts`). **Dry run by default** — counts per field, per kid and per legacy format, and trial-decrypts every value that would be rotated, so the dry run proves the apply can succeed; it never prints a key, plaintext or ciphertext. `--apply` re-encrypts only values whose kid ≠ current (including every legacy v1/v2 and every seal the current key does not open), in batches (`--batch=<n>`, default 100). Each write is CAS-guarded on the old ciphertext (`UPDATE … WHERE id = ? AND col = <old>`); a row that changed between read and write is skipped and listed as a conflict, never overwritten. Each written row is read back and decrypted under the current kid; a failed check restores the old value and aborts (exit 4). Idempotent: a re-run writes nothing. `--expect=<n>` binds an apply to the dry run's "to re-encrypt" count. Guards: `--env=<local|preview|production>` is required for every run and must be proven by the target (`scripts/lib/repair-env-guard.ts`, as for the repair scripts; needs `FM_PRODUCTION_DB_REF` for preview/production); `FM_DB_GUARD=clone-only` keeps its meaning; Production needs `--acknowledge-production-key-rotation` (dry run included) and an apply additionally `--i-have-owner-approval=<ticket> --expect=<n>`. No session-level `SET` is sent. Re-encryption does not bump `updatedAt` (raw SQL; the value's meaning is unchanged). Proven in CI against a throwaway Postgres: `npm run accept:key-rotation` (Architecture audits job).
- **Current state:** the keyring and the script ship in step (a) below; no rotation has been run. Before (b), `npx tsx scripts/audit-ciphertext-versions.ts` reports v1/v2/v3/invalid per column (format only, no decryption).

### Rollout order

| Step | What | Who |
|---|---|---|
| **(a)** | Ship the keyring code + the script (this change). With `ENCRYPTION_KEY_PREVIOUS` unset, behaviour is unchanged except new writes are v3. | engineering |
| **(b)** | Generate a new key (`openssl rand -hex 32`). In the environment's Vercel env: set the **new** key as `ENCRYPTION_KEY` and the **old** key as `ENCRYPTION_KEY_PREVIOUS` (Sensitive) → redeploy. Every existing value still reads (previous key); every new write is under the new kid. | **OWNER-GATED** |
| **(c)** | With the same two keys in the operator shell: `scripts/rotate-encryption-key.ts --env=<env>` (dry run: every "to re-encrypt" value readable, 0 unreadable) → `--apply --expect=<n>` → repeat (dry run, apply) until the dry run shows **0 to re-encrypt** and the old kid no longer appears. A conflict is a row that changed mid-run; the next run picks it up. | operator; **Production run OWNER-GATED** |
| **(d)** | Remove `ENCRYPTION_KEY_PREVIOUS` from the environment → redeploy → destroy the old key everywhere (env scopes, local files, password manager entries). | **OWNER-GATED** |

Never do (d) while a dry run under both keys reports anything to re-encrypt or anything unreadable: every such value becomes permanently unreadable.

### Proof before Production

Drill **a → d end to end on a restored backup clone first** (`--env=local` against the clone, `FM_DB_GUARD=clone-only` armed), then on **Preview**, and record each drill in `docs/operations/`. At each environment, after (c) and again after (d), check:

1. **TOTP sign-in** succeeds for a TOTP-enabled test account (seed decrypts under the new key).
2. **Plaid sync** succeeds on a connected sandbox item (access token decrypts) — manual Sync Now.
3. **Connection reads**: the Plaid link-token / update-mode path that reads `Connection.credential` works; a profile with a date of birth renders it.
4. **Unknown kid fails closed**: on the clone, a value written under a third throwaway key is reported `UNKNOWN — unreadable` by the dry run, left untouched by an apply (exit 3), and the read path refuses it.
5. The dry run with only the new key (`ENCRYPTION_KEY_PREVIOUS` unset) reports 0 to re-encrypt and 0 unreadable.

- **Procedure (summary):** full DB backup + verified restore (non-negotiable; RELEASE_CHECKLIST backups item) → clone drill → Preview drill → owner-authorized Production window: (b) → (c) → checks 1–3 → (d) → checks 1–3 again.
- **Interim response for suspected exposure WITHOUT rotating** (per §7.6): restrict access, assess exposure, plan the window.
- **Downtime:** none expected — reads work under both keys throughout (b)–(c). The window is sized by row count (small at current scale) and exists so (d) follows (c) promptly.
- **Validate:** dry run under the new key alone = 0 to re-encrypt, 0 unreadable · a Plaid sync succeeds · a TOTP login succeeds · old key destroyed from all env scopes and local files.

## After ANY rotation

Update `.env.local`/`.env.preview` copies deliberately (KD-13 history: live keys in cloud-synced files was the original sin — keep prod values out of local files); confirm preview/prod separation still holds; note the rotation (what, when, why) in the incident log if exposure-driven.
