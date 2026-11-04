# Data Retention Schedule

Implemented by the daily `purge-trash` job (07:30 UTC) on the beta-1 candidate (commit `d3aa0ed`, PRIV-003 / DB-001 / OBS-007 / PRIV-012). Source: pre-beta remediation, Agent C. Changing a window is a code change in the retention job plus this table.


| Table | Kept for | Deleted when | Notes |
|---|---|---|---|
| `UserSession` | 30 days after revocation or expiry | `revokedAt < now − 30 d`, OR expired (SEC-010: the earlier of `lastActiveAt` + idle timeout and `createdAt` + absolute lifetime) more than 30 d ago | Live sessions are never touched. Expiry uses the `lib/auth/session-proof.ts` constants. Dry run: `npm run report:b10-5 -- expired-sessions --env=preview` |
| `AiInvocation` | 90 days | `occurredAt < now − 90 d` | `userId` set to null on account purge |
| `JobRun` | 90 days | `startedAt < now − 90 d` AND status ≠ `running` | |
| `RefreshExecution` (+ `RefreshEndpointResult`, `ProviderCall`, `RefreshEndpointAccountCoverage` by cascade) | 60 days | `startedAt < now − 60 d` | |
| `ProviderCall` | 60 days | `startedAt < now − 60 d` | |
| `PlaidWebhookEvent` | 30 days | `receivedAt < now − 30 d` | |
| `SyncIssue` (+ `SyncIssueOccurrence` by cascade) | 90 days after resolution | `resolved` AND `resolvedAt` (or `updatedAt` on legacy rows) `< now − 90 d` | Open issues are kept at any age |
| `ApiUsageCounter` | 90 days | `day < now − 90 d` | |
| `BetaAccessRequest` | 180 days | DENIED (`decidedAt`), PENDING (`createdAt`), APPROVED with invite expired (`inviteExpiresAt`) older than 180 d | REDEEMED kept until account deletion, which deletes it by e-mail |
| `BetaAccessRequestEvent` | 180 days | `receivedAt < now − 180 d` | Also deleted on account purge |
| `DailyBrief` | 90 days | `briefDay < now − 90 d` | |
| `PlatformAiConversation` + `PlatformAiMessage` (B11, Platform AI conversations) | **90 days per message from creation (OD-7).** Owner ruling 2026-11-04. Conversation activity never extends it. **Not active:** the rule ships **disabled** (`PLATFORM_AI_PURGE_ENABLED` unset everywhere). No conversation is stored anywhere until the design §13 enable checklist (S2) is complete. | Each message once its database-written `purgeAfter` (`createdAt` + 90 d) has passed. A conversation is removed when its final message expires (the empty-shell step, once the shell is more than 1 day old). A conversation the operator deleted: on the next run (grace 0, OD-10). Account deletion: at the account purge, by FK cascade. | **Removed from our database within about 1 day** of expiring or being deleted (the daily run). **Backups may retain it for up to M days**, where M is **pending OWNER-VERIFY (OD-9)**: the provider's backup and PITR retention, and a deletion date for encrypted manual dumps. M is not stated in any disclosure until it is verified. **Copies held by the AI provider are governed by its terms.** We do not control them, and nothing here claims they are deleted. fm_system has no access to these tables: the rule calls the `SECURITY DEFINER` function `fm_purge_platform_ai_conversations` (counts in, counts out), batch-bounded. Every scheduled run leaves its counts in the `purge-trash` JobRun summary (zero included). Platform Ops raises **`platform-ai-purge-late`** (critical) if no successful purge has run in more than 36 h while conversations are on. Preview runs no crons: `npm run ops:platform-ai-conversations-purge -- --env=preview` at least daily while enabled there, which writes a counts-only audit row on every run. An environment that runs crons also has an **on-demand trigger**, `GET /api/jobs/dispatch?only=platform-ai-purge` (CRON_SECRET bearer): implemented, **off by default**, on only when `PLATFORM_AI_PURGE_ENABLED` and `PLATFORM_AI_PURGE_ON_DEMAND_ENABLED` are both `"true"`; Production enablement is an owner decision. Each call is its own `platform-ai-purge-on-demand` JobRun plus a counts-only audit row (`trigger: "ON_DEMAND"`), and a successful one counts as a purge run for `platform-ai-purge-late`. **Disable order (S2):** unset `PLATFORM_AI_CONVERSATIONS_ENABLED` first, purge what remains, check with `npm run report:platform-ai-conversations-precheck -- --env=<env> --phase=pre-disable`, and only then unset `PLATFORM_AI_PURGE_ENABLED`. The job fails its run while the purge is off and the conversations flag is set. A restore must run the purge before the app or flags are enabled (`backup-restore-verification.md` §4.1). Design: `docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md` §7. |
| Unchanged | — | — | `AuditLog` security rows (forensic); product events (13 months, existing job); `Notification` (existing cleanup); `RateLimit` (24 h sweep) |

