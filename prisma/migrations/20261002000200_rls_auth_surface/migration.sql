-- RLS-6 — THE PRE-IDENTITY SURFACE, MEASURED FROM THE CODE THAT NEEDS IT
--
-- fm_auth exists for one reason: authentication has to read the database BEFORE
-- there is an identity for a policy to key on. NextAuth's authorize() looks a
-- user up by email; the session callback re-checks revocation; neither can
-- supply app.user_id, because establishing it is the thing they are doing.
--
-- The danger is not that fm_auth exists. It is that "the role the auth path
-- uses" quietly becomes "the role you reach for when tenancy is inconvenient".
-- So its grants are derived from an actual read of every pre-identity query in
-- lib/auth.ts, lib/session.ts and lib/recovery-codes.ts, and they stop there.
--
-- Measured surface:
--   User            lib/auth.ts:219 findFirst (credential lookup)
--                   lib/auth.ts:420,458 update  (reactivation / cancellation)
--   UserSession     lib/auth.ts:493 create · :604,:664 updateMany
--                   lib/auth.ts:587, lib/session.ts:160 findFirst (revocation)
--   RecoveryCode    lib/recovery-codes.ts:52 deleteMany · :56 createMany
--                   :82 findMany · :90 update · :107 count
--   AuditLog        lib/auth.ts:85,424,462,501,669 create — INSERT ONLY
--   PlatformSetting lib/auth.ts:347 findUnique (REQUIRE_TOTP_ALL_USERS) — SELECT ONLY
--
-- Everything else is absent on purpose, and the absence is asserted: the
-- acceptance suite proves fm_auth cannot read Transaction, PositionObservation,
-- PlaidItem, SpaceMemory, DailyBrief or FinancialAccount. A credential that
-- cannot reach money is a much smaller problem when it leaks.

-- AuditLog — INSERT only. The auth path records logins, lockouts and
-- reactivations; it has no business READING the forensic log, and a role that
-- can write but not read is exactly right for an append-only audit trail.
GRANT INSERT ON TABLE public."AuditLog" TO fm_auth;
CREATE POLICY fm_auth_ins ON public."AuditLog" FOR INSERT TO fm_auth WITH CHECK (true);

-- PlatformSetting — SELECT only. One flag (REQUIRE_TOTP_ALL_USERS) decides
-- whether enrolment is mandatory, and it is read during login.
GRANT SELECT ON TABLE public."PlatformSetting" TO fm_auth;
CREATE POLICY fm_auth_sel ON public."PlatformSetting" FOR SELECT TO fm_auth USING (true);

-- RecoveryCode — the existing grant was SELECT, UPDATE, which is enough to
-- CONSUME a code but not to regenerate the set. Regeneration deletes the old
-- codes and inserts new ones in one transaction (lib/recovery-codes.ts:50).
GRANT INSERT, DELETE ON TABLE public."RecoveryCode" TO fm_auth;

-- RateLimit — the login limiter, and the reason this grant is not optional.
--
-- lib/auth.ts:179 peeks the bucket and :188 performs the authoritative
-- increment, both BEFORE the credential is checked. Crucially the limiter
-- FAILS CLOSED (lib/auth.ts:189-192 returns AUTH_UNAVAILABLE on any limiter
-- error), so a missing privilege here is not a degraded rate limit — it is
-- every login attempt in the deployment failing. This is exactly the kind of
-- grant that gets discovered in production at 3am, which is why it is derived
-- from reading the code rather than from imagining the surface.
--
-- Safe to grant: RateLimit carries no tenant data. Its subject lives inside an
-- opaque text key ("user:ai-chat:<id>"), there is nothing to write a policy
-- against, and it is already a recorded non-tenant exception for fm_app.
GRANT SELECT, INSERT, UPDATE ON TABLE public."RateLimit" TO fm_auth;
