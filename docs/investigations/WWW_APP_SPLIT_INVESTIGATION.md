# Architectural Investigation — Splitting Fourth Meridian into `www` + `app`

**Type:** Investigation / architecture plan · **Status:** Proposal (documentation only)
**Date:** 2026-07-07 · **Owner of record:** PO1 / Platform
**Scope:** How to eventually separate the product into a public marketing site (`www.fourthmeridian.com`) and the authenticated application (`app.fourthmeridian.com`) **without creating unnecessary work now**.

> This is an investigation, not an implementation. No code, schema, or STATUS changes. The goal is that when we're ready for public launch, the split is a *planned migration*, not a *refactor*.

---

## 0. Grounding — where the codebase is today

Facts that shape the recommendation (verified in the repo):

- **Single Next.js (App Router) app on Vercel**, region `sin1`. Root `app/page.tsx` simply `redirect("/dashboard/brief")` — **there is no public/marketing surface at all today.** The product *is* the app.
- Route groups already segment the app cleanly: `app/(auth)` (login/register/reset/verify), `app/(shell)` + `app/(brief)` (authenticated product), `app/admin`, `app/api`.
- **Auth:** NextAuth v4, JWT strategy, no custom cookie config → **host-only cookies** (no `Domain` attribute). A session set on `app.` is *not* sent to `www.` — which is exactly what we want for a marketing site.
- **Email is already domain-ready:** `lib/email/senders.ts` sends from `@fourthmeridian.com`; SPF/DKIM/DMARC are authenticated on the domain and the `send` subdomain. A **`beta-invite`** sender purpose (`beta@`) and a **`product-notification`** purpose already exist but aren't fully wired — the waitlist/beta program was anticipated.
- **Brand assets** live in `public/` (logos `fm-mark-*`, `logo-*`, `og-image.png`, hero art, icons). **UI primitives** live in `components/ui`; theme in `components/theme`.
- **Trusted base URL** is already env-driven: `NEXT_PUBLIC_APP_URL` (all email links built from it, never the request Host). This is the seam that makes a domain move safe.

**Implication:** the app is architecturally *close* to splittable. The expensive mistake would be building shared-package machinery now for a marketing site that doesn't exist. The cheap, correct path is to keep the app as-is, stand up `www` as a **separate, minimal project**, and share only what genuinely needs sharing.

---

## 1. Executive Summary

Fourth Meridian should split into two **independently deployed Vercel projects on two subdomains**, backed by **two repositories** (public `www`, private `app`), with a **small, deliberately minimal shared layer** (brand tokens + a couple of types) introduced only when a second consumer actually exists. The waitlist gets **its own tables inside the existing app database**, exposed to `www` through a thin, rate-limited public API on `app` — not a second database, and not a schema fork.

The two sites should stay **session-isolated**: `www` is fully anonymous/stateless (great for caching + SEO), and the only "boundary" a user crosses is a plain hyperlink from `www` to `app`'s existing `/login` and `/register`. **No cross-domain session sharing, no shared auth cookie, no duplicated auth logic** — because `www` never authenticates anyone. This is the single most important simplifying decision: it removes the hardest class of risk (cross-subdomain cookies, CSRF surface, session fixation) before it can exist.

The migration is genuinely phased and each phase ships on its own. The recommended sequence defers almost all work: today's app keeps working unchanged through Phase 4; `www` only becomes the apex/marketing destination at Phase 5.

**Bottom line:** cheapest architecture that scales = **two repos, two Vercel projects, two subdomains, shared brand tokens package, waitlist tables in the app DB behind a public API, and a hyperlink (not a session) as the `www → app` boundary.**

---

## 2. Recommended Architecture