Runs daily at 07:30 UTC as the `purge-trash` job.

## Not automatic (owner decision pending)

Trashed Spaces and accounts are restorable and are **not** hard-purged on a timer. A purge window and customer notice are an owner decision.

## Network identifiers (IP address, user agent) — OWNER DECISION

**Status: engineering half shipped, policy not decided.** The registry, the minimisation functions and a dry-run census exist. Nothing is minimised beyond what already ran before this change (beta-intake rows at 90 days). The window, the method and enabling it are an **OWNER DECISION**. A wider `AuditLog` minimisation also needs the DB-010 policy extension below, which needs owner and S2 review.

- **Registry:** `lib/privacy/network-identifiers.ts`. `lib/privacy/network-identifiers.census.test.ts` fails CI when a new IP or user-agent column, a new object key fed from the request IP or user agent, a new IP-keyed key builder, or a new raw `INSERT` naming `ipAddress` / `userAgent` is not registered. It also fails when this table drops a registered field.
- **Functions:** `lib/privacy/network-minimise.ts`. Pure, and nothing calls them on a write path yet.
- **Job:** `jobs/network-identifier-minimisation.ts`, behind `NETWORK_ID_MINIMISATION_MODE`, which defaults to `off`. It is not registered in `lib/jobs/registry.ts`, and no cron names it.

### Inventory (2026-11-04)

| Field | Kind | Rows | Retention today | Methods that apply | Real run blocked by |
|---|---|---|---|---|---|
| `AuditLog.ipAddress` | IP | Every audit row written with request metadata: login, failed login, 2FA, session and operator actions, `BETA_ACCESS_REQUESTED`. Product events write NULL. | **Indefinite.** `BETA_ACCESS_REQUESTED` rows are nulled at 90 days, with a keyed digest kept in metadata. Product events are deleted at 13 months. | DIGEST, TRUNCATE | DB-010 |
| `AuditLog.userAgent` | UA | As above. | As above. Beta-intake rows keep `uaFamily`. | UA_FAMILY, NULL | DB-010 |
| `AuditLog.metadata.key` | IP_KEY | `SECURITY_ANOMALY_DETECTED` rows of type `failed_login_ip`: `ip:<address>` in raw form. The row also carries the salted `keyHash`. | **Indefinite.** | DIGEST, TRUNCATE (or replace with the existing `keyHash`) | DB-010 |
| `UserSession.ipAddress` | IP | Every session, set at sign-in. | While the session is live, then 30 days after it ends: 30 days after it is revoked, or 30 days after it expires (idle or absolute lifetime), whichever comes first. | DIGEST, TRUNCATE | owner decision |
| `UserSession.userAgent` | UA | As above. | As above. | UA_FAMILY, NULL | owner decision |
| `RateLimit.key` | IP_KEY | IP-keyed limiter buckets: `ip:<limiter>:<address>`. | 24 hours (`sweep-rate-limits`). | DIGEST, TRUNCATE | owner decision |

The following fields hold no IP or user agent: the comms ledger and provider events, notifications (the staff bell carries the salted hash), `BetaAccessRequestEvent.source`, and the sealed `BetaAbuseEvidence` payload. The `x-forwarded-for` chain and the IP sent for CAPTCHA verification are never stored. The census test pins the first of these.

**Readers that show the raw value today** (they would show the minimised form after a run): the admin audit page and API, the user's security history and session list, the admin security sessions view, the System Admin "last login IP", the data export, and the beta-risk network signal. Since #377 the beta-risk signal groups by the beta-intake keyed digest (`networkDigest`, HMAC under `BETA_INTAKE_HASH_KEY_<V>`, as `<version>:<hex>`): computed at read time from raw rows, taken as stored from minimised rows, so a raw and a minimised row of one address group together. With no usable key there is no network grouping at all (never an unkeyed hash).

