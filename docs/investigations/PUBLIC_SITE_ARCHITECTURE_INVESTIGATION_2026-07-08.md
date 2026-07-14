# Fourth Meridian — Public Landing Site Architecture Investigation

**Date:** 2026-07-08
**Type:** Investigation only — no implementation, no file modifications, no schema, no migrations, no STATUS/ROADMAP edits.
**Approved direction:** one repo now · hard module boundary · extract later only if needed.
**Complements:** OPS-1 S9/S10, BETA-1 (PRELAUNCH_AUDIT Parts 4–6), TI (untouched), SP-1.

Every claim below was verified against the working tree on 2026-07-08.

---

## 1. Executive summary

The public site can be built inside the current repo with a genuinely hard boundary at near-zero risk, because the codebase already proves every pattern needed. The proxy gate (`proxy.ts`) matches **only** `/dashboard/*` and `/admin/*` — public routes are outside the auth gate by construction, not by exception. The `(auth)` route group already demonstrates "pages on the root layout with no dashboard chrome." The design system's tokens live in `app/globals.css` as plain CSS variables — reusable by marketing markup **without importing a single component** — which matters because **every existing UI/Atlas component is `"use client"`** (verified: `AppLogo`, `GlassPanel`, `GlassButton`, `AtlasLiquidCard`) and the marketing surface must be static/server-first.

The recommended shape: `app/(public)/*` on its own layout, a small set of **server-only** marketing primitives in `components/marketing/*` that consume the existing CSS variables (never the client components), copy as plain TS objects in `content/marketing/*` with legal pages as Markdown (rendered with the already-installed `react-markdown`), and a thin `lib/marketing/*` for nav/CTA/metadata config. The only contact points with the existing app are: replacing the root redirect in `app/page.tsx`, slimming the stale OG metadata in `app/layout.tsx`, and — later, at BETA-1 — one `fetch` to the OPS-1 S10 `POST /api/access-request` endpoint, which is the entire beta-gate seam.

**Recommendation: Option A (in-repo, hard boundary), with extraction insurance measured in hours, not days.** A separate repo or monorepo now would cost deployment plumbing, token duplication, and a second CI surface to buy an isolation the route group already provides.

---

## 2. Current public-surface assessment (verified)

| Fact | Evidence |
|---|---|
| `/` redirects to `/dashboard/brief`; proxy bounces unauthenticated users to `/login`. The login page is the de facto homepage. | `app/page.tsx` (a one-line `redirect()`, comment documents the callbackUrl reasoning) |
| Auth gate covers only `/dashboard/:path*` and `/admin/:path*` | `proxy.ts` `config.matcher` — public routes need **no** proxy changes |
| Route groups in use: `(auth)`, `(brief)`, `(shell)`. `(auth)` has **no layout file** — its pages render directly on the root layout, chrome-free | `find app -name layout.tsx` → root, `(shell)/dashboard`, `(brief)/dashboard/brief`, `admin` only |
| All metadata is centralized in the root layout, and it is stale: `openGraph.url: "https://fintracker.app"`, pre-rebrand `og-image.png` (1536×1024), a code comment flags both as "future enhancement" | `app/layout.tsx` |
| `metadataBase` is already env-driven (`NEXT_PUBLIC_APP_URL`); canonical domain is `fourthmeridian.com` (email sender map, prelaunch audit) | `app/layout.tsx`; `.env.example` line 100 |
| No `robots.ts`, no `sitemap.ts`, nothing indexable anywhere | `find app -name "robots*" -o -name "sitemap*"` → empty |
| Root `viewport` sets `userScalable: false` — acceptable app-ism, an accessibility defect on a marketing page | `app/layout.tsx` |
| Design tokens are CSS variables in `app/globals.css` (549 lines): glass tiers (`--glass-*`, `--glass-filter-*`), dark + light themes, system font stack, and **global `prefers-reduced-motion` and `prefers-reduced-transparency` fallbacks already written** | `app/globals.css` :root blocks, lines 524–549 |
| Every candidate reusable component is a Client Component | `"use client"` at line 1 of `AppLogo.tsx`, `GlassPanel.tsx`, `GlassButton.tsx`, `AtlasLiquidCard.tsx` |
| Security headers apply to **all** routes (`source: "/(.*)"`) incl. CSP report-only with `form-action 'self'`, `img-src … https:` — public pages inherit a correct posture for free | `next.config.ts` |
| Brand assets exist: `logo-full.png`, `fm-mark-{dark,light}.png`, `public/hero/earth-mena.png`, `og-image.png` (stale), PWA manifest + icons | `public/` |
| `react-markdown` + `remark-gfm` are already dependencies | `package.json` |

