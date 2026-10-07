-- OPERATIONALIZATION P0 — the operational FACTS a beta cannot reconstruct later.
--
-- Three additive changes, no backfill, no data rewrite, compatible with the
-- running application (the old client never selects an unknown column; the
-- two new tables have no reader until this slice's code):
--
--   1. AiInvocation gains ATTRIBUTION (userId, spaceId, conversationId,
--      subSurface, providerRequestId) and an OUTCOME (outcome, errorCode) so a
--      failed, timed-out, rate-limited or quota-refused provider call is a FACT
--      with zero tokens instead of a console line. The owner ruled on
--      2026-10-07 that per-user/per-Space AI cost attribution may exist as
--      bounded operator-only telemetry; this reverses the Slice 3 recorded
--      privacy decision ("never resolvable to a person") and NOTHING ELSE: the
--      table stays revoked from fm_app (…000100 §4), written and read by
--      fm_system alone, so no tenant path exists through which Conversations
--      could reach another user's telemetry. Every existing row reads
--      outcome='RETURNED', which is exactly what the ledger held: billed,
--      returned calls only.
--
--   2. PlaidWebhookEvent — one row per VERIFIED webhook, written after the
--      signature check and before any handling decision. Operator-only
--      (fm_system), same posture as RefreshExecution.
--
--   3. BetaAccessRequestEvent — one row per public form SUBMISSION. The parent
--      table's non-enumerating INSERT … ON CONFLICT DO NOTHING and its column
--      grants are UNTOUCHED. The public intake roles get INSERT and nothing
--      else here too, so the public surface still STRUCTURALLY CANNOT READ
--      whether an address is on the waitlist; requestCount / lastRequestedAt
--      are COUNT / MAX over these rows by an operator, never stored.
--
-- Grants assume the roles created by 20261002000100_rls_roles_and_policies.

-- ── 1. AiInvocation — attribution + outcome ──────────────────────────────────
ALTER TABLE "AiInvocation" ADD COLUMN "userId" TEXT;
ALTER TABLE "AiInvocation" ADD COLUMN "spaceId" TEXT;
ALTER TABLE "AiInvocation" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "AiInvocation" ADD COLUMN "subSurface" TEXT;
ALTER TABLE "AiInvocation" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'RETURNED';
ALTER TABLE "AiInvocation" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "AiInvocation" ADD COLUMN "providerRequestId" TEXT;

CREATE INDEX "AiInvocation_userId_occurredAt_idx" ON "AiInvocation"("userId", "occurredAt");
CREATE INDEX "AiInvocation_conversationId_turnIndex_idx" ON "AiInvocation"("conversationId", "turnIndex");
CREATE INDEX "AiInvocation_outcome_occurredAt_idx" ON "AiInvocation"("outcome", "occurredAt");

-- ── 2. PlaidWebhookEvent ─────────────────────────────────────────────────────
CREATE TABLE "PlaidWebhookEvent" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalItemId" TEXT,
    "plaidItemId" TEXT,
    "webhookType" TEXT NOT NULL,
    "webhookCode" TEXT NOT NULL,
    "errorCode" TEXT,
    "itemStatusAtReceipt" TEXT,
    "ownerInactive" BOOLEAN,
    "handling" TEXT NOT NULL,
    "environment" TEXT NOT NULL,

    CONSTRAINT "PlaidWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlaidWebhookEvent_receivedAt_idx" ON "PlaidWebhookEvent"("receivedAt");
CREATE INDEX "PlaidWebhookEvent_externalItemId_receivedAt_idx" ON "PlaidWebhookEvent"("externalItemId", "receivedAt");
CREATE INDEX "PlaidWebhookEvent_handling_receivedAt_idx" ON "PlaidWebhookEvent"("handling", "receivedAt");

-- Operator-only ledger: the …000100 §4 posture, verbatim.
REVOKE ALL ON TABLE public."PlaidWebhookEvent" FROM fm_app;
REVOKE ALL ON TABLE public."PlaidWebhookEvent" FROM fm_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."PlaidWebhookEvent" TO fm_system;
GRANT SELECT ON TABLE public."PlaidWebhookEvent" TO fm_backup;
ALTER TABLE public."PlaidWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlaidWebhookEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."PlaidWebhookEvent" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- ── 3. BetaAccessRequestEvent ────────────────────────────────────────────────
CREATE TABLE "BetaAccessRequestEvent" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" JSONB,

    CONSTRAINT "BetaAccessRequestEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BetaAccessRequestEvent_email_receivedAt_idx" ON "BetaAccessRequestEvent"("email", "receivedAt");
CREATE INDEX "BetaAccessRequestEvent_receivedAt_idx" ON "BetaAccessRequestEvent"("receivedAt");

-- The public intake roles may INSERT a submission and may not read, count or
-- filter one — the same shape as the parent's intake grant (…000600). There is
-- no verdict column here to bound, so the policy is a plain INSERT permit.
REVOKE ALL ON TABLE public."BetaAccessRequestEvent" FROM fm_app;
REVOKE ALL ON TABLE public."BetaAccessRequestEvent" FROM fm_auth;
GRANT INSERT ON TABLE public."BetaAccessRequestEvent" TO fm_app, fm_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."BetaAccessRequestEvent" TO fm_system;
GRANT SELECT ON TABLE public."BetaAccessRequestEvent" TO fm_backup;
ALTER TABLE public."BetaAccessRequestEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BetaAccessRequestEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_app_insert  ON public."BetaAccessRequestEvent" FOR INSERT TO fm_app  WITH CHECK (true);
CREATE POLICY fm_auth_insert ON public."BetaAccessRequestEvent" FOR INSERT TO fm_auth WITH CHECK (true);
CREATE POLICY fm_system_all  ON public."BetaAccessRequestEvent" FOR ALL    TO fm_system USING (true) WITH CHECK (true);
