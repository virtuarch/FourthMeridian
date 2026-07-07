# UX-1 — Settings Information Architecture · Investigation

**Date:** 2026-07-07 · investigated against the working tree (`3c54e61`, post OPS-2)
**Status:** Investigation only. No implementation, no code changes, no migrations, no STATUS update.
**Scope:** information architecture, routing, navigation, component reuse for `/dashboard/settings`. Not visual redesign.

---

## 1. Current Settings surface (inventory)

Settings today is a **single flat page**: `app/(shell)/dashboard/settings/page.tsx` (server component, fetches the user row + Space memberships) renders one client component, `components/dashboard/SettingsClient.tsx` (~620 lines), as a single `max-w-2xl` stacked column of `DataCard`s.

| # | Card | Contents | Backing component / API | Origin |
|---|------|----------|-------------------------|--------|
| 1 | **Profile** | Email (read-only), Username, First/Last name, Date of birth, Default reporting currency, Employment status, Primary use case | inline `InlineField` → `PATCH /api/user/profile` | base |
| 2 | **Default Space** | Preferred landing Space picker | `PreferredSpaceCard` → `PATCH /api/user/profile` | base |
| 3 | **Security** | Change password | inline form → `PATCH /api/user/password` | base |
| 4 | **Email Address** | Change email w/ confirmation link | `ChangeEmailForm` (prop: `currentEmail`) | OPS-2 S3a |
| 5 | **Two-Factor Authentication** | TOTP setup / recovery / disable | `TotpSection` (self-fetching, `Suspense`) → `/api/user/totp/*` | base |
| 6 | **Active Sessions** | Signed-in devices, revoke | `ActiveSessions` (self-fetching) → `/api/user/sessions` | OPS-2 S1 |
| 7 | **Security History** | Recent sign-ins / security changes | `SecurityHistory` (self-fetching) → `/api/user/security-history` | OPS-2 S1 |
| 8 | **Data & Archive** | Link out to Archive & Trash | `<Link>` → `/dashboard/settings/archived-assets` | base |
| 9 | **Deactivate Account** | Temporary deactivation | `DeactivateAccountCard` (self-fetching) → `/api/user/deactivate` | OPS-2 S4 |
| 10 | **Delete Account** | 7-day pending deletion; "export first" | `DeleteAccountCard` → `/api/user/delete`, `/api/user/export` | OPS-2 S7b |

Two architectural facts that shape everything below:

- **A nested route under Settings already exists** — `/dashboard/settings/archived-assets` is its own `page.tsx` (server component, own data fetch). Nested routing under Settings is already an established, working pattern, not a new idea.
- **Most security cards are self-contained, self-fetching client components.** Only `ChangeEmailForm` (`currentEmail`) and `PreferredSpaceCard` / the `InlineField`s consume props the page already fetches. `Export` has a working API but **no first-class UI** — it is only reachable as a "download my data first" button inside `DeleteAccountCard`.

### What already feels out of place

- **Profile mixes identity and preferences.** Username / name / DOB / employment / use case are *identity*; reporting currency and Default Space are *preferences*. They sit in the same card / adjacent cards with no boundary.
- **Export is buried.** A completed OPS-2 capability is only reachable through the delete flow.
- **Data & Archive is a link, not a section** — a hint that a sub-page destination is already the natural shape.
- **Four security-adjacent cards** (Security, Email, 2FA, Sessions, History) plus two destructive account cards are already the majority of the page; OPS-3 notifications would push a flat column past usability.

---

## 2. Recommended information architecture

The ticket's proposed hierarchy (Security / Preferences / Data & Privacy / Notifications / Appearance) is **directionally correct but has two gaps**: it drops **Profile** (identity has to live somewhere), and **Appearance has no content today** (there is no theme setting in the tree — theming is CSS-variable driven, not a user setting). Building an empty Appearance shell violates the "don't create empty structure" instinct.

Recommended grouping, reconciled against what actually exists:

```
Settings
├── Profile          identity: email (RO), username, name, DOB, employment, use case
├── Security         password, email change, 2FA, sessions, history, + Danger Zone (deactivate, delete)
├── Preferences      reporting currency, Default Space  (+ future: locale, timezone, dashboard defaults)
├── Data & Privacy   Archive & Trash, Export  (+ future: connected accounts, AI/privacy, data sharing)
└── Notifications    OPS-3 shell — reserved, built with OPS-3, not before
        (Appearance) deferred until a real appearance setting exists
```

