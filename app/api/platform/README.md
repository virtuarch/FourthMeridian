# `app/api/platform/[area]/…` — platform data routes

The data routes behind the four operator Platform Spaces. Each `[area]`
directory maps to one `PlatformArea` (`lib/platform/policy.ts`), and the
widgets that read it are composed in `lib/platform/workspaces.ts`.

Shape as of 2026-10-22 (66 route files; `find app/api/platform -name route.ts`):

| Area | Directory | Routes | Owns |
|---|---|---|---|
| Platform Operations | `platform-ops/` | 38 | jobs, refresh ledger, providers, policies, alerts, AI economics, connections |
| Growth & Revenue | `growth-revenue/` | 16 | beta access requests + invitations, registration mode, product status, sign-ups, product analytics, policy-group catalogue, users |
| Customer Success | `customer-success/` | 7 | customer roll-up, per-customer policy / cohort / refresh, sync-issue triage |
| Security Operations | `security-ops/` | 5 | operator audit feed, sessions, security posture |

(Merchant Operations lives beside this tree at `app/api/merchant-ops/`.)

**Every route here MUST** be gated with `requirePlatformAccess(area, "READ")`
(or `requireFreshPlatformAccess(area, "WRITE" | "CONTROL")` for a mutation)
from `lib/platform/authorize.ts`, and MUST NOT route through customer
assemblers / spaceId-scoped adapters (07-07 risk #3 — stop condition §9.7).
These files are source-scanned by `lib/platform-surface.test.ts` for
customer-axis tokens, and mutations are expected to record through the
operator-action envelope (`recordOperatorAction`, `lib/audit.ts`).

History: PO1.0 (2026-07) established the directory as a convention with no
routes; PO1.1–PO1.4 and the OPS/GROWTH/CS slices since filled it in.
