# `app/api/platform/[area]/…` — platform data routes (PO1.1+)

PO1.0 establishes this directory **convention only** — there are no routes here
yet. Platform data read routes land in later slices, one area at a time:

- **PO1.1** Security Operations — `app/api/platform/security-ops/*` reads wrapping
  the same queries as `admin/audit` / `admin/security/*`.
- **PO1.2** Platform Operations — job health over `checkScheduledJobHealth()`,
  rate-limit status over `RateLimit`, env report over a `validateEnv()` refactor.
- **PO1.3** Growth & Revenue — signups/activation from `User`/`UserSession`.
- **PO1.4** Customer Success — sync-issue triage over `SyncIssue`.

**Every route added here MUST** be gated with
`requirePlatformAccess(area, "READ")` (or `requireFreshPlatformAccess` for any
future WRITE mutation) from `lib/platform/authorize.ts`, and MUST NOT route
through customer assemblers / `buildContext` / spaceId-scoped adapters
(07-07 risk #3 — stop condition §9.7). These files are source-scanned by
`lib/platform-surface.test.ts` for customer-axis tokens.
