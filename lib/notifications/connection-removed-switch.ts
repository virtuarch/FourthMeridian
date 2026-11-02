/**
 * lib/notifications/connection-removed-switch.ts  (PB-5 — owner decision 2026-11-02)
 *
 * THE OFF SWITCH for the "A connection was removed by support" EMAIL
 * (registry type CONNECTION_REMOVED_BY_SUPPORT), modelled exactly on the
 * digest's (lib/notifications/digest.ts DIGEST_ENABLED): a CODE CONSTANT,
 * false. Turning it on is a reviewed code change, not a setting, an env var or
 * a parameter — and the constant is the same in every environment, so the
 * default can never be "on" in Production by configuration drift.
 *
 * While it is false the operator removal is still performed, audited and shown
 * in the customer's own activity; the in-app notice is still written; and the
 * EMAIL leg is recorded through the normal path — one CommsDelivery row,
 * SUPPRESSED / SHIPPED_OFF, written by the createNotification chokepoint — so
 * the email is visibly "not sent", never silently dropped.
 *
 * Pure and import-free: the registry (pure config) reads it.
 */

/** OFF. The operator-removal customer email sends nothing until the owner turns it on (PB-5). */
export const CONNECTION_REMOVED_EMAIL_ENABLED = false as boolean;
