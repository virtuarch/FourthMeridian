# Parallel Workstream Investigation — Customer-Facing Application & Landing Experience

**Date:** 2026-07-08
**Type:** Investigation only — no code, no implementation, no roadmap edits.
**Question:** While Transaction Intelligence (TI) proceeds through the RelationshipResolver foundation, what substantial body of work can run fully in parallel without depending on TI or colliding with it?

**Sources verified against the working tree:** `STATUS.md` (canonical), `PRELAUNCH_AUDIT_2026-07-06.md` Parts 4–6, `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md`, `docs/investigations/TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md`, the `app/` route tree, `components/`, `lib/email/`, `public/`.

---

## 1. TI's conflict surface (what parallel work must avoid)

TI (fact layer + eventual detail-view surface) owns or will touch:

- `prisma/schema.prisma` — Transaction model columns + the **serialized migration train**
- `lib/transactions/*` (incl. `serialize.ts`, the TI-1 canonical DTO single-site)
- `lib/data/transactions.ts`
- Sync write path (`lib/plaid/*` writers) for fact stamping
- Transaction-rendering UI when Phase 2's overlay lands: `app/(shell)/dashboard/history`, `BankingClient`, `SpaceTransactionsPanel`, eventually AI assemblers

Anything that stays out of these files — and out of the migration queue, or coordinates one additive migration — is conflict-free.

## 2. Area-by-area assessment

Columns: **Status** · **Missing** · **Deps** · **Blocks beta launch?** · **Depends on TI?** · **Parallel-safe?** · **Size**

