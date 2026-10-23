# Design Study — Customer Success v1

**Program:** PLATFORM-DESIGN-STUDIES-1
**Space:** CUSTOMER_SUCCESS · workspace `platform-overview`
**Status:** Production design study. No production code. Grounded in the investigation (§4.4, §5.4, §9, Brief 3). Coordinates with the canonical Incident Preview (OPS-2D-5D-1) and the OPS-2D-5 roadmap's preview-first sequencing; rebuilds no incident semantics.
**Imagery:** `images/customer-success-desktop.png` · `images/customer-success-mobile.png`

---

## 1. Design goals

Grow Customer Success from one widget into a composed Space while staying strictly incident-shaped: episodes, severities, operation phrases, and subject labels at the grain the identity policy allows (institution · account — never a person, never an identifier). The study adds an honest **Impact header** over shipped DTO fields, keeps the canonical preview as the dominant surface, and shows the **Incident Browser / Detail / Recovery ledger** exactly as they will exist — with their missing routes visibly labeled `NARROW PROJECTION REQUIRED` in the imagery, per the program's production-reality rule. The customer portfolio is *not drawn at all*: its prerequisites (SyncIssue→user join, identity policy) are backend and policy work, and drawing it greyed would imply it is coming.

## 2. Operator questions served

- How bad is it right now, in one honest line? (severity composition over the full active set)
- What is open, against whom, how deep, and will it heal? (preview: severity word, subject, occurrence depth via `occurrenceText`, recovery via `RECOVERY_TEXT`, execution correlation)
- Show me everything open, ranked. (browser — canonical operator order, floor semantics)
- What healed on its own? (recovery ledger — `AUTOMATIC_RECOVERY` only, resolving execution only when proven)
- Which episodes recur? (detail panel — `previousIncidentId` chain)

## 3. Composition

```
PlatformAreaHero        "What is customer-visible right now?"
Impact                  SectionSurface · severity distribution + summary + domain strip     ← posture
Sync incidents          canonical Incident Preview (6 of 9)                                  ← dominant (shipped)
Incident browser        SectionSurface · dense table + filters      [NARROW PROJECTION REQUIRED]
Recovery ledger         SectionSurface · recovered episodes         [NARROW PROJECTION REQUIRED]
Detail                  RightPanel · lifecycle · recurrence · occurrences · identity  [NARROW PROJECTION REQUIRED]
```

- **Impact:** segmented severity bar (word + count per segment, `SEVERITY_TOKEN` colours — critical `--coral-400`, error `--coral-300`, warning `--coral-100`, info muted; urgency is saturation), `summaryText` sentence, by-operation-family strip, and the floor footnote (200-episode scan; truncation renders floor language).
- **Preview:** untouched canonical wording — `incidentLabel` titles, ` · operation phrase`, subjects or `"Affected account unavailable"` at full weight, `occurrenceText`, `RECOVERY_TEXT`, `· Linked to sync execution`, "3 more active incidents — stated, not linked."
- **Browser:** full active set; columns Severity · Incident · Subject · First·last · Depth (with correlated count); filter pills (state/severity/domain) and subject search; canonical sort only — the UI never re-sorts.
- **Recovery ledger:** recovered episodes with resolution facts; *"resolving execution not recorded — never invented"* on rows whose correlator named none.
- **Detail panel:** Lifecycle · Recurrence (chain, "a resolved episode is never reopened") · Occurrences timeline ("correlation unavailable" ≠ "nothing ran") · Identity (incident key in mono, "derived at read time · never stored"). Close-only footer — no remediation controls exist and none are drawn.

## 4. Interaction model

Preview → Browser → Detail, sequenced per OPS-2D-5: the preview is shipped and observed; the browser and detail arrive with routes over `getActiveIncidentPage` / `getHistoricalIncidents` / `getIncidentDetail`. The expanded state in the desktop image is a **selected browser row with the detail RightPanel open**, both wearing dependency chips so no reviewer mistakes them for shipped capability. Impact-bar segments are inert in v1; when the browser lands they become severity filters (noted, not drawn as live). Panels are widget-owned; detail fetch uses the keyed-remount reader precedent.

