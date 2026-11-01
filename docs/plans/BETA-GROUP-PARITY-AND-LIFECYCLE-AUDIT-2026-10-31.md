# Beta Group — Environment Parity and Lifecycle Audit (2026-10-31)

Owner directives: *Beta Group Lifecycle and Cost Controls* and *Beta Group Environment Parity*.
Status: **read-only.**
- **Preview:** inspected read-only in its database.
- **Production:** inspected through the code on `main` (4dda8dc) only. No Production database credentials are available to this session, so §2's Production column states what the code implies, **not observed database state**.

## 1. Answers (verified evidence)

| # | Question | Answer |
|---|---|---|
| 1 | Built-in or default? | **Yes, both.** Key `BETA_FULL_ACCESS_V1`. It is `DEFAULT_POLICY_GROUP` in code (`lib/entitlements/catalogue.ts`). On `develop` the database row carries `isDefault=true` and `builtIn=true`. |
| 2 | Model storing the definition | `PolicyGroup` (definition and pointers) plus `PolicyGroupVersion` (immutable values JSON), from migration `20261030120000_policy_group_editor`, which exists on `develop` only. **Fallback:** the code catalogue (`POLICY_GROUPS`, `CODE_CATALOGUE`). |
| 3 | Memberships | `CustomerPolicyAssignment` (one row per user: `policyGroup` key, `overlay`, AI allowance override). `CustomerCohort` (for example `CLOSED_BETA_2026`) is append-only rollout history and grants nothing. |
| 4 | Capabilities and assignments | Dimensions and ceilings: **code only** (`ENTITLEMENT_DIMENSIONS`). Values: `PolicyGroupVersion.values` in the database, with the code as fallback. Overlays: code only (`FOUNDER_INTERNAL_V1`). Assignments: `CustomerPolicyAssignment`. |
| 5 | How Beta is created | **Migration seed** (`ON CONFLICT DO NOTHING`), pinned to the code values by `policy-group-migration.test.ts`. There is no bootstrap routine. Operators can create *other* groups. New registrants get the default group in the registration transaction. Older accounts need the manual `reconcile-beta` action. |
| 6 | Does Production contain the Beta group? | **As a code definition: yes.** `main` has `lib/entitlements/catalogue.ts` with `BETA_FULL_ACCESS_V1` and `DEFAULT_POLICY_GROUP`, and registration assigns it. **As a database row: no.** `main` lacks the editor migration and the database catalogue loader, so Production runs on the code catalogue. Whether the `PolicyGroup` table physically exists in the Production database is **unverified**, though its migration is not on `main`. Whether migration `20261008000000_p1_customer_policy_cohort` (on `main`) is applied, and how many Production users lack an assignment, are **unverified**: run the §4 query. |
| 7 | Does Preview contain it? | **Yes.** `PolicyGroup` `BETA_FULL_ACCESS_V1` with isDefault, builtIn, not archived, `currentVersion` 3. Versions 1–3 have identical values (md5 `07114bec…`; v2 and v3 were the TESTING round trip on 2026-10-30). There are 8 assignments (1 with overlay `FOUNDER_INTERNAL_V1`), and cohort `CLOSED_BETA_2026` has 3 rows (2 INVITE, 1 OPERATOR). Both migrations are applied. |
| 8 | Same stable key? | **Yes:** `BETA_FULL_ACCESS_V1` in both. |
| 9 | Equivalent capabilities? | **Preview database = `develop` code values** (pinned by test). Production code (`main`) has the **older** catalogue: compare `git diff origin/main origin/develop -- lib/entitlements/catalogue.ts` before promotion. |
| 10 | Policy in code rather than database? | Dimensions, ceilings, fail-closed values, overlays, cohorts and the fallback catalogue are all code. Only group values, the default designation and archive state are in the database. |

## 2. Parity strategy (proposed; Production repair needs owner approval)

1. **Canonical identity.** Built-in groups are a code list (`CODE_CATALOGUE`), keyed by a stable key, with a declared `seedVersion`.
2. **Deterministic, idempotent initialisation.** The migration seed (already `ON CONFLICT DO NOTHING`) stays the only creator.
   - A **read-only parity report** compares, for each built-in key: present/missing, `builtIn`/`isDefault`, `currentVersion`, a values hash against the code seed, and archived state.
   - It classifies each difference as **intended override** (operator-edited: a version above 1 with an audit row) or **drift** (missing, wrong flags, or values differing from every recorded version).
