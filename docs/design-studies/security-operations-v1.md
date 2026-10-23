# Design Study — Security Operations v1

**Program:** PLATFORM-DESIGN-STUDIES-1
**Space:** SECURITY_OPS · workspace `platform-overview`
**Status:** Production design study. No production code. Grounded in `docs/plans/Platform-Spaces-Visualization-Investigation.md` (§4.2, §5.2, §7, Brief 1).
**Imagery:** `images/security-desktop.png` · `images/security-mobile.png`

---

## 1. Design goals

Recompose the five card-grain security widgets into the page-grain dominant-surface grammar that Platform Operations already ships (this is exactly the PM-2 slice the migration doc plans). Security has no findings model, no severity, no investigation state, and zero remediation capability — so the honest dominant object is **the activity record itself**, and the design's job is to present posture, activity, and detections with the platform's epistemic voice: what is observed, what is standing, and what is *not observed at all*.

All sample figures in the imagery are illustrative states of real DTO fields (`PlatformAuthPosture`, `AnomaliesResponse`, `PlatformAuditEvent`, `OperatorActionEvent`, `PlatformSessionsResponse`). No metric type appears that the routes do not serve.

## 2. Operator questions served

- Are authentication controls holding? (TOTP enrolment, forced resets, recovery-code coverage, sessions)
- What fired? (anomaly trips, with rule, key, threshold, window)
- What happened recently, by whom? (security-filtered audit feed, privileged operator actions, session activity)
- What does this Space *not* know? (stated on-surface: no score, no threat feed, no investigation state, no remediation, rate-limited attempts invisible)

## 3. Composition (Context → Posture → Dominant → Supporting → Drill)

```
PlatformAreaHero            "Is Fourth Meridian secure?"
Security posture            SectionSurface · three columns: Detections | Coverage | Notes
Security activity           SectionSurface · three groups: End-user auth · Operator actions · Sessions   ← dominant
Anomalies                   SectionSurface · trip rows with inline expansion                              ← supporting + drill
```

- **Posture / Detections:** `BigStat` pair — anomaly trips ·24h and login failures ·15m. The failures stat carries the derivation line naming the population honestly: *"all reasons — includes blocked-but-correct-password; the detector counts only credential-guess reasons."* This renders the shipped population mismatch instead of hiding it (investigation §14.11) until the route split lands.
- **Posture / Coverage:** TOTP enrolment % with proportion meter and the denominator caveat (*includes deactivated accounts*), forced resets, recovery-code holders, active sessions. No target line is drawn — no target authority exists.
- **Posture / Notes:** the absence block (no score · no threat feed · no remediation · no investigation state) with `Provenance` chips and `no authority` chips, plus the read timestamp. Absence rendered at full weight is the point of the column.
- **Dominant / Security activity:** one surface, three `GroupLabel`ed feeds, each ending with its depth statement ("Last 15 security-filtered events", "Last 20 privileged actions") and provenance chip. This consolidates `sec_audit_feed` + `sec_operator_actions` + `sec_sessions` without changing any route.
- **Supporting / Anomalies:** trip rows rendering `humanizeType · ×count`, threshold, window — **and the `key`** (`identifier:c***@…`), which the DTO already carries and the shipped widget drops. Footnote carries the coverage caveat: *four fixed rules; no detector fired ≠ nothing wrong.*

## 4. Interaction model

The Space is a pure observation deck — every concept is read-only, and the design keeps it that way. The one interaction state (shown expanded in the desktop image) is **inline row expansion** on an anomaly trip: Key · Rule · Trip recorded · Fan-out · Remediation (`— no control exists on this surface`). Expansion is chosen over a RightPanel because the trip has no deeper authority to fetch — a panel would promise depth that does not exist. No row menus, no commands, no footer buttons. Preview → Browser → Detail does not apply until a findings authority exists (Tier 3).

## 5. Authority map

