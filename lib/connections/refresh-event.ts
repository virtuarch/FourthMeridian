/**
 * lib/connections/refresh-event.ts
 *
 * The window event a successful manual refresh dispatches so the Connections
 * page — whose drawer state comes from its own poll of /api/sync/status, and
 * which does not poll while every connection is ready — re-reads persisted
 * state at once (Preview finding 2026-10-28: Health kept the pre-refresh
 * "out of date" headline until a reload).
 */
export const CONNECTION_REFRESHED_EVENT = "fm:connection-refreshed";
