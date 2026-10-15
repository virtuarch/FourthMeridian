# 20261016000000_customer_ai_allowance_override — review notes (AI COST CONTROLS, Agent A)

**Purpose.** Record a per-customer daily AI allowance override (whole USD) on the
customer's `CustomerPolicyAssignment` row, so Customer Success can raise or lower
ONE customer's `aiDailyUsdAllowance` without a catalogue change. It is the top of
the allowance precedence (`USER_OVERRIDE > OVERLAY > PLATFORM_SETTING > POLICY`,
the catalogue ceiling clamping last — `lib/entitlements/ai-allowance.ts`), and the
ONE additive migration of the milestone.

**Statement.** `ALTER TABLE "CustomerPolicyAssignment" ADD COLUMN "aiDailyUsdAllowanceOverride" INTEGER;`

**Additivity.** One nullable column, no default, no index, no constraint, no data
change. PostgreSQL adds a nullable column without a default as a catalog-only
change; no lock beyond the brief `ACCESS EXCLUSIVE` of the DDL itself.

**Old-client compatibility.** A Prisma client generated before this migration
neither selects nor writes the column; reads and writes continue unchanged. A
client generated after it treats the column as `Int?`; the resolver's read
client types it OPTIONAL (`aiDailyUsdAllowanceOverride?: number | null`) so both
generations satisfy the same interface, and a missing value reads as "no override".
The only writer is `assignCustomerPolicy` (`lib/platform/customer/assign.ts`):
`undefined` keeps, `null` removes, an integer 1 … ceiling (20) sets; above the
ceiling is REFUSED (never clamped silently). Audited as
`CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED` with a required reason.

**Backfill.** NONE. No customer has an override until an operator sets one.

**RLS / grants.** `CustomerPolicyAssignment` policies are row predicates on
`"userId"` (migration 20261008000000 §3) and name no columns; `fm_app` holds
SELECT, `fm_auth` INSERT, `fm_system` ALL at TABLE level, so the new column is
readable by the tenant (its own row) and writable by fm_system without any
policy or grant change. `scripts/audit-db-authority.ts` and the RLS acceptance
scripts select by model, not by column list.

**Client generation.** `npx prisma generate` after applying. ⚠️ Agent A did NOT
run it in the worktree: `node_modules` there is a symlink to the main checkout's,
so generating would have replaced the main checkout's client with one that
selects a column the Dev database does not yet have (every
`customerPolicyAssignment` read there — `entitlementsForUser` on each chat/Brief
request — would fail with P2022 until the migration is applied). The code
compiles and its tests pass against the narrow interfaces without regeneration;
the coordinator applies the migration and regenerates in one step.

**Rollback.** `ALTER TABLE "CustomerPolicyAssignment" DROP COLUMN "aiDailyUsdAllowanceOverride";`
— then regenerate the client from the previous schema. Nothing else depends on
the column: the resolver treats a missing value as "no override" and the platform
setting / overlay / policy precedence is unchanged.

**Apply.** Coordinator only, Dev then Preview, with `db:migrate:safe` after review
and a backup. Never Production during this milestone.