Net: the app is public-site-*ready*; there is simply no public site.

---

## 3. Recommended folder structure

The proposed assumption holds, with one addition (a dedicated layout) and one clarification (where Home lives):

```
app/(public)/
  layout.tsx          ← public layout: own <main>, own viewport (zoom allowed), nav + footer
  page.tsx            ← Home ("/" — requires deleting app/page.tsx; route groups don't affect URLs)
  security/page.tsx
  about/page.tsx
  request-access/page.tsx        ← static shell now; form activates at S10/BETA-1
  terms/page.tsx
  privacy/page.tsx
  legal/ai/page.tsx
  sitemap.ts? robots.ts?         ← NO — these are app-root conventions; see §12

components/marketing/            ← server-only primitives; zero "use client" unless justified
  Section.tsx  Prose.tsx  MarketingNav.tsx  MarketingFooter.tsx
  Cta.tsx  ScreenshotFrame.tsx  LegalPage.tsx (markdown renderer wrapper)

lib/marketing/
  nav.ts (nav + footer link config)  meta.ts (per-page title/description builder)
  routes.ts (CTA targets: /login, /register, /request-access as named constants)

content/marketing/
  home.ts  security.ts  about.ts  request-access.ts   ← typed plain objects
  legal/terms.md  legal/privacy.md  legal/ai-disclosure.md  ← counsel-editable Markdown
```

**Boundary rules, made checkable:** the repo already uses grep-enforced single-import rules (LLM SDK, Resend SDK, JobRun writer). Apply the same idiom: a source-scan test asserting `app/(public)` + `components/marketing` + `lib/marketing` import nothing from `components/{dashboard,atlas,ui,space,brief,...}`, `lib/{auth,db,prisma,space,data,...}`, or `next-auth`. That converts the boundary from prose to a tripwire — the house style.

---

## 4. Tier-1 page list (build now)

Per PRELAUNCH_AUDIT Part 4, unchanged by this investigation:

1. **Home** (`/`) — hero, honesty section, Spaces, multi-currency, brief, security strip, single CTA → Request Access
2. **Security** (`/security`) — the "why would I connect my bank to you?" page; every claim already true (Plaid, AES-256-GCM, 2FA, sessions, audit log, export/delete)
3. **About** (`/about`) — solo-builder honesty; contact email lives here
4. **Request Access** (`/request-access`) — static explanation + form shell; submission wiring is the S10 seam (§10)
5. **Terms** (`/terms`) — OPS-1 S9 content
6. **Privacy** (`/privacy`) — OPS-1 S9 content
7. **AI disclosure** (`/legal/ai`) — OPS-1 S9; closes STATUS blocker 7

## 5. Deferred page list (explicit)

| Page | Verdict | Reason |
|---|---|---|
| Pricing | **Do not build** | D10 billing ban until v3.0 — a pricing page is fiction (audit Tier 3) |
| Blog | **Do not build** | Empty blog is worse than none; a manifesto ≠ content treadmill |
| Docs | **Do not build** | Product docs before product stability = permanent rewrite |
| Careers | **Do not build** | Solo builder; a careers page would be theater |
| Changelog | **Defer to Tier 2** (first weeks of beta) | Cheap, high-signal; release notes already produced internally |
| Contact | **Defer as a page** | An email address on About + Security satisfies it; no `/contact` route yet |
| Status | **Defer; never in-repo** | Must be hosted off-infrastructure (external monitor + status page service) — an in-app status page fails exactly when needed |
| Manifesto/Philosophy | **Tier 2, soon** | The audit calls it the differentiation page; second CTA target when it exists |

---

## 6. Public/private boundary plan

