# 20261110120000_platform_ai_operational_memory — review notes

**B11 batch — not part of B10. Preview only.** Production is a separate owner decision. It follows
`20261108120000_platform_ai_retention_7_days` (memory waits on 7-day transcript retention, design D1)
and `20261108140000_mortgage_f9_property_value_basis`.

> **The migration must not be applied to Preview until S2 has line-reviewed this SQL.**

**Design (authority).** Platform AI operational memory v2 (S2-approved 2026-11-08, conditional),
open item **O1 ruled (b)**: the soft delete is one narrow SECURITY DEFINER function and the sole
soft-delete path; fm_app holds no UPDATE on `"deletedAt"`.

**Flags.** Both ship OFF: `PLATFORM_AI_MEMORY_ENABLED` and `PLATFORM_AI_MEMORY_PURGE_ENABLED`. Memory is
effective only when conversations are on, the memory purge is on, and the 7-day retention is verified
by `npm run report:platform-ai-memory-precheck -- --env=preview`.

**Statements.**

0. `SET LOCAL lock_timeout = '5s'`, then a `DO` block refuses a migration principal without
   `BYPASSRLS` (it owns the three definer functions; under FORCE RLS a non-bypassing owner would match
   0 rows silently).
1. Five enums, the table `PlatformAiMemoryFact` (no link to a conversation, message or
   AiInvocation), the Prisma indexes, the FK `User → fact` (CASCADE: account deletion).
2. ENABLE + FORCE RLS. fm_app: SELECT; column-level INSERT that excludes every timestamp and lifecycle
   column; UPDATE on `invalidatedAt`, `invalidReason` only; explicit `REVOKE UPDATE ("deletedAt")`;
   no DELETE. Policies `fm_app_sel` / `fm_app_ins` / `fm_app_upd` = owner AND an ACTIVE PlatformGrant
   for the row's area (SELECT and UPDATE USING also: not deleted, not expired). `fm_app_upd` has its own
   WITH CHECK without the deletedAt / expiresAt term (B1). No grant or policy for fm_system, fm_auth or
   the PostgREST roles.
3. CHECKs: payload an object ≤ 512 octets; `noteEncrypted` ≤ 512; `sourceRefs` an array of 0..5, ≤ 1024
   octets; at least one ref unless OPERATOR_PREFERENCE; `expiresAt ≤ createdAt + 30 days`, and
   `≤ createdAt + 72 hours` for OPERATIONAL_STATE; invalidatedAt ⇔ invalidReason.
4. Triggers (both SECURITY INVOKER):
   - `fm_platform_ai_memory_insert` (BEFORE INSERT): `createdAt = observedAt = now()` UTC,
     `expiresAt = createdAt + least(ttl, cap)`, the lifecycle columns forced NULL, the payload key/value
     allowlist (any key containing conversation / message / transcript refused), and the **B2**
     `sourceRefs` validation: keys ⊆ {t, id, part, w, observedState} (t, id, observedState required
     strings), `t` in the ref-type enum, `id` ≤ 64 characters and matching its type (INCIDENT cuid;
     METRIC / PAGE / JOB / PROVIDER from literal registries), `part` / `w` on METRIC refs only and from
     the registry enums, `observedState` in the closed state list. Anything else RAISEs.
   - `fm_platform_ai_memory_immutable` (BEFORE UPDATE): only `invalidatedAt` / `invalidReason` /
     `deletedAt` change, each once, NULL → now(); `expiresAt` never moves. One exception, as in the
     conversations settle trigger: the key rotation's `noteEncrypted`-only update by a role that bypasses
     RLS.
5. `fm_platform_ai_memory_soft_delete(p_id text)` — SECURITY DEFINER, `search_path = pg_catalog,
   public`, schema-qualified. Caller = `current_fm_user_id()`, RAISE when NULL / empty. Only
   `UPDATE … SET "deletedAt" = now()` WHERE owner AND not deleted AND not expired AND ACTIVE grant
   [AND id = p_id; NULL = every caller row]. Returns the integer count only. EXECUTE to fm_app alone.
6. `fm_purge_platform_ai_memory(p_limit)` (≤ 500, SKIP LOCKED) and
   `fm_purge_platform_ai_memory_for_operator(p_user)` — SECURITY DEFINER, counts only, EXECUTE to
   fm_system alone. A row goes when expired, soft-deleted, invalidated more than 1 day ago, or without
   an ACTIVE grant for its (operator, area).
7. `REVOKE ALL … FROM PUBLIC` (and the API roles) on all five functions.

**SECURITY DEFINER inventory (added).** `fm_platform_ai_memory_soft_delete(text)` (fm_app),
`fm_purge_platform_ai_memory(integer)` (fm_system), `fm_purge_platform_ai_memory_for_operator(text)`
(fm_system). Checked by the pre-enable check
(`scripts/lib/platform-ai-memory-precheck.core.ts`): definer, search_path, owner bypasses RLS, EXECUTE
holders exactly as above, no PUBLIC / API EXECUTE.

**Constants duplicated from code.** Pinned by `lib/platform/intelligence/ai/memory/migration-policy.test.ts`
to `memory/constants.ts`; the registries are pinned to the live metric / navigation registries, the
retrieval parts, the job facts and `PROVIDER_SPECS` (provider health) by `memory/memory.test.ts`. Adding a key memory may
reference needs a migration.

**Proof.** `npm run rls:accept:ai-memory` (real PG roles, own throwaway container), including every
O1 case S2 listed: own → 1 then invisible; another operator → 0; revoked area → 0; already deleted /
expired → 0; NULL GUC → exception; PUBLIC and fm_system cannot EXECUTE; a direct fm_app UPDATE of
`deletedAt` → permission denied; delete-all touches only the caller's rows in held areas; invalidation
still works for fm_app.

**Apply.** Preview only, by S1 through `npm run db:migrate:safe`, **after S2's line review of this
SQL**. Never `prisma migrate dev`. Then `npm run report:platform-ai-memory-precheck -- --env=preview`
before any memory flag is set.

**B9 / B10 compatibility.** Neither release reads, writes or knows this table. Code rollback needs no
database step.

## ROLLBACK (Preview only — DESTROYS every memory fact)

Run as the migration principal, in one transaction, never as part of a code rollback. Turn
`PLATFORM_AI_MEMORY_ENABLED` off first.

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.fm_purge_platform_ai_memory_for_operator(text);
DROP FUNCTION IF EXISTS public.fm_purge_platform_ai_memory(integer);
DROP FUNCTION IF EXISTS public.fm_platform_ai_memory_soft_delete(text);
DROP TABLE IF EXISTS public."PlatformAiMemoryFact";
DROP FUNCTION IF EXISTS public.fm_platform_ai_memory_immutable();
DROP FUNCTION IF EXISTS public.fm_platform_ai_memory_insert();
DROP TYPE IF EXISTS "PlatformAiMemoryInvalidReason";
DROP TYPE IF EXISTS "PlatformAiMemoryTtl";
DROP TYPE IF EXISTS "PlatformAiMemoryConcern";
DROP TYPE IF EXISTS "PlatformAiMemoryOrigin";
DROP TYPE IF EXISTS "PlatformAiMemoryFactType";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110120000_platform_ai_operational_memory';
COMMIT;
```
