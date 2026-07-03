# Atlas Material Classification Report

**Status:** Investigation & architecture. No code, schema, migrations, or UI changes.
**Governs:** where **Atlas Glass** (structural default) and **Atlas Liquid** (rare premium accent) may exist across Fourth Meridian, current and future (v2.6+, Marketplace, Frameworks, Enterprise, Platform Ops).
**Companions:** `ATLAS_LIQUID_PLATFORM_DOCTRINE.md`, `ATLAS_GLASS_MATERIAL_DOCTRINE.md`, `SPACES_LIQUID_DESIGN_INVESTIGATION.md`.

**Classification legend:** **Glass** (structural default) · **Liquid** (approved premium accent) · **Never Liquid** (permanently excluded) · **Future Candidate** (may earn Liquid via the Expansion Gate, §Expansion Gates).

> **Prime rule (unchanged):** Glass is the platform. Liquid is the accent. Scarcity is the strategy.

---

## 1. Daily Brief — the sanctioned storytelling surface

Grounded in `components/brief/*` + `app/(brief)/dashboard/brief`.

| Surface | Component | Material | Reason |
|---|---|---|---|
| Hero Earth backdrop | `EarthBackground` | **Glass/Field** (not Liquid) | Ambient brand imagery; not a WebGL refraction surface. |
| Hero CTAs (Continue, View AI) | `BriefHero` → `AtlasLiquidCta` | **Liquid** ✓ | High-intent primary actions on the flagship narrative surface. |
| Story cards (Insight / Since-last-visit / Attention) | `BriefInsight`, `BriefSinceLastVisit`, `BriefAttention` → `AtlasLiquidCard` | **Liquid** ✓ | Narrative/storytelling; the one surface where multiple Liquid cards are sanctioned. |
| Insight chart | `InsightDecoration` (SVG) | **Glass** (crisp DOM over the Liquid card) | Data mark; never its own Liquid surface. |
| "Since last visit" metrics/timeline | inside `BriefSinceLastVisit` | **Glass content** | Data; refracted only as the card's backdrop, never itself Liquid. |
| Brief modals | `BriefModal`, `AttentionModal`, `SinceLastVisitModal` | **Never Liquid** | Modal chrome = `backdrop-filter` doctrine. |

**Doctrine match:** all current Liquid usage is compliant *in kind*. **But note the budget:** the Brief runs **~5 simultaneous Liquid/WebGL surfaces** (2 CTAs + 3 cards). This is the **single most Liquid-dense surface in the app** and is the **explicit storytelling exception** to the one-per-view rule — it is also the **material-budget ceiling** (see §Material Budget) and a **mobile-perf watch item**. Nothing else in the platform may approach this density.

---

## 2. Spaces

Grounded in `SpacesClient`, `CreateSpaceModal`, `SpaceDashboard` (tabs: OVERVIEW, PERSPECTIVES, MEMBERS, TRANSACTIONS, ACTIVITY, SETTINGS).

| Surface | Material | Reason |
|---|---|---|
| Overview (page frame) | **Glass** | Management surface; visionOS-calm. |
| Current/My Spaces canvas | **Glass** | Shared `GlassPanel` grouping canvas. |
| Space cards (tiles) | **Never Liquid** | Repeated grid; N WebGL contexts = perf non-starter (code deliberately uses tiles). |
| Create Space CTA | **Liquid** ✓ | Approved pilot — singular, high-intent primary action. |
| Template picker (in Create Space) | **Glass** | Form step; not a hero. |
| Future Template **gallery** | **Future Candidate** | One **featured** template card only; the gallery grid stays Glass. |
| Space detail hero (`SpaceTrendHero`) | **Never Liquid** | Sits over the **live shared Atlas globe** — Liquid refracts a *supplied* texture, so it clashes (already rejected). |
| Perspective tabs | **Glass** | Data/analytics tabs. |
| Members | **Glass** | List/roster + management. |
| Transactions | **Glass** | Dense data list. |
| Settings | **Glass** | Forms. |

---

## 3. Marketplace / Frameworks (future)

| Surface | Material | Reason |
|---|---|---|
| Marketplace home hero | **Future Candidate** | One hero banner may earn Liquid (discovery/emotion). |
| Framework cards (listing) | **Never Liquid** | Repeated grid. |
| Featured framework (one) | **Future Candidate** | A single spotlighted card = valid rare accent. |
| Creator profiles | **Glass** | Profile/data; maybe one avatar/hero moment as Future Candidate. |
| Purchase flow | **Glass** (Never Liquid chrome) | Modal/form; the **final "unlock/confirm premium" CTA** is a Future Candidate. |
| Search results | **Never Liquid** | Repeated grid/list. |
| Categories | **Glass / Never Liquid** | Navigation/filter chrome. |
| Recommendations | **Future Candidate** | One spotlighted "recommended" hero only; the rec list stays Glass. |