- **Middleware/proxy:** no change required. The matcher is an allowlist of protected prefixes; `(public)` routes never touch it. Confirmed: public routes cannot accidentally require login.
- **Route groups:** `(public)` follows the `(auth)` precedent (grouped, on root layout) but **adds its own `layout.tsx`** — `(auth)` gets away without one because login/register are single-purpose forms; marketing pages need shared nav/footer, and a group layout is also where the boundary lives.
- **DashboardChrome:** avoided automatically — it's mounted only inside `(shell)/dashboard/layout.tsx`. Nothing to do.
- **Auth redirects:** the only redirect to remove is `app/page.tsx` itself. Trade-off to state honestly: today an authenticated user hitting `/` lands on the Brief; with a static Home they see marketing with a "Log in" link. Do **not** solve this with a server-side session read on Home (violates the no-session rule and forces dynamic rendering). A "Log in / Open app" nav link is the correct, extraction-safe answer; login already honors `callbackUrl`.
- **Static/server-first:** with no session/db access, every `(public)` page prerenders static by default under App Router. The request-access form is the only interactive island (one small client component posting to one API route).
- **Viewport:** the `(public)` layout should export its own `viewport` **without** `userScalable: false` (Next.js resolves viewport at the nearest segment) — zoom must work on a marketing page.
- **CTAs:** `Log in → /login`, `Request access → /request-access`. `/register` should **not** be a public CTA — registration becomes invite-gated at S10 (`BETA_REQUIRE_INVITE`); linking it publicly would advertise a door that's locked. Keep register reachable only via invite emails. Centralize these in `lib/marketing/routes.ts` so extraction is a one-file URL swap.
- **Security headers:** apply globally already; nothing public-specific needed. `form-action 'self'` is compatible with the request-access form posting to the same origin.

## 7. Marketing component boundary

- **What belongs in `components/marketing/`:** layout primitives (Section, Container), Prose (typographic defaults for legal/manifesto), MarketingNav/Footer, Cta (styled anchor), ScreenshotFrame (image + caption + subtle border), LegalPage (markdown wrapper). All Server Components; the request-access form is the single sanctioned `"use client"` file.
- **Wrap or separate?** **Separate, sharing tokens — not components.** Every existing candidate (`GlassPanel`, `GlassButton`, `AtlasLiquidCard`, even `AppLogo`) is `"use client"`, often with hooks (`useAtlasLiquid`, scroll lock). Importing them would (a) ship the Atlas JS runtime to marketing pages, (b) couple marketing to dashboard internals, (c) break static-first. Instead, marketing primitives use the **same CSS variables** (`--glass-*`, `--glass-filter-*`, theme fills) via classes — visual kinship with zero import coupling. The reduced-transparency fallback in `globals.css` even notes "any FUTURE adopter automatically drops the GPU-heavy backdrop-filter" — marketing gets that safety for free.
- **Safely reusable as-is:** `app/globals.css` tokens; `public/` brand assets (use the static PNGs directly rather than the client `AppLogo`); Tailwind config; font stack (system — no font loading work at all).
- **Must not import:** anything under `components/{dashboard,atlas,ui,space,brief,charts,notifications,plaid,settings,security,admin}`; `lib/{auth,db,space,data,ai,plaid,money,...}`; `next-auth`. Enforced by the §3 source-scan test.
- **Logo duplication note:** a tiny static `<MarketingLogo>` (an `<img>` or inline SVG) duplicates ~10 lines of `AppLogo`. Accept the duplication — it's the price of the boundary and trivially cheap.

## 8. Content strategy

- **Page copy: typed plain TS objects** in `content/marketing/*.ts` (headline, subhead, sections, CTA labels). Rationale: type-checked against the components that render it, zero runtime deps, greppable, and extraction = copy the folder. MDX is rejected — it adds a compiler dependency for seven pages of copy that one person edits, and MDX↔component coupling is exactly the kind of soft leak that makes extraction painful. JSON is rejected — no comments, no types.
- **Legal copy: Markdown files** (`content/marketing/legal/*.md`) rendered through one `LegalPage` component using the **already-installed** `react-markdown` + `remark-gfm`. Rationale: counsel (v3.0/L-1) edits prose, not TSX; diffs of legal changes stay readable in review; the renderer is a seam where an "effective date / last updated" stamp is enforced once. The truth-gate from OPS-1 S9 (every claim true on deploy day) is a review checklist, not tooling.
- **Extraction:** `content/` has zero imports in either direction beyond types — it moves anywhere.

## 9. Extraction strategy comparison

| | A. In-repo, hard boundary | B. Separate repo now | C. Monorepo/package | D. Static export later |
|---|---|---|---|---|
| Speed to Tier-1 | **Days** — tokens, assets, headers, deploy all exist | Weeks — new project, token duplication, second deploy, DNS/subpath decisions | Weeks+ — workspace conversion of a repo that isn't one; heaviest option for a solo dev | n/a now (a future move, not a build strategy) |
| Deployment | One Vercel project (exists) | Two projects + domain split (`/` vs app subdomain) or rewrites — the `fourthmeridian.com` root must then proxy | One pipeline, more config | Adds a build artifact hosting question |
| Design consistency | Same `globals.css` tokens — automatic | Copy-paste drift from day one | Shared package solves it at high setup cost | Inherits A |
| SEO | Same domain, root path — best possible | Subdomain/domain-split dilutes; rewrites add complexity | Same as A once wired | Same as A |
| Auth handoff | `/login` is a same-origin link | Cross-origin links; callbackUrl and cookies get subtle | Same as A | Same as A |
| Maintenance (solo) | One repo, one CI, one dependency set | Two of everything | Workspace overhead forever | Low |
| Env vars | Only `NEXT_PUBLIC_APP_URL` (exists); rule: no private vars in `(public)` — enforceable by scan | Duplicate public config | Shared | n/a |
| Team scaling later | Extract when a team exists (see below) | Pre-pays for a team that doesn't exist | Ditto | Escape hatch from A |
| Extraction cost later | **Hours**: folders have no inbound/outbound app imports; swap `routes.ts` URLs to absolute; point the form at the API origin | — | — | D *is* A's exit: `(public)` static-exports cleanly because nothing in it is dynamic |

