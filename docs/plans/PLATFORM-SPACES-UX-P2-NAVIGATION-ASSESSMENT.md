# PLATFORM SPACES UX P2 — NAVIGATION SEPARATION ASSESSMENT

**Status:** PREIMPLEMENTATION / AWAITING OWNER REVIEW · **Date:** 2026-10-15 · **Branch:** v2.6 · **Baseline:** 2f5c54d (+ docs 5721e26) · **Mode:** read-only; no code, schema, config or Production change.

**Owner proposal under assessment:** a global header with `[ Personal Spaces ] [ Platform Spaces ]`; Personal Spaces unchanged (directory, user-created Spaces, dashboards, authorization, isolation); Platform Spaces = the five predefined areas, not user-creatable, provisioned by existing grants; the Platform button visible only to users holding at least one active grant; clicking it opens a directory of authorized Platform Spaces in the Personal directory's design language; never auto-open the last-used Platform Space; no creation UI; separate sidebar contexts; server-side authorization unchanged.

**Evidence tiers:** VERIFIED = read in source at the baseline (file:line) · PROPOSED = design recommendation.

---

## 1. Recommendation in one paragraph

Implement as a **phased combination, starting with a navigation-only refactor** (Option 3, Phase A = Option 1). Phase A adds the two-segment header control (shown only when a server-computed grant count is at least one), a `/dashboard/platform` directory page that reuses the existing HQ card idiom, and bare-area links that touch no cookie and no storage. It needs no server-side authorization change, no new route family, no test rewrites, and leaves every UX P1 navigation pin intact. Phase B (desktop sidebar "Platform context": the Platform list first with a single exit to Personal, primary nav demoted rather than removed) is a contained follow-up. Phase C (a Platform presentation of the mobile bottom bar) is the most-pinned surface in the repository and should wait for a real phone-width verification. A full shell restructuring now would reintroduce, on the platform axis, the either/or sidebar regression UX P1 closed, and would re-rule every mobile and primary-nav pin at once.

---

## 2. Current application shell (VERIFIED)

