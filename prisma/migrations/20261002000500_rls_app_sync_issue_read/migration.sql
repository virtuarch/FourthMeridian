-- RLS-16 — THE ACTIVITY TIMELINE MAY READ A SYNC ISSUE'S SHAPE, NEVER ITS CONTENT
--
-- `GET /api/spaces/[id]/activity` renders a user-facing timeline that includes
-- "a sync problem happened on this account". SyncIssue is in the operational
-- family the first migration revoked from fm_app wholesale, so that route could
-- not be converted: as the tenant role it would have failed outright.
--
-- The lazy fixes are both wrong. Granting SELECT on the table hands the tenant
-- role a forensic ledger whose `detail` column carries other people's merchant
-- strings and amounts (§15.3). Routing the route to systemDb gives an ordinary
-- HTTP request a deployment-wide authority, which is the escape this programme
-- exists to close.
--
-- What the route actually reads is narrow and already account-scoped:
--
--     where:  { resolved: false, financialAccountId: { in: visibleAccountIds },
--               plaidTransactionId: { not: null } }
--     select: { id, kind, resolved, createdAt, plaidTransactionId }
--
-- Shape, not content. So the grant is shaped the same way.

-- ── COLUMN-LEVEL SELECT ──────────────────────────────────────────────────────
-- Postgres grants privileges per column, which turns "the route does not read
-- `detail`" from a convention into a constraint. A future edit that adds
-- `detail: true` to that select does not quietly start leaking another tenant's
-- merchant names — it fails. `detail`, `message`, `incidentKey` and the rest of
-- the forensic surface are simply not granted.
GRANT SELECT (
  "id", "kind", "resolved", "createdAt", "financialAccountId", "plaidTransactionId"
) ON TABLE public."SyncIssue" TO fm_app;

-- ── AND A TENANT POLICY ON TOP ───────────────────────────────────────────────
-- The route already filters to accounts the caller can see; this makes that a
-- database guarantee rather than a correctly-written WHERE clause. Same
-- canonical predicate as the rest of the account subtree.
--
-- ⚠️ A SyncIssue with a NULL financialAccountId is invisible to fm_app, and
-- that is correct, not a gap: those rows have no derivable tenant at all (the
-- majority of them, by measurement), and they are operator forensics. fm_system
-- keeps its existing full access to the whole table.
CREATE POLICY fm_app_sel ON public."SyncIssue" FOR SELECT TO fm_app
  USING (fm_account_visible("financialAccountId"));

-- ── WRITES ARE UNCHANGED AND STILL DENIED ────────────────────────────────────
-- No INSERT, UPDATE or DELETE for fm_app. Tenant paths that currently WRITE
-- SyncIssue — the investment-import chain — remain blocked, deliberately. That
-- is the split-authority question, and it belongs to the Plaid/refresh slice
-- where it can be answered properly, not smuggled in behind a read grant.
