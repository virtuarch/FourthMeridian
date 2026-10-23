# Design Study — Growth & Revenue v1

**Program:** PLATFORM-DESIGN-STUDIES-1
**Space:** GROWTH_REVENUE · workspace `platform-overview`
**Status:** Production design study. No production code. Grounded in the investigation (§4.3, §5.3, §8, Brief 2). Coordinates with GROWTH-1; alters none of its semantics.
**Imagery:** `images/growth-desktop.png` · `images/growth-mobile.png`

---

## 1. Design goals

Give the Space the page-grain composition PM-3 planned: an epistemic **Window & coverage** surface above the shipped canonical funnels, with a **Growth context** supporting band below. The central design statement is the **Unobserved column**: Revenue, Cohort retention, and Acquisition source rendered through `Unavailable` at the same visual weight as observed figures. On a Space named "Growth & Revenue" that observes zero revenue, the interface's credibility depends on saying so plainly — *"None of these render as 0, 0%, or 'Other.' A zero would be a claim."*

GROWTH-1 invariants honored throughout: two funnels, two populations, never chained; activation = ≥1 session (first bank connection deliberately unmeasured, stated in the footnote); three-state rates (`undefined` → nothing, `null` → em-dash, `0` → 0%); no verdict colour anywhere on growth surfaces; every fact on the surface (no hover-only).

## 2. Operator questions served

- Where are users entering, and where are they dropping? (funnels + siblings)
- Who got in but never arrived? (activation gap: approved-unredeemed, redeemed-never-signed-in)
- Is the beta queue rotting? (oldest pending age, FIFO depth)
- Are invitations converting? (lifecycle: sent/accepted/expired/revoked)
- What does growth *not* observe? (revenue, cohorts, attribution — named, never zeroed)

## 3. Composition

```
PlatformAreaHero        "How is the platform growing?"
Window & coverage       SectionSurface · Observed | Unobserved | Notes
Growth funnel           SectionSurface · Beta access ‖ Activation (FunnelStages ×2)   ← dominant (shipped)
Growth context          SectionSurface · Activation gap · Invitation lifecycle        ← supporting
(Beta access requests / Users write surfaces remain their own sections, unchanged)
```

- **Observed:** Accounts 62 ("58 verified · 55 signed in", derivation "User + UserSession, counted now"); Access requests with status split and the *approved includes redeemed* note; Oldest pending with FIFO depth.
- **Unobserved:** the three absences via `Unavailable(reason)` — reasons are the code-verified ones (no billing model; no stored history; no attribution field).
- **Notes:** point-in-time declaration, the three-state rate contract stated in one sentence, `checkedAt` read line, provenance chips.
- **Funnels:** the shipped `FunnelStages` pair, untouched. The image shows the Redeemed stage selected.
- **Context:** Activation gap (both stats derivable from shipped DTOs: `beta.redeemed − beta.redeemedActivated`; approved-unredeemed from `/requests` counts) and Invitation lifecycle (from `/beta-status`).

## 4. Interaction model

The expanded state in the desktop image is the **shipped interaction**: funnel stage selected → `GrowthStagePanel` (`RightPanel`, md, always-mounted, `open` toggling). The panel renders exactly what production renders — Stage facts, authority field in mono, adjacent stages, siblings-or-absence, and the Evidence group that states the projection's limit. No interpretation, no recommendation, no footer: the study deliberately re-affirms production's rejection of the prototype's Fact → Interpretation → Recommendation progression. The beta-queue write flows (approve/deny/resend/revoke, mode switches) stay in their existing widget and are out of this study's scope.

## 5. Authority map

| Surface element | Category |
|---|---|
| Funnels, stage panel, three-state rates | **SHIPPED AUTHORITY** (GROWTH-1 trio over `/growth`) — drawn as-is |
| Accounts / requests counts, status splits | **SHIPPED AUTHORITY** (`/signups`, `/requests`, `/growth`) |
| Oldest-pending age, FIFO depth | **PRESENTATION WORK** (derived in a view-model from `/requests` pending rows' `createdAt` — rows already served) |
| Activation gap: redeemed-never-signed-in | **PRESENTATION WORK** (`redeemed − redeemedActivated`, both in `GrowthFunnel`) |
| Activation gap: approved-unredeemed | **PRESENTATION WORK** (`counts.approved` vs `redeemed`; both served) |
| Verified-never-signed-in overlap | **NARROW PROJECTION REQUIRED** — not drawn in v1 |
| Invitation lifecycle strip | **SHIPPED AUTHORITY** (`/beta-status` → `BetaInvitationLifecycle`) |
| Unobserved column (revenue · cohorts · attribution) | **INTENTIONALLY UNAVAILABLE** — rendered as named absence, enforced by `growth-funnel.test.ts`'s vocabulary guard |
| Signups-per-day / activity trends | **NARROW PROJECTION REQUIRED** — deliberately *not drawn* in v1 (a snapshot surface must not grow a trend axis before its projection exists) |
| Revenue movement, forecast, segments, cohort curves | **INTENTIONALLY UNAVAILABLE** — not drawn, not greyed |

## 6. Mobile

Single-column: Observed as a two-up stat grid, then oldest-pending as a key row; Unobserved as three `Unavailable` lines (full weight preserved at 390px); funnels stacked Beta-first with narrowed label column; context as key-row groups. The stage panel becomes the standard bottom sheet. Nothing is truncated; rate cells keep their exact three-state behavior.

## 7. Implementation guidance

- **Reusable primitives:** `SectionSurface`, `BigStat`, `Unavailable`, `Provenance`, `GroupLabel`, `KeyRow`, `VRule`; `FunnelStages`/`GrowthStagePanel` untouched (GROWTH-1 owns them — PM-3 must not modify).
- **Composition:** two new sections (`growth_window`, `growth_context` — names illustrative) composed before/after `growth_funnel`; existing five sections keep their DB rows; seed rows required for new keys.
- **View-model:** one `growth-window-view.ts` computing *presentation* aggregates only (oldest-pending age, gap subtractions) from route DTOs — under the GROWTH-1 guard discipline: the module must not compute any new *rate*, must not touch `db`, and every displayed number must trace to a served field.
- **Complexity:** low. No routes, no schema. The main cost is copywriting the absence column precisely and extending the vocabulary guard to the new files.
- **Risks:** (1) subtraction-derived stats (gap figures) sit at the edge of "presentation" — keep them in the view module with their derivation lines rendered, so the authority boundary stays inspectable; (2) the Unobserved column must never gain a digit — extend the `ABSENT`-word test to the new surface files; (3) oldest-pending reads the FIFO slice (take 100) — if the queue ever exceeds it, the age is a floor; state it when `pending.length === 100`.
- **Backend work queued (not blocking):** growth-history projections for trends; verified∩never-signed-in overlap query.

## 8. Reusable patterns discovered

- The **Unobserved column** is the generalizable form of the data-confidence callout: absence with reasons, at observed-data weight. Security's Notes column and CS's identity-boundary note are the same pattern.
- **Derivation lines under stats** (`BigStat`'s fourth line) scale to any Space and should be considered mandatory for any figure whose population could be misread.