| # | Area | Status | Missing | Deps | Blocks launch? | TI dep? | Parallel? | Size |
|---|---|---|---|---|---|---|---|---|
| 1 | Marketing website | **Does not exist.** `/` redirects to `/dashboard/brief` → login. The login page is the homepage. | Tier-1 set from PRELAUNCH_AUDIT Part 4: Home, Security, About (+ legal + request-access below). ~7 pages total. | None — public static routes; `proxy.ts` only gates `/dashboard/*` and `/admin/*` (verified in OPS-1 plan S9). | **Yes** — beta candidates need something to land on. | No | **Yes — zero file overlap** | **M** |
| 2 | Landing page (homepage) | None (see above). Hero asset (`public/hero/earth-mena.png`), logos, brand PNGs exist. | Part 5 homepage spec is already written: hero, honesty section, Spaces, multi-currency, brief, security strip, beta CTA. One real Daily Brief screenshot needed. | Marketing site shell; screenshot from seeded demo data. | **Yes** | No | **Yes** | **S–M** (within #1) |
| 3 | Waitlist flow | **Does not exist.** Design already ratified: **Request Access with manual approval**, not a bare waitlist (audit Part 6; OPS-1 S10). | `AccessRequest` + `InviteToken` tables, public rate-limited `POST /api/access-request`, admin queue tab, `BETA_REQUIRE_INVITE` flag on register, beta-invite email template. | Email substrate (✅ done), rate limiting (✅ S4 done), admin surface (✅ exists). **One additive migration — must take a slot in the serialized migration train (coordinate with TI, see §4).** | **Yes** — the beta gate IS the launch mechanism. | No | **Yes** | **M** |
| 4 | Authentication experience | **Strong.** Login w/ TOTP + recovery codes, register, forgot/reset, email verification + resend, email-change confirm — all live with real emails (`lib/email` callers across all auth routes). | Terms-accept checkbox + `acceptedTermsAt` (S9), invite-token consumption (S10), minor copy/visual polish. | S9/S10. | No (residuals ride S9/S10) | No | Yes — small, isolated edits to `app/(auth)/register` | **XS–S** |
| 5 | Dashboard shell | **Mature.** `DashboardChrome` (Sidebar + BottomNav), route groups `(auth)/(brief)/(shell)`, per-Space currency provider. | Polish only. | — | No | No | Touches shared chrome — low value, defer | **S** |
| 6 | Empty states | **No inventory.** D2.x progressive-reveal covers sync states; audit flags no systematic empty-state pass (Part 3 #9). | Audit + fill: dashboards, spaces, goals, connections, settings. **Transaction-list empty states excluded** (TI will reshape those surfaces). | None for non-transaction surfaces. | Soft (beta users hit them day one) | Only the transaction ones | **Yes, scoped to non-transaction surfaces** | **S** |
| 7 | First-run onboarding | **None** beyond D2.x first-sync mechanics ("plumbing, not onboarding" — audit). No guided first-run, no "what is a Space" moment. | Guided flow through register → space → connect → brief. | Touches `DashboardClient`/`SpaceDashboard` (large shared files); content should reflect post-TI transaction surfaces. | **No** for a 20-person hand-picked beta (you can onboard them personally) | Partly (tour content) | **No — defer** (conflict-prone + rework risk) | **M–L** |
| 8 | Space creation | **Complete.** `CreateSpaceModal`, `ManageSpaceModal`, roles, invites, per-Space currency. | Nothing launch-blocking. | — | No | No | n/a | **XS** |
| 9 | Account connection UX | **Complete** (D2.x ✅: fast-path split, background history, sync-status endpoint, `/dashboard/connections` hub). Deferred: SyncJob/webhook/retry hardening (v2.5, recorded). | The recorded deferrals only. | Sync engine — adjacent to TI's write-path stamping. | No | No, but shares the sync write path | **Weak parallel — defer deferrals** | **M** (deferred) |
| 10 | Transaction browsing UX | Exists (history page, Banking, Space transactions panel). | The detail view/overlay — **which is TI Phase 2 itself.** | TI facts. | No (current browsing is serviceable) | **YES — this IS TI's surface** | **No — must wait** | — |
| 11 | Mobile responsiveness | **Partial.** BottomNav exists; responsive classes present but thin (~50 breakpoint usages across dashboard components); `userScalable: false` set. | Systematic pass. Marketing/auth/settings surfaces can be done now; dashboard data surfaces later. | — | Soft | Dashboard txn surfaces yes; rest no | **Partial — marketing+auth+settings only** | **M** (split S now / S later) |
| 12 | Settings | **Strong.** Six pages: account, security (TOTP, sessions, history), notifications, preferences, data (export/delete live — OPS S7/S8 shipped), archived-assets. | Copy polish; billing section intentionally absent. | — | No | No | n/a | **XS** |
| 13 | Billing placeholders | **Correctly absent.** D10 ratified: billing ban lifts at v3.0, nowhere earlier. Audit Tier 3: "a pricing page now is fiction." | Nothing — deliberately. | — | No | No | **Intentionally wait (post-beta, v3.0)** | — |
| 14 | Privacy / Terms / Legal | **Does not exist.** Fully specified as OPS-1 S9: `/terms`, `/privacy`, `/legal/ai` public routes; drafted-honest acceptable for hand-picked beta, counsel review deferred to v3.0/L-1 (risk acceptance recorded). Closes STATUS blocker 7 (LLM disclosure). | The three pages + register acceptance stamp. Gate: every claim true on deploy day (export/delete already true — S7/S8 ✅). | None. **Explicitly "parallel-safe from day one"** per the OPS-1 plan. | **Yes** | No | **Yes** | **S** |
| 15 | Help / Support / Contact | **None.** Audit Tier 2: an email address is enough; a black hole is not. | `support@` + `security@` (responsible disclosure) addresses; contact line on About/Security pages. | Domain email (exists via Resend sending domain). | Soft | No | Yes | **XS** |
| 16 | Email polish | Substrate ✅ (OPS-1 S0/S1: chokepoint, Resend adapter, capture transport). Seven text-first templates live; retry/outbox done (OPS-4 S4). | Beta-invite template (part of S10). HTML branding = deliberately low value now (text-first was a recorded choice). Digests deferred with recorded reasons (OPS-4). | — | No | No | Beta-invite yes (inside S10); rest wait | **XS** |
| 17 | Public marketing assets | Logos, marks, hero image, og-image exist. **OG metadata still points at `fintracker.app`** (flagged in `app/layout.tsx` comments); og-image is pre-rebrand. | Regenerate OG image, fix `openGraph.url`, product screenshots from seeded data. | Marketing site. | Soft (embarrassing, not fatal) | No | Yes | **XS** |
| 18 | Visual polish / design system | UI-1 Atlas Glass **Active**: overlay primitives, Material Engine 1A, palette ratchet all landed. L-1 owns the app-wide consistency pass. | App-wide sweep. | Touches everything — including TI's future surfaces. | No | Indirect | **No — wait for the L-1 targeted pass post-TI** | **L** |
| 19 | Animations | App: restrained by doctrine. Marketing: none yet. | Audit verdict: one tasteful motion moment max on the homepage; "no animated fake numbers." | Marketing site. | No | No | Yes (inside #1) | **XS** |
| 20 | Accessibility | No audit performed. L-1 lists the a11y pass. | Marketing/auth/legal pages: build accessible from day one (cheap when new). App-wide audit: later. | — | No (beta) | App surfaces partly | **Partial — new pages now, app sweep later** | **S now / M later** |
| 21 | SEO | **Nothing indexable** — root redirects into the auth gate; no robots.txt, no sitemap; stale OG url. | Comes nearly free with the marketing site: metadata, sitemap, robots, canonical domain. | Marketing site. | Soft | No | Yes (inside #1) | **XS** |
| 22 | Performance | App: MC1 perf P0 landed; no known launch-blocking issue. Public pages: static, trivially fast by construction. | App perf pass → later; nothing now. | — | No | No | Wait | — |
| 23 | Production readiness | **Strong floor:** rate limiting default-on, security headers (CSP report-only), env validation at boot, health endpoint, job dispatcher + ledger + dead-job detection, runbooks. | CSP enforce flip (after clean window) · Sentry init (documented point) · external uptime monitor (no code) · restore drill · key-rotation drill · **production Plaid credentials — application not started (L-1: "start during v2.6 window"; long external lead time)**. | Mostly ops tasks, not code. | **Plaid prod = yes** (beta users need real bank connections); rest are floor items | No | **Yes — zero code overlap; Plaid application should start immediately** | **S** (code) + ops tasks |

## 3. Dependency map

```
TI (RelationshipResolver → facts → Phase 2 overlay)          [ongoing lane — untouched]
 └─ owns: prisma Transaction cols, lib/transactions/*, lib/data/transactions.ts,
          sync-writer stamping, transaction UI surfaces, migration-train slots

PARALLEL LANE (zero TI contact):
 OPS-1 S9 Legal pages ──────────────┐   (no deps; parallel-safe from day one)
 OPS-1 S10 Access-gate substrate ───┼──► BETA-1 marketing surface ──► Private Beta
   └─ needs: 1 additive migration       (Home/Security/About/Request-Access,
      email template (substrate ✅)       SEO/OG/robots, contact addresses,
      admin tab (surface ✅)              a11y-clean + mobile-clean by construction)
 Plaid production application ──────────────────────────────► Private Beta
   (external lead time — start now, no code)
 Ops floor residue (uptime monitor, Sentry, CSP flip, restore drill) ─► Private Beta

TOUCHES SHARED FILES (weak parallel — sequence carefully):
 Non-transaction empty states (S) · register-page terms/invite edits (XS, inside S9/S10)

MUST WAIT FOR / RIDE BEHIND TI:
 Transaction detail view (IS TI Phase 2) · transaction-list empty states ·
 first-run onboarding tour · app-wide visual polish / a11y / perf pass (L-1) ·
 merchant display work (MI2 lane) · billing (banned until v3.0)
```

**Single coordination point:** S10's `AccessRequest`/`InviteToken` migration is additive (two new tables, zero existing-table contact) but the repo's serialized-migration doctrine means its slot must be sequenced against any TI migration. Land it either before TI's next migration or immediately after — a one-conversation coordination, not a dependency.

## 4. Recommendation

**Best parallel initiative: the Public Surface & Beta Gate — OPS-1 S9 + S10 + BETA-1's Tier-1 marketing surface, executed as one workstream.**

Why this and not something larger:

- **It is the literal remaining gap between the codebase and Private Beta.** STATUS names S9/S10 as OPS-1's next milestones; the prelaunch audit's strongest finding was that BETA-1 "should happen next," gated only on OPS-1. Everything else on the list (onboarding, polish, mobile) improves a beta; this one *enables* it.
- **Near-zero merge-conflict surface with TI.** New public routes, new tables, a new admin tab, a new email template. TI lives in the transaction data layer and its UI. The only shared files are `app/(auth)/register/page.tsx` (a checkbox and a token field) and `prisma/schema.prisma` (additive, coordinated once).
- **The design work is already done.** Part 4–6 of the prelaunch audit specify the pages, the copy direction, the form questions, and the approval mechanics; the OPS-1 plan specifies S9/S10 to the schema level. This is execution, not invention — which keeps it small and honest to "smallest implementation that satisfies approved scope."
- **It converts already-built substrate into launch readiness.** Email, rate limiting, admin surface, export/delete — all shipped and waiting for exactly these consumers.

Fold in the free riders while there: SEO/robots/sitemap, OG-image + `fintracker.app` metadata fix, `support@`/`security@` contact, accessibility and mobile correctness on the new pages (cheap at build time, expensive retrofitted).

**Start in parallel with zero code: the production Plaid application.** L-1 already says to start it in this window; it has the longest external lead time of anything on the launch path and no merge surface at all.

**Deliberately wait (would create rework or conflicts):**

1. **Transaction detail view / browsing revamp** — it *is* TI Phase 2; building it now duplicates TI's surface.
2. **Transaction-list empty states and any transaction-UI polish** — TI reshapes those components.
3. **First-run onboarding tour** — touches the largest shared client files and must describe post-TI surfaces; also unnecessary for a hand-picked cohort you can onboard personally.
4. **App-wide visual polish / accessibility / performance passes** — L-1's targeted pass, after TI's UI lands, or it gets done twice.
5. **Billing, even placeholders** — D10 ban until v3.0; a pricing page now is fiction (audit Tier 3).
6. **Merchant display work** — MI2's lane; TI deliberately surfaces category-dialect inconsistencies MI must resolve first.

## 5. Recommended execution order → beta launch

| # | Initiative | Size | Lane | Notes |
|---|---|---|---|---|
| 1 | **OPS-1 S9 — legal pages** (`/terms`, `/privacy`, `/legal/ai` + register acceptance) | S | Parallel | No deps; closes STATUS blocker 7; privacy claims already true (S7/S8 ✅) |
| 2 | **Plaid production application** (ops, no code) | — | Parallel | Start immediately — longest external lead time on the critical path |
| 3 | **OPS-1 S10 — access-gate substrate** (AccessRequest/InviteToken, request endpoint, admin queue, invite gating) | M | Parallel | Coordinate the one additive migration slot with TI |
| 4 | **BETA-1 — Tier-1 marketing surface** (Home, Security, About, Request Access; SEO/OG/robots; contact addresses; built mobile- and a11y-clean) | M | Parallel | Uses audit Parts 4–6 as spec; Daily Brief screenshot from seeded data |
| 5 | **Ops floor residue** (uptime monitor, Sentry init, CSP enforce flip after clean window, restore drill) | S | Parallel | Mostly ops tasks; interleave with 3–4 |
| 6 | **Non-transaction empty-state pass** | S | Weak parallel | Only if TI still in flight after 1–5; skip transaction surfaces |
| 7 | — **TI lands** — | | | |
| 8 | Transaction detail surface (TI Phase 2) + transaction empty states | (TI's own) | Post-TI | |
| 9 | First-run onboarding (informed by watching the first cohort — the audit's core argument) | M–L | Post-TI | |
| 10 | L-1 polish pass: app-wide visual consistency, accessibility, mobile data-surfaces, performance | L | Post-TI / pre-open-beta | Once, not twice |
| 11 | Billing (v3.0, per D10) | — | Post-beta | Unchanged |

**Bottom line:** the parallel workstream is not a feature — it's the front door. S9 + S10 + the seven-page public surface is roughly two weeks of low-risk, fully-specified work that turns "the login page is the homepage" into a launchable private beta, while TI proceeds untouched in the transaction layer. Everything flashier (onboarding, polish, mobile sweeps) either collides with TI's files or gets rebuilt after TI and should wait.