Per the ticket's own section 3, **Deactivate and Delete stay on the Security page** (as a "Danger Zone" subsection), which matches how OPS-2 grouped them and avoids inventing a separate Account page.

**Why this over the ticket's five-page cut:** Profile is a real page with real content today; Appearance is not. Shipping Profile + Security + Preferences + Data & Privacy now, reserving Notifications for OPS-3, and deferring Appearance keeps every route non-empty.

---

## 3. Security page — one page or sub-sections?

**One page, internally sectioned.** All seven items (email, password, 2FA, sessions, history, deactivate, delete) are already self-contained cards. Keep them as stacked `DataCard`s on a single `/security` route, with a visual **Danger Zone** grouping for deactivate + delete. No further route nesting is warranted yet — the cards are short and the credential-gated flows benefit from being co-located. If Security later grows (device trust from OPS-2 S8, login policies), *then* revisit splitting sessions/history into a "Sign-in activity" sub-page.

---

## 4. Data & Privacy — today vs roadmap

**Today:** Archive & Trash (move the existing `archived-assets` destination here) and **Export** (promote to a first-class card — the API already exists; only the UI entry point is missing).

**Roadmap (do not build now):** Connected Accounts (Plaid item management), AI / privacy controls, data-sharing toggles, and any future export/deletion formats. These are placeholders — the page exists to give them a home, not to ship empty.

---

## 5. Preferences — today vs roadmap

**Today:** Default reporting currency and Default Space (both already `PATCH /api/user/profile` fields — a clean lift out of the Profile card).

**Roadmap:** Locale, timezone, dashboard defaults, and other per-user preferences. None exist yet; the page is the reserved home so they don't get scattered back into Profile.

---

## 6. Notifications

OPS-3 is formally **"Notifications & Preferences"** in the OPS roadmap (OPS-1 Operational Communications → OPS-2 Account Lifecycle → **OPS-3 Notifications & Preferences** → OPS-4 Background Jobs & Scheduling → OPS-5 Platform Operations). Notification preferences are a distinct, opt-in/opt-out surface that will grow (per-channel, per-event). It **deserves its own page** — do not fold it into Preferences. This investigation only reserves the `/notifications` route; it does **not** design OPS-3.

---

## 7. Navigation model

**Recommendation: nested routes with a lightweight in-section nav — not tabs, not internal state.**

| Model | Fit for Fourth Meridian | Verdict |
|-------|------------------------|---------|
| Flat cards (today) | Doesn't scale past OPS-3 | reject (the problem) |
| Tabs w/ internal client state | One giant client bundle, no deep-linking, loses per-page server fetch | reject |
| **Nested App-Router routes** | Matches the existing `archived-assets` precedent; each page is a server component fetching only what it needs; deep-linkable; self-contained cards move cleanly | **recommend** |

Sidebar/BottomNav need **no change**: `isSettings = path.startsWith("/dashboard/settings")` (Sidebar.tsx) already lights up for every child route. The in-section nav is a new small client component (call it `SettingsNav`) rendered by a shared `settings/layout.tsx`, linking the sub-pages and marking the active one via `usePathname()`.

---

## 8. Routing

Adopt nested routes; keep existing URLs stable.

```
/dashboard/settings                      → hub: redirect to /profile (or a thin overview)
/dashboard/settings/profile              → Profile
/dashboard/settings/security             → Security + Danger Zone
/dashboard/settings/preferences          → Preferences
/dashboard/settings/data                 → Data & Privacy
/dashboard/settings/notifications        → OPS-3 shell (later)
/dashboard/settings/archived-assets      → unchanged (linked from Data & Privacy)
```

Add `settings/layout.tsx` to host `SettingsNav` around all children. `archived-assets` keeps its current path to avoid breaking the existing `<Link>` and any bookmarks; it simply becomes reachable via the Data & Privacy page instead of the flat card.

---

## 9. Component reuse — this is a move, not a rewrite

Reuse is near 1:1. Nothing needs rewriting:

- **Self-fetching cards move verbatim** (zero prop changes): `TotpSection`, `ActiveSessions`, `SecurityHistory`, `DeactivateAccountCard`, `DeleteAccountCard`.
- **Prop-driven pieces move with the data they already receive:** `ChangeEmailForm(currentEmail)`, `PreferredSpaceCard(spaces, …)`, and the `InlineField` profile rows — all fed by the same `/api/user/profile` fetch, just relocated.
- **The password form** is inline JSX in `SettingsClient`; it lifts into the Security page unchanged.
- **APIs unchanged** — every endpoint (`/api/user/profile`, `/password`, `/totp/*`, `/sessions`, `/security-history`, `/deactivate`, `/delete`, `/export`) is untouched.
- **Tests unaffected.** Settings has **no component/page-level tests**; existing tests are lib-level (`lib/security-history.test.ts`, `lib/export/select.test.ts`, `lib/export/csv.test.ts`, `lib/space-nav.test.ts`, email templates). Moving JSX does not touch them.