**Key rotation and beta-risk grouping.** When `BETA_INTAKE_HASH_KEY_VERSION` moves to a new version, digests already stored under the old version stop grouping with new reads: the reader uses a stored digest only when its `networkDigestKeyVersion` equals the current key's version, and otherwise drops it. This is deliberate. It refuses rather than mis-groups: an old-version digest can never equal a new-version one, and the old version's "no address" sentinel digests can no longer be recognised. Rows still holding a raw IP are re-digested under the new key and keep grouping. After a rotation, expect the shared-network signal to stop covering submissions older than the 90-day raw window (already minimised under the old version) until they age out of the 180-day look-back.

### Methods

- **IP DIGEST:** a keyed HMAC-SHA256 that reuses the beta-intake key material (`BETA_INTAKE_HASH_KEY_<V>`, resolved by `resolveNetworkDigestKey` in `jobs/data-retention.ts`). No new secret is added. The method has its own versioned label, `fm:network-id-min:v1`: the HMAC key is HMAC(intake key, label), so a digest here never equals a beta-intake `networkDigest`. Bumping the label rotates every digest. The stored form is `nim1-<keyVersion>:<32 hex>`. With no usable key, the result is null, never an unkeyed hash. This method keeps the ability to tell that two rows came from the same address, within one key version, without keeping the address.
- **IP TRUNCATE:** IPv4 to /24 and IPv6 to /48, stored with the prefix length (`192.0.2.0/24`, `2001:db8:1::/48`). This keeps the network but not the host. It needs no key.
- In both methods, an IPv4-mapped IPv6 address is the IPv4 address. Invalid input, `unknown` and empty values become null, and the raw value is never echoed.
- **UA_FAMILY:** the browser and OS families without versions, from `lib/ua-parser` (for example `Chrome on macOS` or `Unknown device`). **NULL** drops the user agent.

### Setting

`NETWORK_ID_MINIMISATION_MODE`, read from the environment when the job runs. Unset, empty or any unrecognised value means `off`.

| Value | Behaviour |
|---|---|
| `off` (default) | Returns at once. No database call. |
| `dry_run` | Read-only census. For each registered field, it counts the rows that still hold a raw value, in four age bands: under 30 days, 30–90 days, 90–180 days, and over 180 days. |
| `apply` | In this build, every field is refused and nothing is written. The read-only counts are still reported. `AuditLog` fields return "requires the DB-010 policy extension (owner + S2 review)". `UserSession` and `RateLimit` return the owner-decision refusal. |

### DB-010 interaction: proposed policy extension (NOT a migration)

DB-010 (`20261103140000_db010_auditlog_append_only`) lets `fm_system` UPDATE only `ipAddress`, `userAgent` and `metadata` (a column grant), and only on `BETA_ACCESS_REQUESTED` rows older than 90 days whose post-image is NULL / NULL (`fm_system_minimise`). A wider minimisation is impossible under that policy, which is what DB-010 is for.

The design is **additive**. `fm_system_minimise` and the drift pin in `jobs/auditlog-append-only-policy.test.ts` stay as they are. A second permissive UPDATE policy admits aged rows that still hold a raw value, and its `WITH CHECK` admits only a minimised post-image. Permissive policies combine with OR, so the existing beta-intake path is unaffected. A row-level trigger closes the gap that RLS cannot close, because a `WITH CHECK` cannot see the old row: on these rows the runtime may change only the network-identifier metadata keys. The column grant already confines writes to the three columns.

`<W>` is the owner's window in days (S2 proposes 90).