```
                 fourthmeridian.com (apex)  ──301──▶  www.fourthmeridian.com
                                                          │
        ┌─────────────────────────────────────────────────┴───────────────┐
        │  www.fourthmeridian.com  (PUBLIC)                                 │
        │  Vercel project: fm-www  ·  repo: fourthmeridian-www (public)     │
        │  Next.js (static/ISR), anonymous, no user session                 │
        │  Landing · Pricing · Blog/Changelog · Careers · Contact ·         │
        │  Security · Privacy · Terms · Status links · Waitlist · SEO       │
        │  "Sign in" / "Join waitlist" are LINKS + one public API call      │
        └───────────────┬───────────────────────────────────┬──────────────┘
                        │ hyperlink (no session)             │ HTTPS fetch
                        ▼                                     ▼
        ┌───────────────────────────────┐      ┌──────────────────────────────┐
        │ app.fourthmeridian.com (PRIVATE)│      │ Public API on app:           │
        │ Vercel project: fm-app          │      │  POST /api/public/waitlist   │
        │ repo: fourthmeridian (private)  │      │  POST /api/public/contact    │
        │ NextAuth · Dashboard · Spaces · │      │  (CORS-allowlisted to www,   │
        │ AI · Plaid · Engine · Settings ·│      │   rate-limited, no auth)     │
        │ Admin · APIs · Prisma · Crons   │      └──────────────┬───────────────┘
        └───────────────┬─────────────────┘                     │
                        │                                        │
                        ▼                                        ▼
                  ┌─────────────────────  Postgres (single DB)  ──────────────────┐
                  │  App tables (User, Space, …)  +  Waitlist tables (isolated)    │
                  └────────────────────────────────────────────────────────────────┘
```

**Principles**
1. **`www` is stateless and anonymous.** No Prisma client with app credentials, no NextAuth, no user cookies. It can be a public repo and aggressively cached/CDN'd.
2. **`app` owns all data and auth.** It already does. The waitlist API is a small, clearly-fenced public surface on `app`.
3. **The boundary is a link, not a session.** `www` links to `app/login`, `app/register`, `app/accept-invite`. Authentication stays in exactly one place.
4. **Share tokens, not runtime.** Brand/design tokens and a handful of shared types can become a package; nothing security-sensitive is shared.

---

## 3. Repository Strategy

**Options considered**
- **Option A — public repo (`www`) + private repo (`app`).**
- **Option B — monorepo (both apps + packages in one repo, e.g. Turborepo).**
- **Option C — shared packages** (a mechanism, not a repo layout — applies within A or B).

**Recommendation: Option A (two repos), with Option C's shared packages published/consumed minimally.** Reasons:

- **Security boundary matches the repo boundary.** `app` contains Plaid integration, encryption, auth, admin, and financial logic — it must stay **private**. A marketing site benefits from being **public** (open-source-friendly, external contributors, transparency). A monorepo forces the whole thing private or risks leaking app internals into a public tree; splitting repos makes the trust boundary physical and unambiguous.
- **Blast radius + CI isolation.** A marketing copy change should never be able to touch the app's build, secrets, or crons. Separate repos give separate CI, separate secret scopes, separate deploy keys by default.
- **`www` and `app` change on totally different cadences and by different people.** Marketing/content moves fast and low-risk; app moves carefully with the release + security checklists. Coupling them in a monorepo taxes both.
- **Monorepo (B) is the right call only if** the two apps end up sharing a *lot* of live runtime code and a single team owns both. Today they share almost nothing at runtime, so a monorepo's tooling overhead (Turborepo, shared build graph, careful public/private boundaries) is pure cost.

**Shared packages (C) done cheaply:** rather than a package registry on day one, start by sharing brand tokens as a tiny versioned package (git submodule or a published `@fourthmeridian/brand` on a private/public npm scope). Promote more into packages only when a *second real consumer* exists (the YAGNI rule below). Two repos do not preclude shared packages; they just make the dependency explicit and versioned.

> **Decision:** **Two repos** (`fourthmeridian-www` public, `fourthmeridian` private). Introduce shared packages lazily.

---

## 4. Shared Code — what becomes shared, what stays app-only

The trap is "share everything." Most of `components/` is deeply app-coupled (charts, Plaid, spaces, dashboard) and must **not** leak into a public marketing repo. Apply a **two-consumer rule**: something becomes a shared package only when both `www` and `app` genuinely need it. Until then, duplication is cheaper than premature abstraction.