**Earns Liquid:** the marketplace **hero**, **one featured framework**, **one recommended spotlight**, and a **premium-unlock CTA**. Everything gridded/listed/transactional stays Glass.

---

## 4. Meridian Analyst (AI)

Grounded in `AnalyzeClient` — a full-bleed **conversation** surface (chat + composer) plus advice/gaps.

| Surface | Material | Reason |
|---|---|---|
| Landing / entry hero | **Future Candidate** | A single "meet your analyst" hero/CTA could earn Liquid. |
| Conversation (chat/composer) | **Never Liquid** | Productivity + streaming + dense; Liquid would interfere and cost WebGL per turn. |
| Reports | **Glass** | Data/document surfaces. |
| Charts | **Never Liquid** | Data marks. |
| Insights | **Glass** | Data; a single "premium insight" spotlight is a Future Candidate. |
| Recommendations | **Glass** | Actionable list. |
| Premium AI moment (upgrade/unlock) | **Future Candidate** | One premium/upgrade hero or CTA. |

**Rule:** Liquid never touches the working conversation, reports, or charts. Only a **landing/premium hero moment** is a candidate.

---

## 5. Admin

Grounded in `app/admin/*` (Security, Platform, Users, Audit, Providers). These are functional surfaces (they don't even lean on the Atlas Glass primitives heavily).

| Surface | Material | Reason |
|---|---|---|
| Security, Platform, Users, Audit, Provider management | **Never Liquid** | Operational/functional/dense; no premium or emotional intent. |

**Liquid belongs nowhere in Admin.**

---

## 6. Platform Ops (future)

System health, queues, cron jobs, sync status, provider health, telemetry, deployment, monitoring.

| Surface | Material | Reason |
|---|---|---|
| All Platform Ops surfaces | **Never Liquid (entirely Glass)** | Real-time, dense, operational; correctness/legibility over emphasis. WebGL cost is unjustifiable here. |

**Platform Ops remains 100% Glass. No exceptions.**

---

## 7. Enterprise (future)

| Surface | Material | Reason |
|---|---|---|
| Enterprise dashboards (data) | **Never Liquid (Glass)** | Dashboards = data = Glass, forever. |
| Enterprise landing / exec-summary hero | **Future Candidate** | At most one welcome/exec hero moment. |
| Reports, tables, admin controls | **Glass / Never Liquid** | Functional/data. |

---

## 8. Material Budget (permanent architectural rules)

Hard limits. Any surface exceeding these fails the Expansion Gate.

| Rule | Limit |
|---|---|
| **Liquid heroes per page** | **1** (exception: the Daily Brief storytelling surface). |
| **Liquid CTAs per page** | **1** (exception: Daily Brief hero = 2). |
| **Liquid cards per page** | **0** everywhere **except the Daily Brief** (≤ 3 narrative cards). |
| **Simultaneous WebGL surfaces per page** | **≤ 3** for any normal page; **≤ 6 absolute ceiling** (only the Daily Brief may approach it). Fewer on mobile. |
| **Grid policy** | **Never** Liquid inside a grid/list/row. At most **1** Liquid item *adjacent* to a grid (e.g., a featured card above it). |
| **Dashboard policy** | Data surfaces are **always Glass**; at most **1** rare milestone/celebration hero, gated. |
| **Modal policy** | Modals/overlays are **always Glass** (`backdrop-filter` doctrine). Liquid never forms modal chrome. |
| **Fallback policy** | Every Liquid surface **must** carry a Glass fallback via `useAtlasLiquid` (no WebGL / reduced-transparency / `?atlasLiquid=0`). |
| **Backdrop policy** | Liquid may only sit over a **static/known** texture; **never** over a live shared backdrop (globe, dashboards). |

**Current standing:** the Daily Brief (~5 WebGL surfaces) is at the ceiling and is the one sanctioned exception; all other pages are ≤ 1 (Create Space CTA). The platform has budget headroom everywhere except the Brief.

---

## 9. Material Matrix (summary)

| Surface | Material | Reason |
|---|---|---|
| Daily Brief hero CTAs | Liquid | High-intent, storytelling exception |
| Daily Brief story cards | Liquid | Narrative surface |
| Daily Brief charts/timeline/modals | Glass / Never | Data / modal chrome |
| Spaces overview + canvas | Glass | Management + grouping |
| Space cards (grid) | Never Liquid | Repeated grid |
| Create Space CTA | Liquid | Approved singular CTA |
| Template picker | Glass | Form step |
| Template gallery — featured card | Future Candidate | One spotlight |
| Space detail hero | Never Liquid | Over live globe backdrop |
| Space members/transactions/settings/perspectives | Glass | Data/forms |
| Marketplace hero / featured / recommendation / unlock CTA | Future Candidate | Singular discovery/premium |
| Marketplace/search grids, categories, purchase flow | Never Liquid / Glass | Repeated / functional |
| Analyst conversation/reports/charts | Never Liquid | Productivity/data |
| Analyst landing/premium moment | Future Candidate | Single hero/upgrade |
| Admin (all) | Never Liquid | Functional |
| Platform Ops (all) | Never Liquid | Operational/dense |
| Enterprise dashboards | Never Liquid | Data |
| Enterprise landing hero | Future Candidate | One exec/welcome hero |
| All modals/overlays platform-wide | Never Liquid | Backdrop-filter doctrine |
| All chrome/nav/toolbars/tooltips/menus | Never Liquid | Structural utility |

---

## 10. Expansion Gates (reusable approval checklist)

A new Liquid surface may be approved **only if it answers correctly to every question**:

1. **Singular?** Is it one-of on its view (not repeated/gridded/listed)? — must be **yes**.
2. **High intent / emotional?** Primary action, discovery, hero, storytelling, or premium moment? — must be **yes**.
3. **Repeated?** Is it (or could it become) a collection/grid/row? — must be **no**.
4. **Live backdrop?** Does it sit over a live shared backdrop (globe, dashboard)? — must be **no** (static/known texture only).
5. **Data-dense / productivity?** Is it a data, form, chat, or utility surface? — must be **no**.
6. **Glass fallback?** Does it degrade cleanly to Glass (no WebGL / reduced-transparency / `?atlasLiquid=0`)? — must be **yes**.
7. **Budget?** Does adding it keep the page within §8 (≤1 hero/CTA off-Brief, ≤3 WebGL normal / ≤6 ceiling)? — must be **yes**.
8. **Modal?** Is it modal/overlay chrome? — must be **no**.
9. **Doctrine sign-off?** Recorded against the Material Matrix (§9), not adopted ad-hoc? — must be **yes**.

Any **no** on 1/2/6/7/9 or any **yes** on 3/4/5/8 = **rejected / stays Glass**.

---

## 11. Atlas materials roadmap

| Milestone | Liquid expands to… | Liquid must **not** expand to… |
|---|---|---|
| **v2.5 (now)** | Daily Brief (hero CTAs + story cards) ✓; Create Space CTA ✓ | Spaces grid, Space detail, dashboards, modals, admin |
| **v2.6** | (Optional) one **featured template card**; one **empty-state/onboarding hero**; a **milestone/celebration hero** (cautiously) | Template grid, perspective tabs, data cards |
| **Marketplace** | Marketplace **hero**, **1 featured framework**, **1 recommended spotlight**, **premium-unlock CTA** | Listing/search grids, categories, purchase forms |
| **Frameworks** | **1 featured framework** card; a **creator hero** moment | Framework card grid, framework detail data |
| **Enterprise** | **1** enterprise landing/exec hero | Enterprise dashboards, reports, tables, admin |
| **Platform Ops** | **Nothing — ever** | Everything (100% Glass) |

**Natural reappearance points:** hero banners, featured/spotlight single cards, onboarding/empty-state heroes, premium-unlock CTAs, and rare celebration moments — always singular, always with a static backdrop and a Glass fallback.
**Permanent exclusions:** grids/lists/tables, data/charts/dashboards, modals/overlays, forms/inputs, chrome/nav, Admin, Platform Ops, and anything over a live shared backdrop.

---

## 12. Governing summary

- **Glass is the platform; Liquid is the accent.** This is architecture, not visual preference.
- The **Daily Brief is the one sanctioned Liquid-dense surface** and sets the material-budget ceiling; everywhere else is ≤ 1 Liquid surface.
- **Never Liquid** on grids, data, modals, forms, chrome, Admin, Platform Ops, or over a live backdrop — regardless of future features.
- Every Liquid surface: **singular, high-intent, static-backdrop, Glass-fallback, within budget, gate-approved.**

*Investigation only. No implementation. Any future Liquid surface must clear §10 and fit §8 before it is built.*