3. **Never overwrite operator-edited values.** Repair is limited to creating a *missing* built-in from the code seed. It is a separate, explicit, audited action and is never automatic in Production.
4. **No copying between environments.** Memberships, test data and versions are never copied.
5. **Tests to write:**
   - fresh database: the seed creates the group;
   - existing database: re-running is a no-op;
   - missing Beta: reported as drift;
   - operator-changed values: reported as an intended override;
   - environment override vs drift classification;
   - reconciliation creates the missing group only.

## 3. Lifecycle and cost freeze: what exists vs what is missing

**What exists:**
- `PolicyGroup.archivedAt`, refused while the group has members.
- Platform-wide switches: `maintenance_mode`, `ingestion_paused`, `ai_paid_requests_paused`, `ai_daily_allowance_enforced`.
- `FAIL_CLOSED_VALUES`, which already behaves as a restricted, read-only-capable mode.
- `admitOperationalWork`, a typed admission point for a new fact.

**What is missing:**
- Per-group lifecycle state (ACTIVE, PAUSED, ENDED).
- Per-group cost freeze.
- An ENDED transition target (Free or read-only).
- A Free-tier group definition: none exists.

### Enforcement coverage today (paid operations)

| Operation | Per-user entitlement check | Platform admission | Gap for lifecycle / freeze |
|---|---|---|---|
| AI chat | yes (conversations, pacing, allowance) | kill switch | none, once the evaluator is extended |
| Daily Brief generate | yes | kill switch | pacing is hard-coded |
| Plaid link-token | connection cap | — | — |
| Plaid exchange-token | **no** | yes | cap not re-checked |
| Plaid resume-sync | **no** | yes | fail-closed users keep importing |
| Plaid webhook sync | **no** | yes | not gated per user |
| Wallet add (first sync) | cap | **no** | spends while ingestion is paused |
| Wallet / manual / refresh-all | yes | yes | limiter fails open |
| Jobs `sync-banks`, `resume-stale-imports`, `sync-crypto` | **no per-user check** | partly | shared jobs need per-user gating at dispatch |
| Job `sol-history-backfill` (Alchemy, Helius, CoinGecko) | **no** | **no** | **largest bypass** |
| Price / FX jobs | not per user | no | platform-level spend; outside group scope |

## 4. Production read-only query (owner to run or authorise)

```sql
BEGIN; SET TRANSACTION READ ONLY;
SELECT migration_name, finished_at IS NOT NULL done FROM _prisma_migrations
 WHERE migration_name ~ '(customer_policy_cohort|policy_group_editor|connection_history_checkpoint)';
SELECT to_regclass('public."PolicyGroup"') policy_group_table;
SELECT "policyGroup", overlay, count(*) FROM "CustomerPolicyAssignment" GROUP BY 1,2;
SELECT count(*) unassigned_active_users FROM "User" u
 WHERE u.role='USER' AND u."deactivatedAt" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "CustomerPolicyAssignment" a WHERE a."userId"=u.id);
SELECT cohort, source, count(*) FROM "CustomerCohort" GROUP BY 1,2;
ROLLBACK;
```

## 5. Owner decisions before lifecycle implementation

1. **ENDED target.** Should the default be **Free** or **read-only**? A Free-tier group does not exist yet, so its values need defining.
2. **Scope of "Beta".** The policy group `BETA_FULL_ACCESS_V1` or the cohort `CLOSED_BETA_2026`? Today these are the same population on Preview (8 assigned, 3 in the cohort).
3. **Cost-freeze precedence.** The proposal: cost freeze beats everything, including the per-user AI override and the overlay. The ceiling remains the last clamp.
4. **Cache propagation window.** The proposal is **≤ 30 s**, the current TTL. Freeze checks bypass the stale `lastGood` path, so an unreadable policy fails closed for billable work.
5. **Workers.** Add per-user lifecycle and freeze gating to `sync-banks`, `resume-stale-imports`, `sync-crypto` and `sol-history-backfill` at dispatch and at checkpoints. Shared price and FX jobs stay ungated.