**Eventually shared (introduce when the second consumer is real)**
| Candidate | Package (suggested) | Why shared |
|---|---|---|
| Brand assets (logos, mark, OG image, favicon set) | `@fourthmeridian/brand` (assets) | Identical on both; single source prevents drift. Start here. |
| Design tokens (colors, spacing, typography, radii) | `@fourthmeridian/tokens` | Visual consistency between marketing and product. |
| Theme primitives (light/dark palette, Tailwind preset) | `@fourthmeridian/tokens` | Same palette both sides. |
| A few pure types (waitlist DTO, public API request/response shapes, `EmailTemplateName` names) | `@fourthmeridian/contracts` | `www` calls `app`'s public API; shared DTOs prevent contract drift. |
| Generic, dependency-free UI atoms actually reused (Button, Logo, container) | `@fourthmeridian/ui` (only if reused) | Optional; only if the marketing site genuinely re-renders app atoms. |
| Legal/marketing **content** (Privacy, Terms, Security copy) | content, not code | Authored once; both may render. Likely lives in `www`, linked from `app`. |

**Stays app-only (never shared)**
- Everything in `lib/` that touches data or secrets: `lib/auth.ts`, `lib/session*`, `lib/plaid/*`, `lib/plaid/encryption.ts`, `lib/spaces/*`, `lib/account-deletion/*`, `lib/env.ts`, `lib/db.ts`, Prisma client + schema.
- **Email sending** (`lib/email/*`): the *transport and secrets* stay in `app`. If `www` ever needs to trigger a transactional email (e.g. waitlist confirmation), it calls `app`'s public API — it never imports the Resend adapter or `RESEND_API_KEY`.
- All feature components: `components/{dashboard,charts,plaid,space,connections,security,admin,brief,atlas,settings}`.
- Background jobs, admin, financial engine, notifications.

**Email templates — a nuance.** Templates are *content-ish* but their renderers live beside the transport and are typed against app data. Keep template **rendering** in `app`. If `www` needs branded emails, it does so via the `app` public API, so there is one place that owns deliverability, senders (`beta@`, `support@`, `notifications@`), and DMARC alignment.

---

## 5. Waitlist — Database Strategy

The public site **will** need to persist waitlist signups (and probably contact-form submissions). The question is *where*.

**Options**
- **(a) Its own separate database** for `www`.
- **(b) Its own tables inside the existing app Postgres**, written via a public API on `app`.
- **(c) Reuse `User`** with a "pending" flag.

**Recommendation: (b) — dedicated, isolated tables in the app database, written only through `app`'s public API.** `www` itself holds **no database credentials**.

**Why not (a):** a second database doubles ops (backups, migrations, restore testing, monitoring — see the incident runbook), and eventually the waitlist must *converge* with `User` at invite/conversion time. Two databases means a cross-DB join or a sync pipeline at exactly the moment you least want fragility. The waitlist is small; it does not warrant its own datastore.

**Why not (c):** stuffing pre-signup leads into `User` pollutes the authenticated model (every `User` query must now exclude non-users), muddies auth gates, and risks a lead accidentally satisfying a membership/authorization check. Keep unauthenticated leads out of `User`.

**Why (b):** one backup story, one migration story, a clean **`WaitlistEntry` → `User` conversion** at invite time (both rows in the same transaction), and `www` stays credential-free. The isolation is logical (separate tables/namespace), which is sufficient.

**Smallest schema that scales** (illustrative — *not* a migration; schema owner decides final shape):

```
WaitlistEntry
  id
  email                (unique, normalized lowercase)
  status               PENDING | INVITED | CONVERTED | DECLINED | BOUNCED
  emailVerifiedAt      (nullable — double opt-in)
  verificationToken    (hashed, TTL)         ← reuse the app's existing hash-at-rest pattern
  inviteCode           (nullable, unique)    ← issued when moved to INVITED
  invitedAt / convertedAt
  betaWave             (nullable int/label)  ← wave 1, 2, …
  referredByCode       (nullable)            ← referral: another entry's referralCode
  referralCode         (unique)              ← this entry's own shareable code
  utmSource/Medium/Campaign/Content/Term     ← marketing attribution (flat columns, not JSON, for querying)
  createdAt / updatedAt

ContactMessage (optional, same rollout)
  id · email · name · subject · body · handled(bool) · createdAt
```