| Surface element | Category |
|---|---|
| Anomaly trips ·24h, trip rows, per-trip key/threshold/window | **SHIPPED AUTHORITY** (`/api/platform/security-ops/anomalies` — key/threshold currently fetched, unrendered → the rendering itself is **PRESENTATION WORK**) |
| Login failures ·15m stat | **SHIPPED AUTHORITY**, with honest relabel; splitting detector-population vs all-reasons into two figures is **NARROW PROJECTION REQUIRED** (route amendment) |
| TOTP %, forced resets, recovery codes, sessions counts | **SHIPPED AUTHORITY** (`/auth-posture`, `/sessions`); deactivated-excluded denominator is **NARROW PROJECTION REQUIRED** |
| Consolidated activity groups (audit / operator / sessions) | **PRESENTATION WORK** over three shipped routes |
| Depth statements, provenance chips, absence notes | **PRESENTATION WORK** (copy + primitives that exist) |
| Password-reset visibility in the audit feed | **NARROW PROJECTION REQUIRED** — the filter vocabulary fix (`PASSWORD_RESET_REQUESTED/COMPLETE` in, phantom `PASSWORD_RESET` out) |
| Emergency-control (kill switch) status | **BACKEND PREREQUISITE** (env fact has no read route) — deliberately *not drawn* in v1 |
| Findings table, investigation state, severity, remediation | **INTENTIONALLY UNAVAILABLE** today at the UI level (no authority); named in the Notes column rather than drawn |
| Security score, threat feed | **INTENTIONALLY UNAVAILABLE** — named-absent on-surface |

## 6. Mobile

True composition, not a scaled desktop: posture first (Detections as a two-up stat grid, Coverage stacked with the meter, Notes collapsed into the surface footnote), then activity groups trimmed to their top rows with depth captions intact, then anomaly rows with key inline. Facts are never dropped — long derivations become footnotes. BottomNav per shell; the Platform switcher is absent below `lg` per current shell behavior (a known shell gap, out of scope here).

## 7. Implementation guidance

- **Reusable production primitives:** `SectionSurface`, `GroupLabel`, `BigStat` (first consumer outside Scheduler), `TwoLine`, `Provenance`/`NO_AUTHORITY`, `Unavailable`, `KeyRow` (row expansion), the Jobs row-expansion pattern, `WidgetMessage` states per fetch.
- **Composition:** replace the five `sec_*` sections' *composition* with three consolidated sections (posture / activity / anomalies) via `PLATFORM_AREA_WORKSPACES` + `PLATFORM_SECTION_REPRESENTATION` absorption declarations — the same consolidation mechanics PM-1 used for `ops_platform_health`. **Seed rows required** for any new section keys (R-5 hazard).
- **Fetching:** posture surface reads `/anomalies` + `/auth-posture` (+ counts from `/sessions`); activity surface reads `/audit` + `/operator-actions` + `/sessions`. Use `useSharedWidgetFetch` inside the workspace session so consolidated surfaces don't double-fetch shared routes.
- **Complexity:** low-medium. Zero schema changes; zero new routes for v1. Two view-model modules (`sec-posture-view.ts`, `sec-activity-view.ts`) with the GROWTH-1 guard idiom (no function ending in `Rate`/`Severity`; no verdict vocabulary).
- **Risks:** (1) the population-mismatch relabel must not read as an accusation of the detector — copy reviewed against `anomalies.ts` semantics; (2) consolidation absorbs three DB-labeled sections — labels come from new DB rows, and the old rows keep their absorption record; (3) do not let the anomaly expansion grow buttons.
- **Backend work queued behind v1 (not blocking):** pulse population split, MFA denominator fix, audit filter vocabulary fix, kill-switch read route.

## 8. Reusable patterns discovered

- The **Observed | Coverage/Unobserved | Notes** three-column epistemic surface generalizes cleanly from Scheduler to Security (and to Growth — see growth-revenue-v1).
- **Inline expansion instead of panel** is the right drill form when the row has no deeper fetchable authority — a rule worth adding to the interaction doctrine.
- The **depth statement** ("last N, newest first") as a surface-level element, not a footnote afterthought, whenever a route has a fixed `take`.