## 5. Authority map

| Surface element | Category |
|---|---|
| Severity distribution, summary sentence, activeTotal/moreCount/floor language | **SHIPPED AUTHORITY** (`IncidentPreview.severityCounts` et al.) — the bar itself is **PRESENTATION WORK** |
| By-operation-family strip | **PRESENTATION WORK** with a small DTO extension (domain counts from the same 200-row scan — no new query) |
| Incident preview (6 rows, all wording) | **SHIPPED AUTHORITY** (OPS-2D-5D-1) |
| Incident browser (full set, filters) | **NARROW PROJECTION REQUIRED** — route over `getActiveIncidentPage` (projection exists; OPS-2D-5D-2) — labeled in imagery |
| Detail panel (lifecycle, occurrences, recurrence chain) | **NARROW PROJECTION REQUIRED** — route over `getIncidentDetail`; sequencing note: the migration doc reserves detail for UI-2 — build coordinated, not independently |
| Recovery ledger | **NARROW PROJECTION REQUIRED** — route over `getHistoricalIncidents` |
| Customer portfolio, customer health, customer×capability matrix | **BACKEND PREREQUISITE** (SyncIssue→user join + operator-identity policy) — deliberately not drawn |
| Outreach, tickets, owner, NPS, renewal | **INTENTIONALLY UNAVAILABLE** — not drawn, not greyed |
| Manual incident resolution / acknowledgement | **INTENTIONALLY UNAVAILABLE** (banned resolution kinds; read-only surface, Close-only footers) |
| `SyncIssue.detail` contents | **INTENTIONALLY UNAVAILABLE** on this surface (structurally unreachable — privacy by construction) |

## 6. Mobile

Single-column: impact bar wraps to two lines with words never dropped; preview rows condense to severity word → title → subject → depth/recovery line; the browser is withheld on mobile v1 (preview + "3 more — stated" carries the answer; a phone browser lands with the route, using the Jobs collapse pattern); recovery ledger as a two-row feed with its dependency chip. Detail opens as a bottom sheet.

## 7. Implementation guidance

- **Reusable primitives:** `SectionSurface`, `IncidentPreview` (as-is), `incident-preview-view.ts` vocabulary (`SEVERITY_TOKEN`, `occurrenceText`, `RECOVERY_TEXT`, `subjectText` — the browser/ledger must import, never re-derive), the new `DistributionBar` (first consumer; word+count segments, floor-aware caption), Jobs table grammar, `RightPanel` + keyed-remount reader, `KeyRow`/`PanelSection`.
- **Sequencing:** v1a ships Impact header + DTO domain-count extension (no new routes). v1b ships browser + ledger + detail when OPS-2D-5D-2 routes land, honoring preview-first observation.
- **Complexity:** v1a low; v1b medium (three bounded routes over existing projections + one dense table).
- **Risks:** (1) occurrence-vs-incident misread — every depth cell uses `occurrenceText` phrasing; (2) the browser must not re-sort or re-classify (import `sortIncidentsForOperator` order from the route; assert with a boundary test like `incident-boundary.test.ts` §1); (3) floor semantics must survive into the browser header ("9" vs "9 of ≥200-scan" when truncated); (4) subject-label rules are load-bearing — wallets currently resolve no subject and must render "Affected account unavailable" at full weight, never an id.
- **Backend work:** the three routes; the small severity/domain DTO extension; nothing else.

## 8. Reusable patterns discovered

- **Dependency chips inside otherwise-real surfaces** (`NARROW PROJECTION REQUIRED · route over X`) let a study show target interaction without fabricating capability — recommended as the program-wide convention for gated surfaces.
- The **impact composition header** (distribution + canonical summary sentence + floor caption) generalizes to any Space with a severity-counted set — it is the `DistributionBar` promotion evidence.