The only genuinely new code is: one `SettingsNav` component, one `settings/layout.tsx`, per-page `page.tsx` server wrappers, and a shared profile loader (§Risks) to avoid duplicating the user fetch across Profile/Preferences.

---

## 10. Future-roadmap compatibility

- **OPS-3 (Notifications & Preferences):** slots directly into the reserved `/notifications` route and the `Preferences` page. Best-supported case.
- **OPS-4 (Background Jobs & Scheduling):** largely **not** a user-Settings surface — it's platform/cron infrastructure (export async, purge queues, provider-revocation retries per the OPS-2 docs). Any user-visible piece (e.g. "your export is ready") is a Notifications/Data concern, already homed. No new top-level Settings structure required.
- **OPS-5 (Platform Operations):** admin/platform, lives under `/admin`, **not** user Settings. Out of this IA's scope.

Conclusion: the structure scales cleanly through OPS-3 and correctly *declines* to absorb OPS-4/5, which belong to admin/platform surfaces. It will not need re-architecting across the next several phases.

---

## Proposed page hierarchy

```
/dashboard/settings/layout.tsx        ← SettingsNav + shared chrome
  ├── (index)  → redirect → profile
  ├── profile         Profile card
  ├── security        Security · Email · 2FA · Sessions · History · [Danger Zone: Deactivate · Delete]
  ├── preferences     Reporting currency · Default Space
  ├── data            Archive & Trash · Export
  ├── notifications   (OPS-3, later)
  └── archived-assets (unchanged)
```

## Proposed implementation slices

1. **Scaffold** — add `settings/layout.tsx` + `SettingsNav`; add a shared `getSettingsProfile()` loader; index route redirects to `/profile`. Behavior-neutral.
2. **Security page** — move cards 3–7 + 9–10 into `/security` (largest, most self-contained surface; pure relocation).
3. **Profile + Preferences** — split card 1: identity fields → `/profile`; reporting currency + Default Space → `/preferences`.
4. **Data & Privacy** — `/data` fronting the existing `archived-assets` route + a new first-class **Export** card (UI only; API exists).
5. **Notifications shell** — reserve `/notifications`; deliver *with* OPS-3, not before.
6. **Appearance** — deferred until a real setting exists.

## Estimated complexity

**Low–Medium.** No API, schema, or migration changes; no test changes. Work is file moves + one nav component + one layout + per-page server wrappers + one shared loader. The only non-mechanical judgment is where the split lines fall (Profile vs Preferences, Danger Zone placement), all settled above. Git diff is dominated by moved lines, not new logic.

## Risks

- **Duplicated user fetch.** Splitting the single `page.tsx` query across `/profile` and `/preferences` risks two copies of the user read. *Mitigate:* one shared `getSettingsProfile()` loader (App-Router `cache()`-deduped, matching the `getSpaceContext()` pattern already in the dashboard layout).
- **Changed index URL.** `/dashboard/settings` currently *is* the whole page. Making it a hub/redirect changes what that bookmark shows. *Mitigate:* redirect index → `/profile`; keep the URL alive.
- **`archived-assets` link.** Keep its path unchanged so the existing `<Link>` and bookmarks don't break; only its entry point moves to Data & Privacy.
- **Security-critical flows.** Password / email / 2FA must be *relocated only* — no edits to fetch, validation, or CSRF paths. Treat as pure JSX moves and diff carefully.
- **Nav active-state.** Already handled by `startsWith("/dashboard/settings")`; verify Sidebar + BottomNav still highlight on every child (expected: yes, no change).

## Recommended implementation order

Slice 1 (scaffold) → Slice 2 (Security) → Slice 3 (Profile + Preferences) → Slice 4 (Data & Privacy) → Slice 5 (Notifications, with OPS-3). Appearance deferred.

**Verification each slice:** `tsc`/build clean · click-through every moved card against its live API · `grep` confirms no test references the moved component · deep-link + Sidebar/BottomNav active-state check on each new route.

---

*Investigation only — stop here. No implementation begun.*