**Recommendation: A.** It matches the approved direction, and the codebase makes the boundary cheap to keep honest (grep-enforced import rules are already house style). D is noted as the natural exit path if extraction is ever wanted: because everything is static/server-first with one fetch seam, `(public)` can become a static export or a fresh Next app in an afternoon. B and C pre-pay real costs (deploy, drift, workspace plumbing) for isolation the route group already delivers.

## 10. Beta gate seam

The entire coupling between the public site and the app should be **one HTTP contract**:

- `POST /api/access-request` (OPS-1 S10's public, rate-limited endpoint) with `{ email, answer1, answer2 }` → `{ ok }` or a rate-limit error. The request-access page knows this URL (from `lib/marketing/routes.ts`) and the response shape — nothing else.
- Everything behind the endpoint — `AccessRequest`/`InviteToken` tables, admin approval queue, invite emails via `lib/email`, `BETA_REQUIRE_INVITE` gating on register — is app-side S10 work the public site never imports or references.
- Invite emails link to `/register?token=…`; the register page (already app-side, in `(auth)`) consumes the token. The public site never handles tokens.
- Until S10 lands, `/request-access` ships as a static page with the form disabled or a mailto fallback — the page's existence doesn't depend on the substrate.
- Extraction test for the seam: if the site moved to another origin tomorrow, the only change is the fetch URL becoming absolute (plus CORS or a form-POST fallback on the endpoint — an S10-side decision worth one line in its plan).

## 11. Legal page structure

- **Location:** `app/(public)/terms`, `app/(public)/privacy`, `app/(public)/legal/ai` — matching OPS-1 S9's exact routes (S9 named them `/terms`, `/privacy`, `/legal/ai`; keeping its paths keeps the two initiatives complementary, not competing).
- **Content/rendering split:** Markdown in `content/marketing/legal/` + one `LegalPage` renderer (§8). Counsel edits at v3.0 touch only `.md` files.
- **Truth discipline:** S9's gate applies verbatim — every claim true of the deployed system on deploy day. Export and deletion are already real (verified: `/api/user/export`, `/api/user/delete`, settings→data page), so the privacy page can promise them today. The AI disclosure names OpenAI processing + retention posture. No SOC 2 claims, no counsel-reviewed pretense — a short "beta" note and effective date on each page.
- **Register coupling:** the terms-accept checkbox + `acceptedTermsAt` stamp is S9's **app-side** edit to `(auth)/register` — it links to the public pages but is not part of the public module.

## 12. SEO / metadata plan (smallest safe setup)

Current defects: stale `openGraph.url: https://fintracker.app` (flagged in-code), pre-brand OG image, no robots, no sitemap, nothing indexable, one global title for every route.

Smallest correct setup:

1. `app/robots.ts` — allow `/`; disallow `/dashboard`, `/admin`, `/api`; point to sitemap. (App-root convention — this file sits outside `(public)` but is ~10 lines and is legitimately app-level policy.)
2. `app/sitemap.ts` — the seven Tier-1 URLs, built from `lib/marketing/nav.ts` so the list can't drift from the real pages.
3. Root layout metadata **slimmed**: keep `metadataBase` (already env-driven — set `NEXT_PUBLIC_APP_URL=https://fourthmeridian.com` in prod), fix or remove the hardcoded `openGraph.url`, add `title.template: "%s — Fourth Meridian"`.
4. Per-page `export const metadata` in `(public)` pages (title, description, canonical) driven by `lib/marketing/meta.ts`.
5. Regenerate `og-image.png` on current brand (assets exist in `public/`); 1200×630 is the safe standard size.
6. No structured data, no analytics decisions, no hreflang — not needed for seven pages and a private beta.

Dashboard/admin need no `noindex` work: they're behind the login redirect and disallowed in robots.

## 13. Accessibility / performance (public site only)

Most of it is free if built server-first:

- **Semantics:** one `h1` per page, landmark elements (`nav`/`main`/`footer`) in the `(public)` layout, skip link in the layout once.
- **Keyboard:** links and one form — no custom widgets, nothing to trap. Visible focus styles in the marketing CSS.
- **Contrast:** verify marketing text against the dark glass fills once; the token values (`rgba(10,14,23,…)` fills) are high-contrast-friendly but the muted text tones need a one-time check.
- **Reduced motion/transparency:** already handled globally in `globals.css` (verified `prefers-reduced-motion` kill-switch and `prefers-reduced-transparency` filter collapse). The "one motion moment" rule (audit Part 5) rides these for free.
- **Zoom:** the `(public)` layout's own `viewport` export drops `userScalable: false` (§6) — the single biggest a11y fix available.
- **Images:** use `next/image` for the hero and screenshots (`earth-mena.png` is a full-size PNG; the brand PNGs at repo root are 2+ MB and must never ship — the `public/` copies are the servable ones).
- **Bundle:** static pages + zero client components except the form ⇒ near-zero JS. The tripwire that keeps it true is the no-client-imports scan (§3), not a perf budget tool.
- Explicitly out of scope: any app-wide a11y pass (L-1, post-TI, per the 2026-07-08 parallel-workstream investigation).

## 14. Risks

| Risk | Assessment | Mitigation |
|---|---|---|
| Marketing quietly imports app internals | The realistic failure mode — one convenient `AppLogo` import and the boundary is fiction | Source-scan test from day one (house idiom); server-only components make client imports fail loudly anyway |
| Duplicated design system drifts | Real but bounded: duplication is ~5 small primitives + a logo; **tokens** stay single-sourced in `globals.css` | Accept small duplication; never fork the token file |
| Overbuilding | The audit already capped it: ~7 pages; Tier-3 list is explicit | Hold the line on §5's "do not build" verdicts |
| Misleading claims | Product about numeric honesty cannot fake numbers | Audit rules restated: no animated fake numbers, no unbuilt-feature screenshots, real seeded-data screenshots only, no logo walls/testimonials |
| Legal copy risk | Drafted-honest without counsel is a **recorded risk acceptance** for hand-picked beta (OPS-1 S9); counsel review is a v3.0/L-1 launch blocker | Keep the S9 truth-gate checklist; effective dates on pages |
| Extraction becomes hard | Only if the boundary erodes | The scan + the one-fetch seam are the insurance; §9 D is the exit path |
| SEO leaks (private surfaces indexed) | Low: auth redirect + robots disallow | robots.ts as in §12 |
| Beta-gate coupling | The form could grow knowledge of tokens/approval states | Seam = one POST contract (§10); tokens never touch the public module |
| Migration conflicts with TI/OPS | **None** — this work has zero schema. The S10 migration belongs to OPS-1 and was already flagged for train coordination | Nothing to do here |
| `/` behavior change for logged-in users | Authenticated users lose the auto-redirect to Brief | Accepted trade (nav "Log in" honors callbackUrl); do not add session reads to Home |
| Root-file contention | `app/page.tsx` (replace) and `app/layout.tsx` (metadata slim) are shared with the app | Both are small, rarely-touched files; TI touches neither |

## 15. Final recommendation

Build the public site **inside the current repo** as `app/(public)/*` + `components/marketing/*` + `lib/marketing/*` + `content/marketing/*`, exactly per the approved direction, with three refinements to the starting assumption:

1. **Give `(public)` its own layout** (nav, footer, skip link, its own zoom-permitting viewport) rather than riding the root layout the way `(auth)` does.
2. **Share tokens, not components.** The Atlas/UI layer is 100% client components; marketing primitives are new, server-only, and consume the same CSS variables. Accept ~10 lines of logo duplication as the cost of the boundary.
3. **Make the boundary a test, not a rule.** A source-scan check in the existing test runner (the repo's established grep-enforcement idiom) asserting the three marketing folders import nothing from app internals — written before the first page.

The seam to the rest of the launch path stays minimal: legal content slots into S9's routes, the request-access page consumes S10's single endpoint by URL, and TI is never touched — the only shared files are `app/page.tsx` and the root layout's metadata block. Extraction, if ever needed, is hours: the folders have no app imports, the pages are static, and the one dynamic interaction is a fetch whose URL lives in one config file.

Sequenced against the 2026-07-08 parallel-workstream investigation, this slots in as the *how* for its step 4 (BETA-1 Tier-1 marketing surface) and changes none of its ordering.
