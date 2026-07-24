-- OPS-2B′ — Deployment Identity Authority
--
-- Stamps the deployment that PRODUCED each immutable operational fact onto the
-- two authoritative execution ledgers. Additive and nullable: existing history
-- keeps NULL forever (the deployment was not observable when those rows were
-- written), and nothing is backfilled or inferred.
--
-- No `Deployment` table and no foreign key — a deployment entity would need a
-- lifecycle this system does not observe, and an FK would couple immutable
-- history to a prunable table. See prisma/schema.prisma for the full rationale.

ALTER TABLE "JobRun" ADD COLUMN "deploymentSha" TEXT;
ALTER TABLE "RefreshExecution" ADD COLUMN "deploymentSha" TEXT;

-- "which runs / refreshes belong to deployment X" — the correlation query this
-- authority exists to make answerable.
CREATE INDEX "JobRun_deploymentSha_idx" ON "JobRun"("deploymentSha");
CREATE INDEX "RefreshExecution_deploymentSha_startedAt_idx" ON "RefreshExecution"("deploymentSha", "startedAt");