Notes:
- **Invite codes / referral / attribution / beta waves** are all flat columns on one table — no separate join tables needed at this scale. Add tables only if referral trees or wave management grow real complexity.
- **Email verification** for the waitlist reuses the app's proven token pattern (random token, **stored hashed**, TTL, POST-only consumption) — do not invent a second token scheme.
- **Conversion into `User` later:** at invite acceptance, `app` creates the `User` (+ personal Space, mirroring `register`) and stamps `WaitlistEntry.status=CONVERTED, convertedAt` in the **same transaction**. Referral credit and attribution can be copied onto the new `User` (or an analytics event) at that moment.

> **Decision:** waitlist = **new isolated tables in the app DB**, written exclusively via a rate-limited public API on `app`. `www` never touches Prisma.

---

## 6. Authentication Boundary — how users move `www → app`

**Core decision: `www` does not authenticate. Ever.** It has no NextAuth, no session cookie, no `Domain=.fourthmeridian.com` cookie. This eliminates cross-subdomain cookie complexity and keeps **one** implementation of auth (the current one on `app`).

Flows:

- **Sign in:** `www` renders a "Sign in" link → `https://app.fourthmeridian.com/login`. That's it. `app/login` already exists and works. No logic duplicated.
- **Sign up (post-launch, invite-gated):** `www` "Join the waitlist" → public waitlist API on `app`. When invited, the beta email links to `app/register?invite=<code>` (or `app/accept-invite/<code>`). Registration stays entirely on `app`, reusing today's `register` route + the `WaitlistEntry` conversion.
- **Invite acceptance (existing Space invites):** already identity-gated in-app (invite emails carry **no token**; acceptance happens in `app` after login). Unchanged by the split — `www` isn't involved.
- **Beta onboarding:** beta email (`beta@`, already a sender purpose) → `app/register?invite=<code>`. `app` validates the code against `WaitlistEntry` (status INVITED, unexpired), creates the `User`, marks CONVERTED.

**Why not share a session across `www` and `app`?** Sharing would require a parent-domain cookie (`Domain=.fourthmeridian.com`), which (1) expands CSRF/session surface to the public site, (2) prevents `www` from being fully cached/static, and (3) buys nothing — `www` has no authenticated features. The link-based boundary is strictly simpler and safer. If a future need arises (e.g. "resume where you left off" personalization on `www`), revisit then; do not build it now.

**One small future affordance:** `app/login` can accept `?callbackUrl=` (it already honors callbackUrl via `proxy.ts`) so links from `www` can deep-link post-login. No new mechanism required.

---

## 7. Deployment Strategy

- **Separate Vercel projects:** `fm-www` and `fm-app`. Independent builds, independent rollbacks, independent secret scopes. A marketing deploy cannot break the app.
- **Separate domains/subdomains:**
  - `app.fourthmeridian.com` → `fm-app` (already the de-facto home; formalize the subdomain).
  - `www.fourthmeridian.com` → `fm-www`.
  - **Apex `fourthmeridian.com` → 301 to `www`** (single canonical host for SEO).
- **Environment variable separation:**
  - `fm-app` keeps ALL secrets: `DATABASE_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET`, `RESEND_API_KEY`, Plaid, `RATE_LIMIT_ENABLED`, etc. Update `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` to the `app.` host at cutover.
  - `fm-www` holds **almost nothing** — at most a `NEXT_PUBLIC_APP_URL` (to build links/API calls to `app`) and analytics keys. **No DB URL, no app secrets.** This is a feature: a public repo with no secrets.
  - Add a `PUBLIC_WWW_ORIGIN` to `fm-app` so the waitlist/contact API can CORS-allowlist exactly `https://www.fourthmeridian.com`.
- **Shared CI:** keep pipelines per-repo, but share **conventions**: both run `tsc`, `lint`, `build`; `app` additionally runs the full test suite + the RELEASE checklist gate. If brand tokens become a package, its release triggers a version bump both consume.
- **Branch strategy:** trunk-based per repo (`main` → production, preview deploys on PRs — Vercel default). No shared long-lived branches across repos. Cross-repo contract changes (public API DTOs) are coordinated via the `@fourthmeridian/contracts` version.
- **Secrets management:** secrets live in Vercel project env (per project), never in either repo. Because `www` is credential-free, its being public is safe. Rotate `app` secrets per the incident runbook; `www` has nothing to rotate.