| Element | Fact | Evidence |
|---|---|---|
| Frame | `SpaceChromeProvider > GlobalHeader > [ContextualNavbar \| main] > BottomNav` (+ one drawer, CreateSpaceModal) | `components/ui/DashboardChrome.tsx:68-106` |
| Chrome props | `DashboardChrome` takes only `children`; no server data reaches the header | `DashboardChrome.tsx:45` |
| Layout | `app/(shell)/dashboard/layout.tsx` is a Server Component that already holds the session | `layout.tsx:23-31,67-71` |
| Header | `AppLogo` (wordmark `hidden sm:inline`) · empty centre `<div className="flex-1" />` · `GlobalActions` (RefreshButton, NotificationBell, UserMenu) | `GlobalHeader.tsx:40-50`; `GlobalActions.tsx:21-29`; `UserMenu.tsx:94-131` |
| Header pins | `flex h-12 items-center` + `border-b` only; **no test pins the centre slot empty** (the file's prose does) | `components/ui/chrome.test.ts:44` |
| Sidebar mode | publish-driven: `space ? SpaceMode : GlobalMode`; `isPlatformSpaceRoute = pathname.startsWith("/dashboard/platform/")` (trailing slash ⇒ a `/dashboard/platform` index is off the axis) | `ContextualNavbar.tsx:129,140-142,265-278` |
| GlobalMode | `PrimaryNav` + `PlatformNav` (grant-filtered, one `/api/spaces` fetch, refires on Space-list events) | `:403-413`, `:153-197` |
| SpaceMode | `PrimaryNav` → Space block → `SectionsNav` (platform axis) → `PlatformNav` (platform axis only) → Leave Space | `:602-719` |
| PlatformNav | eyebrow "Platform", one Shield icon for every area, href `/dashboard/platform/<area>`, exact-match active; order = `ALL_PLATFORM_AREAS`; labels = `Space.name`; no per-area icon exists | `:205-253`; `app/api/spaces/route.ts:93-102`; `lib/platform/policy.ts:57-222` |
| Primary nav | exactly five (Brief · My Space · AI · Spaces · Connections), pinned by four tests; `/dashboard/platform/*` lights nothing; `/dashboard/spaces/*` lights Spaces | `lib/space-nav.ts:85-129`; `lib/space-nav.test.ts:24-36,52` |
| BottomNav | the five, `lg:hidden`, `prefetch={false}`, mounted once in every mode | `BottomNav.tsx:42-72`; pins `chrome.test.ts:73-91`, `site-nav-in-space.test.ts:183-185`, `space-workspace-nav.test.ts:305,383-385`, `lib/space/mount-payload-boundary.test.ts:115-117` |

## 3. Routing (VERIFIED)

| URL | State |
|---|---|
| `/dashboard` | My Space = the active personal Space via `ACTIVE_SPACE_COOKIE` (`lib/space.ts:27-31`), membership re-validated server-side (`:168-202`) |
| `/dashboard/spaces` | the launcher; `/dashboard/spaces/public` is linked (`SpacesClient.tsx:1158`) but has no page |
| `/dashboard/platform/[area]` | the only platform render path; unknown or ungranted area ⇒ `redirect("/dashboard/spaces")` (`[area]/page.tsx:95-97,114-116,137`) |
| `/dashboard/platform` | **no page** ⇒ Next not-found inside the dashboard layout; nothing in `proxy.ts` or `next.config.ts` redirects it |
| `/admin` | SYSTEM_ADMIN only, own layout; SYSTEM_ADMIN never reaches `/dashboard/*` (`proxy.ts:146-153`) |
| `/merchant-ops` | standalone page outside the proxy matcher, self-gated (`app/merchant-ops/page.tsx:30-39`; `proxy.ts:207-220`) |
| Route groups | `app/(shell)/dashboard/layout.tsx` is the only shell layout; new pages under `app/(shell)/dashboard/platform/` are scanned for customer-axis tokens (`lib/platform-surface.test.ts:66-95`) |

A new route family is **not** needed: `app/(shell)/dashboard/platform/page.tsx` slots into the existing layout and proxy matcher and lights no primary destination, which is the right "separate context" signal. `/dashboard/spaces/platform` would light "Spaces" (`lib/space-nav.ts:128`); `/platform/*` would need proxy and layout changes.

## 4. Space directory implementation (VERIFIED)

- `PlatformSpaceGroup` (module-private in `components/dashboard/SpacesClient.tsx:874-921`): eyebrow "Fourth Meridian HQ", `Surface as="li"` cards with an "HQ" badge, the Space name, "Platform area · {access}", an arrow; click = `router.push("/dashboard/platform/<area>")`. Rendered above the personal cards since UX P1 (`:1113-1118`).
- Two row shapes for one list: `PlatformSpaceItem {id,name,area,access}` (`:135-140`) and `/api/spaces` `platform[] {id,name,platformArea,access}` (`app/api/spaces/route.ts:97-109`).
- Server loader `loadPlatformSpaces(userId)` under `withTenantDb`, registry order (`app/(shell)/dashboard/spaces/page.tsx:436-462`); its read sites are pinned by `lib/rls-server-component-authority.test.ts:96-118`.
- Personal cards: `SpaceCard` on `Surface`, active = left accent rail (`:382-430`); `SpacesHeader` = title, manifesto, Create Space CTA (`:937-976`). Tokens: `--text-muted`, `--border-hairline(-strong)`, `--brass-300`, `--meridian-400`, `--radius-sm`, `--dur-base`.

## 5. Selection state and persistence (VERIFIED)

- `ACTIVE_SPACE_COOKIE` holds a personal Space id; Platform Spaces have zero `SpaceMember` rows so the cookie can never resolve to one, and `/api/space/switch` returns 403 for a non-member id (`app/api/space/switch/route.ts:53-59`). `[area]/page.tsx` reads no cookie (`:14-17`).
- **No "last platform area" is stored anywhere** (no storage API, no `last*` key in the platform, space, or chrome code).
- `?workspace=` is URL-only state with the default writing null; SSR resolves it for first paint (`lib/space/use-platform-workspace-navigation.ts:42-65,129-136`; `[area]/page.tsx:88-93`). Launcher cards and `PlatformNav` link to the bare area URL (= Overview).

Directory contract (PROPOSED): no cookie write, no switch call, no storage, bare-area links only; a source-scan pin so auto-open can never creep in.

## 6. Authorization and entitlement (VERIFIED)

- Page gate: known area → session → ACTIVE grant via `hasPlatformAccess` → Space + sections; never 404 (`[area]/page.tsx:95-137`; `lib/platform/policy.ts:315-326`).
- The session JWT carries `role`, not grants (`types/next-auth.d.ts:18,37,45`). The "≥1 grant" fact already exists server-side (`loadPlatformSpaces`) and client-side (`/api/spaces` → `platform.length`). `PlatformGrant.fm_app_sel` is `userId = me`, so a grant count is a self-fact the tenant role can answer (`spaces/page.tsx:417-430`).
- **No server-side authorization change is needed**: the header and the directory are display; `[area]/page.tsx` and `/api/spaces` filtering remain the only authorities.

How the header learns the flag (PROPOSED): a **server prop** — `layout.tsx` runs `withTenantDb(userId, tx => tx.platformGrant.count({ where: { userId, status: "ACTIVE" } }))` in a try/catch (failure ⇒ hidden), passes `hasPlatformGrants` through `DashboardChrome` to `GlobalHeader`. No flicker, no hydration mismatch, no second fetch, one indexed count per layout render. The alternative (a client fetch of `/api/spaces` from the header) doubles the call and, if hoisted into a shared provider, breaks the ONE-fetch pin (`platform-shell.test.ts:264-270`).

## 7. Mobile (VERIFIED)

The header centre is visible at every width (48 px strip; the wordmark hides below `sm`), so the same two-segment control serves phones, icon-only below `sm` via `SegmentedControl` `labelVisibility="activeOnly"` (`components/atlas/SegmentedControl.tsx:33-65`). BottomNav stays the Personal five. Inside a Platform Space the below-`lg` rail already carries the workspaces (UX P1 `railVisibility="belowLg"`). A Platform presentation of BottomNav is the most pinned surface in the repository and is deferred.

## 8. UX P1 touchpoints that must not regress (VERIFIED)

| Touchpoint | Pins |
|---|---|
| `usePlatformWorkspaceNavigation` (no history/popstate outside `useSpaceUrl`, declared intent) | `space-url-authority.test.ts:61-77`; `space-history.test.ts:340-402` |
| `workspaceNav` publishing from the mount contract, one setter, cleared on unmount | `space-workspace-nav.test.ts:278-283`; `space-markets-nav.test.ts:273-279` |
| `railVisibility="belowLg"` once + `mobileOptimized`; `SpaceShell` default byte-identical | `space-workspace-nav.test.ts:286-299` |
| `platform-shell.test.ts`: PlatformNav 0/1/n, no area/name literals, ONE `/api/spaces` fetch, `<PlatformNav` exactly twice, Space-mode gate `onPlatformAxis && <PlatformNav`, `isPlatformSpaceRoute` cases | `:205-284` |
| `PrimaryNav` exactly two mounts, `PRIMARY_NAV.map` once, all five visible inside a Platform Space | `site-nav-in-space.test.ts:140-158`; `chrome.test.ts:80` |
| D2 — no Platform list inside a personal Space's sidebar | `ContextualNavbar.tsx:623-636`; P1 report §3 |

D2 and the proposal are compatible if the Platform door is **header-only**: the sidebar rule stands, the header gains a context switch visible everywhere. The open question is whether the HQ group also stays on `/dashboard/spaces` (dual entry) or moves entirely to the directory.

## 9. Reusable components (VERIFIED)

`SegmentedControl` (options, value, onChange, `labelVisibility`, `touchOptimized`, `aria-label`) for the two-segment switch; `GlassButton`; `Surface`/`Block`/`Figure`; the `PlatformSpaceGroup` card idiom and `SpacesHeader` layout; `Shield` and `Layers` icons.

## 10. Options

### Option 1 — Navigation-only refactor (header switch + directory page; sidebar untouched)

PROPOSED files: `GlobalHeader.tsx` (centre slot → `<PlatformContextSwitch hasGrants />`), new `components/ui/PlatformContextSwitch.tsx` (SegmentedControl, two links `/dashboard/spaces` and `/dashboard/platform`, active by `pathname.startsWith("/dashboard/platform")`), `DashboardChrome.tsx` + `app/(shell)/dashboard/layout.tsx` (grant-count prop, fail-closed), new `app/(shell)/dashboard/platform/page.tsx` (server: session → grants → Spaces via `withTenantDb`, registry order; zero grants ⇒ `redirect("/dashboard/spaces")`), new `components/platform/PlatformSpaceDirectory.tsx` (cards extracted from `PlatformSpaceGroup`, one row shape via a small mapper), `[area]/page.tsx` redirects → `/dashboard/platform`, optional removal of the HQ group from `SpacesClient.tsx:1113-1118` (owner decision).
Tests: none rewritten; add `platform-context-switch.test.ts` (hidden at zero grants, present at one or more, links only to the directory, no storage or cookie) and `platform-directory.test.ts` (0/1/n cards, registry order, no CTA, no switch call); extend `platform-shell.test.ts:281-284` with the index route being off-axis; extend `rls-server-component-authority.test.ts` if `spaces/page.tsx` read sites change.
Server: no authorization change; one new tenant count read in the layout.
Effort: 6–10 agent-hours · Risk: **low**.
Desktop: header gains the control; Platform ⇒ directory of granted HQ cards; sidebar stays GlobalMode on the directory and SpaceMode inside an area. Mobile: same control in the header, icon-only below `sm`; BottomNav unchanged.

### Option 2 — Application-shell restructuring (true dual sidebar contexts)

Everything in Option 1 plus `ContextualNavbar.tsx` (a `navContext` axis: `PlatformGlobalMode` with `PlatformNav` as primary and a "Personal Spaces" exit, no `PrimaryNav`; SpaceMode on the platform axis without `PrimaryNav`), `DashboardChrome.tsx` (context derived from route), `BottomNav.tsx` (platform presentation or hidden on platform routes), `lib/space-nav.ts` (context predicate).
Tests to rewrite: `site-nav-in-space.test.ts` (A/B/D/E/F), `chrome.test.ts:70-91`, `platform-shell.test.ts:271-284`, `space-workspace-nav.test.ts:227,302-305,381-385`, `space-markets-nav.test.ts:273-281`, `mount-payload-boundary.test.ts:112-117`, `lib/space-nav.test.ts:52`.
Effort: 16–30 agent-hours · Risk: **high** — reintroduces the either/or regression UX P1 closed (`site-nav-in-space.test.ts:8-13`), touches the most-pinned mobile surface, and every pin encodes an owner ruling that must be re-ruled.

### Option 3 — Phased (recommended)

- **Phase A = Option 1** now.
- **Phase B** — desktop sidebar Platform context: on `/dashboard/platform` and inside a Platform Space, `PlatformNav` renders first with a single "Personal Spaces" exit row beneath; `PrimaryNav` retained but demoted (keeps the `PrimaryNav`×2 and `PlatformNav`×2 pins intact as a reordering, not a duplication); rewrite only `site-nav-in-space.test.ts:119-128` ordering and `platform-shell.test.ts:275-279` if the gate expression changes. 6–10 agent-hours, medium risk.
- **Phase C (optional, owner-gated)** — BottomNav platform presentation, only after a phone-width verification (P1 report §6 item 6 is still open).

## 11. Regression risks (ranked, VERIFIED pins)

1. Rendering `PrimaryNav` or `PlatformNav` a third time, or hiding `PrimaryNav` on the platform axis (`site-nav-in-space.test.ts:143,157-158`; `chrome.test.ts:80`; `platform-shell.test.ts:271-279`).
2. Moving the `/api/spaces` fetch out of `ContextualNavbar.tsx` (`platform-shell.test.ts:264-270`).
3. Any change to BottomNav list, class or prefetch (four pins, §2).
4. Header state via client fetch ⇒ post-mount pop-in; via server prop ⇒ none.
5. Reusing cookie-based personal switching for platform (403 and wrong context; `switch/route.ts:53-59`).
6. A new page under `app/(shell)/dashboard/platform/` using customer-axis tokens or a wider DB authority (`platform-surface.test.ts:66-95`; `scripts/audit-db-authority.ts:117-157`; `rls-server-component-authority.test.ts:202-215`).
7. `PRIMARY_NAV` must stay exactly five (`lib/space-nav.test.ts:24-36`).
8. Public-site boundary and prototype containment are untouched by every option.

## 12. Decisions requiring owner approval before Phase A

| # | Decision | Recommendation |
|---|---|---|
| N1 | Keep the HQ group on `/dashboard/spaces` (dual entry) or move it entirely to the new directory | move entirely once the header switch exists (one home for Platform Spaces); keep until then |
| N2 | Header flag via server prop (recommended) or client fetch | server prop |
| N3 | Directory route `/dashboard/platform` (recommended) vs `/dashboard/spaces/platform` | `/dashboard/platform` |
| N4 | Phase B now or after Phase A has been reviewed on Preview | after review |
| N5 | Phase C (mobile bottom bar) in scope at all for UX P2 | out of scope until phone-width verification exists |

Side findings (not blocking): `/dashboard/spaces/public` is linked but has no page; `components/ui/UserButton.tsx` is dead code beside `UserMenu.tsx`; `/merchant-ops` sits outside the proxy matcher and relies on its own gate.

*Assessment only. No implementation was started.*