```sql
-- PROPOSED — NOT A MIGRATION. Needs: owner decision (window <W>, method) + S2 review.
-- Follow-up migration would also pin <W> to a code constant in
-- jobs/auditlog-append-only-policy.test.ts (as DB-010 pins its 90 days).
BEGIN;

-- 1. A second permissive UPDATE policy for the network-identifier arm.
CREATE POLICY fm_system_minimise_network ON public."AuditLog" FOR UPDATE TO fm_system
  USING (
    "createdAt" < (now() AT TIME ZONE 'UTC') - interval '<W> days'
    AND (
      "ipAddress" IS NOT NULL
      OR "userAgent" IS NOT NULL
      OR (action = 'SECURITY_ANOMALY_DETECTED' AND metadata->>'key' LIKE 'ip:%')
    )
  )
  WITH CHECK (
    -- No raw IP survives: NULL, a nim digest, or a /24 or /48 truncation.
    (     "ipAddress" IS NULL
       OR "ipAddress" ~ '^nim[0-9]+-v[1-9][0-9]{0,2}:[0-9a-f]{32}$'
       OR "ipAddress" ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.0/24$'
       OR "ipAddress" ~ '^[0-9a-f:]+/48$' )
    -- No raw UA survives: NULL or a family label (raw UAs always carry "/", ";" or "(").
    AND ( "userAgent" IS NULL OR ("userAgent" !~ '[/;()]' AND length("userAgent") <= 64) )
    -- No raw anomaly IP key survives: minimised, or the existing salted keyHash form.
    AND (    metadata->>'key' IS NULL
          OR metadata->>'key' NOT LIKE 'ip:%'
          OR metadata->>'key' ~ '^ip:(nim[0-9]+-v[1-9][0-9]{0,2}:[0-9a-f]{32}|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.0/24|[0-9a-f:]+/48|h[0-9a-f]{32})$' )
  );

-- 2. On a runtime UPDATE, metadata may change ONLY in the network-identifier keys.
CREATE FUNCTION public.fm_auditlog_minimise_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['key', 'uaFamily', 'networkDigest', 'networkDigestKeyVersion', 'networkMinimisedAt'];
BEGIN
  IF current_user <> 'fm_system' THEN
    RETURN NEW;  -- the migration principal (owner break-glass) and FK SET NULL are unaffected
  END IF;
  IF jsonb_typeof(COALESCE(OLD.metadata, '{}'::jsonb)) = 'object'
     AND jsonb_typeof(COALESCE(NEW.metadata, '{}'::jsonb)) = 'object'
     AND (COALESCE(NEW.metadata, '{}'::jsonb) - allowed) IS DISTINCT FROM (COALESCE(OLD.metadata, '{}'::jsonb) - allowed)
  THEN
    RAISE EXCEPTION 'AuditLog minimisation may change only network-identifier metadata keys'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fm_auditlog_minimise_guard
  BEFORE UPDATE ON public."AuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.fm_auditlog_minimise_guard();

COMMIT;

-- ROLLBACK (one block, migration principal):
-- BEGIN;
-- DROP TRIGGER IF EXISTS fm_auditlog_minimise_guard ON public."AuditLog";
-- DROP FUNCTION IF EXISTS public.fm_auditlog_minimise_guard();
-- DROP POLICY IF EXISTS fm_system_minimise_network ON public."AuditLog";
-- COMMIT;
```

Notes for review:

- **The trigger also binds the beta-intake job.** `minimiseAuditNetwork` adds only `uaFamily`, `networkDigest`, `networkDigestKeyVersion` and `networkMinimisedAt`, all in the allowed set. It wraps non-object metadata as `{ originalMetadata }`, and the guard skips that case because the old row is not an object. S2 should decide whether to refuse that case instead.
- **Residual risk:** on rows older than `<W>` that still hold a raw value, `fm_system` may replace the IP, the user agent and the anomaly key with any value that has a minimised shape. It cannot touch any other column or metadata key, or any fresh row.
- **`rls:accept` cases to add (57–62):**
  - updating a fresh `LOGIN` row: 0 rows;
  - an aged `LOGIN` row with the IP set to a /24: 1 row;
  - an aged row with the IP left raw: rejected by `WITH CHECK`;
  - an aged row with the UA left raw: rejected;
  - an aged row whose `metadata.reason` is changed: the trigger raises;
  - the beta-intake path: unchanged, 1 row.
- **Order of work after the owner rules:**
  1. Run `dry_run` and read the counts.
  2. Land one migration: this SQL with `<W>` filled in, plus the pin.
  3. Add the apply path to the job, removing the refusal for the decided fields.
  4. Register the job.
  5. Separately, decide what to do with expired sessions that were never revoked, by reaping them or by minimising them.

### What the owner must decide

1. **Window:** how long the raw IP and user agent are kept on `AuditLog` security rows (S2 proposes 90 days) and on `UserSession` rows, live or expired. Also whether expired sessions that were never revoked should be reaped, like revoked ones.
2. **Method:**
   - For IPs: DIGEST, which keeps same-address correlation, or TRUNCATE, which keeps the network.
   - For user agents: UA_FAMILY or NULL.
   - For the anomaly key: the same method as IPs, or replacement with the existing `keyHash`.
   - `RateLimit` already expires in 24 hours. The recommendation is no change.
3. **Enabling it:**
   - Set `NETWORK_ID_MINIMISATION_MODE=dry_run` in an environment to see the counts.
   - Approve the DB-010 extension (owner and S2) for `AuditLog`.
   - Approve a follow-up PR that adds the apply path and schedules the job.
