/**
 * lib/monitoring/deployment.ts  (OPS-2B′ — Deployment Identity Authority)
 *
 * THE single resolver of "which deployment is this process running?".
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
 * The identity already existed at runtime, but it was resolved in two places
 * with two different shapes: `lib/monitoring/sentry-options.ts` used the FULL
 * sha as the Sentry `release`, and `app/api/health/route.ts` sliced it to 7
 * chars for its uptime payload. Stamping operational facts from a third
 * independent read would have made drift inevitable — and drift here is
 * expensive in a specific way: if the stamped value and the Sentry `release`
 * ever diverge, correlating a Sentry incident to the refresh execution that
 * produced it silently stops working. So there is now ONE resolver, and Sentry
 * consumes it (OPERATIONAL_TRUTH_SPINE.md §D.1 — one chokepoint per fact).
 *
 * ── WHY THE GIT SHA, AND NOT A DEPLOYMENT INSTANCE ID ─────────────────────────
 * The sha identifies the CODE that produced a fact, which is what every question
 * this authority exists to answer actually turns on ("did failures begin after
 * X shipped?"). It is also the value Sentry already groups by, so one identifier
 * serves both systems instead of two. The honest limitation, stated rather than
 * hidden: a sha is NOT unique per deployment — the same commit redeployed, or
 * promoted from preview to production, yields the same sha. If instance-grain
 * ever becomes a real question, that is an ADDITIVE second column, not a
 * rewrite of this one. It is not a question anything asks today.
 *
 * ── CLIENT-SAFE ───────────────────────────────────────────────────────────────
 * No `server-only`, no node APIs, no secrets — `sentry-options.ts` is bundled
 * into the browser and imports this. Both the `NEXT_PUBLIC_` and bare variants
 * are read, in that order, so the value is identical on client and server.
 *
 * ── NOT AN INFRASTRUCTURE PROVIDER ────────────────────────────────────────────
 * This is deliberately NOT the provider-neutral metric contract sketched in
 * OPERATIONAL_TRUTH_SPINE.md §I. There is nothing to generalize: a process reads
 * its own build's identity from its own environment — there is no second
 * "provider" of that, so per ADR-006 no abstraction is introduced here.
 */

/**
 * The deployment the current process is running, or `null` when unknown.
 *
 * `null` is a first-class, permanent answer — local `next dev`, a self-hosted
 * run, or any environment that does not set the variable. It is never inferred,
 * never defaulted to "unknown"/"local"/HEAD, and never backfilled later.
 */
export function currentDeploymentSha(): string | null {
  const sha =
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    null;

  // An empty/whitespace value is absence, not identity — treat it as unknown
  // rather than stamping "" onto an immutable fact forever.
  if (sha == null) return null;
  const trimmed = sha.trim();
  return trimmed.length > 0 ? trimmed : null;
}
