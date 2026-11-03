-- PB-10 — PRESENCE ≠ SESSION ≠ ACTIVITY (one additive migration)
--
-- Two nullable clocks on UserSession, written only by the visible-tab presence
-- heartbeat (POST /api/user/presence → lib/auth/presence-activity.ts) from the
-- DATABASE clock:
--   "lastPresenceAt"     a browser tab holding this session was visible and
--                        reported presence (heartbeat received)
--   "lastInteractionAt"  that beat carried "interacted since the last beat"
--                        (CLIENT-ASSERTED — low trust: presence buckets and the
--                        Customer Success "last active ~" display only)
-- "lastActiveAt" is UNCHANGED and keeps meaning "session last used"; it alone
-- feeds the SEC-010 30-day idle cut-off. The heartbeat never writes it.
--
-- HYGIENE
--   * Additive only: nothing dropped, renamed or retyped.
--   * NO BACKFILL, NO DEFAULT: both columns are NULL until a heartbeat lands
--     (readers show "Unknown"). Adding a nullable column without a default is a
--     catalog-only change — no table rewrite, no long lock.
--   * No index: readers aggregate by "userId" (existing UserSession_userId_idx).
--
-- RLS / GRANTS — nothing to change
--   * Every UserSession grant (fm_auth SELECT/INSERT/UPDATE, fm_app and
--     fm_system SELECT/INSERT/UPDATE/DELETE — 20261002000100) is TABLE-level, so
--     it covers new columns; no column-level grant exists on this table. The
--     row policies (fm_app "userId" = current_fm_user_id(); fm_auth_all;
--     fm_system_all) are row predicates and are unaffected.
--
-- RETENTION / PURGE
--   * Last value only — no history table. The values live and die with their
--     session row: the DB-009 reaper (revoked > 30 days) and the account purge
--     (UserSession → User ON DELETE CASCADE) remove them. Included in the
--     account data export (lib/export/assemble.ts).

ALTER TABLE "UserSession"
  ADD COLUMN "lastPresenceAt"    TIMESTAMP(3),
  ADD COLUMN "lastInteractionAt" TIMESTAMP(3);