---

## 8. API Ownership

| API / surface | Owner | Auth | Notes |
|---|---|---|---|
| Waitlist signup (`POST /api/public/waitlist`) | **app** (public API) | none + rate-limited + CORS to `www` | writes `WaitlistEntry`; sends double-opt-in email via app transport |
| Waitlist verify (`GET/POST /api/public/waitlist/verify`) | **app** | token | reuses hashed-token pattern |
| Contact form (`POST /api/public/contact`) | **app** (public API) | none + rate-limited + captcha | writes `ContactMessage` / forwards to support |
| Newsletter subscribe | **app** public API *or* 3rd-party (e.g. marketing ESP) | none + rate-limited | if using an ESP, `www` may call it directly with a public key; otherwise app API |
| Authentication (login/register/reset/verify/TOTP) | **app** | app | unchanged; `www` only links to it |
| Financial APIs (accounts, spaces, transactions, Plaid, AI) | **app** | app session | never exposed to `www` |
| Notifications / preferences (OPS-3) | **app** | app session | product-internal |
| Admin / platform ops | **app** | SYSTEM_ADMIN | never exposed to `www` |

**Guardrails for the public API namespace on `app`:** put all unauthenticated public endpoints under a clear prefix (`/api/public/*`), give each a strict rate limit (`limitByIp`), CORS-allowlist only `PUBLIC_WWW_ORIGIN`, add captcha to human-submittable forms, and treat them as a first-class attack surface in `SECURITY_CHECKLIST.md` (they're the only unauthenticated write endpoints).

---

## 9. Migration Roadmap

Each phase is independently deployable and reversible. Nothing here is required until we actually want a public presence; the app keeps working untouched through Phase 4.

**Phase 1 — Current state (today).**
Everything is `app`, root redirects to `/dashboard/brief`, no marketing surface. No work. *(Optionally, low-effort now: reserve the `www` DNS + Vercel project name, and add `PUBLIC_WWW_ORIGIN`/CORS scaffolding thinking to the security checklist so the future public API isn't an afterthought.)*

**Phase 2 — Introduce a public landing page (on `app`, temporarily).**
Stand up a minimal marketing/landing page and a waitlist form *inside the current app repo* at a public route (e.g. move root off the dashboard redirect for logged-out users), OR spin up `fm-www` as a static placeholder on a temp URL. Ship the `WaitlistEntry` tables + `/api/public/waitlist` behind a flag. Independently deployable; app users unaffected. This validates the waitlist end-to-end before any domain move.

**Phase 3 — Create `fm-www` project + move marketing pages.**
Create the `fourthmeridian-www` public repo + `fm-www` Vercel project. Build the real marketing pages (landing, pricing, blog/changelog, careers, contact, security, privacy, terms, status links, SEO). Point it at a preview/staging domain. Extract `@fourthmeridian/brand` (+ tokens) as the first shared package now that a second consumer exists.

**Phase 4 — Move the waitlist to `www`'s UX, backed by `app`'s API.**
`www`'s waitlist/contact forms call `app`'s `/api/public/*` (CORS-allowlisted). Attribution/referral/beta-wave fields wired. Double-opt-in email via app transport. Still no domain cutover — validated on staging.

**Phase 5 — Launch `www` (DNS cutover).**
Point `www.fourthmeridian.com` → `fm-www`; **301 apex → `www`.** Ensure `app.fourthmeridian.com` → `fm-app` and set `NEXTAUTH_URL`/`NEXT_PUBLIC_APP_URL` to the `app.` host. Add sitemaps/robots, canonical tags, OG images. This is the only phase with real SEO/DNS risk — treat as a production release (RELEASE + SECURITY checklists).

**Phase 6 — Retire marketing/landing pages from `app`.**
Remove any temporary marketing routes from the app repo; `app` root cleanly gates to auth/dashboard only. `www` owns all public content. Verify no dead links; add redirects from any old app-hosted marketing paths to `www`.

> Each phase ships alone; you can stop after any phase and be in a consistent state. The app is never blocked by marketing work.

---

## 10. Risks

| Risk | Where | Mitigation |
|---|---|---|
| **SEO** — apex vs www canonicalization, losing link equity, duplicate content between old app pages and new `www` | Phase 5–6 | One canonical host (301 apex→www); canonical tags; sitemap/robots; 301 any retired app marketing paths to `www`; pre-plan metadata/OG (assets already exist: `og-image.png`). |
| **Cookies** — accidental parent-domain (`.fourthmeridian.com`) cookie would expand app's auth surface to `www` | Auth boundary | **Keep cookies host-only (current default).** Never set `Domain=.fourthmeridian.com` on the session cookie. Verify Set-Cookie has no `Domain` after cutover. |
| **Authentication drift/duplication** | Boundary | `www` never authenticates — zero auth code in `www`. One implementation stays on `app`. |
| **Cross-domain issues** — CORS on the public API, mixed-content, link correctness | Public API | Strict CORS allowlist (`PUBLIC_WWW_ORIGIN`); all links from env base, never hardcoded; HTTPS enforced both projects. |
| **Session sharing expectations** | Boundary | Explicitly *no* session sharing. Deep-links use `?callbackUrl=` into `app/login`. Document that `www` is anonymous. |
| **Environment drift** — two projects' env vars diverge; `NEXT_PUBLIC_APP_URL` stale | Deployment | Single source-of-truth doc for each project's env; `app` keeps `validateEnv()`; add `PUBLIC_WWW_ORIGIN` + `NEXT_PUBLIC_APP_URL` to both projects' documented sets. |
| **Deployment complexity** — two repos, two pipelines, cross-repo contracts | Repos/CI | Two repos *reduce* coupling; version the shared DTOs (`@fourthmeridian/contracts`); keep public API backward-compatible. |
| **Shared assets drift** — logos/tokens copied and diverging | Shared code | Extract `@fourthmeridian/brand`/`tokens` at Phase 3; both consume the versioned package rather than copies. |
| **New unauthenticated attack surface** — waitlist/contact are the only public writes | Public API | Rate-limit + captcha + CORS + input validation; add to `SECURITY_CHECKLIST.md` as a tracked surface; email-bombing/abuse controls (mirror existing forgot-password protections). |
| **Waitlist↔User convergence** | Waitlist | Same DB, converted in one transaction at invite acceptance; no cross-DB sync. |

---

## 11. Recommended Implementation Order (when we choose to start)

1. **Reserve + scaffold (cheap, do anytime):** claim `www` DNS, create `fm-www` project name, decide `PUBLIC_WWW_ORIGIN`, note the public-API namespace `/api/public/*` in the security checklist. *(No user-visible change.)*
2. **Waitlist backend first (Phase 2):** `WaitlistEntry` (+ optional `ContactMessage`) tables and `/api/public/waitlist` on `app`, behind a flag, rate-limited. Validate end-to-end with a temporary form.
3. **Stand up `fm-www` repo + project (Phase 3):** marketing pages on a staging domain; extract `@fourthmeridian/brand` + `@fourthmeridian/tokens` (first real second consumer).
4. **Wire `www` → `app` public API (Phase 4):** waitlist/contact UX on `www`, CORS-allowlisted, attribution/referral/wave fields, double-opt-in email via app transport.
5. **Cutover (Phase 5):** DNS — `www` live, apex 301→www, `app.` formalized; update `NEXTAUTH_URL`/`NEXT_PUBLIC_APP_URL`; SEO (sitemap/robots/canonical/OG). Treat as a production release.
6. **Cleanup (Phase 6):** remove temporary marketing routes from `app`; redirect retired paths; final SEO + dead-link sweep.
7. **Post-split hardening:** add the public API surface to the security review cadence; add invite-code conversion tests; document both projects' env in the deploy runbook.

**Guiding rule throughout:** *do the smallest thing that keeps the split a planned migration.* Don't build shared packages before a second consumer exists (wait for Phase 3). Don't split repos before there's a `www` to put in one. Don't add a second database. Don't share a session. Every one of those is a refactor you'd later have to undo.

---

*Investigation only — no code, schema, or STATUS changes. This plan lets the eventual `www`/`app` split proceed phase-by-phase as a deliberate migration rather than a rushed refactor at launch time.*
