# UX-1 Phase 2 — Settings Architecture Refinement · Investigation

**Date:** 2026-07-07 · working tree `3c54e61` (post OPS-2)
**Baseline:** `docs/investigations/UX1_SETTINGS_INFORMATION_ARCHITECTURE.md` (Phase 1)
**Status:** Investigation only. No implementation, no code changes, no migrations, no STATUS update.
**Premise (not re-litigated):** nested App-Router routes are the correct architecture; Settings decomposes into multiple pages. This document refines that into the shape we will actually implement after the OPS-2 polish pass and before OPS-3.

This phase **overturns three Phase 1 defaults** on purpose: (1) `Profile` → `Account`; (2) redirect landing → **directory landing page**; (3) one shared `getSettingsProfile()` loader → **per-page loaders**; and it drops the reserved Notifications and Appearance routes. Rationale for each below.

---

## 1. Account instead of Profile

**Adopt `Account`.** "Account settings" is the near-universal label for the identity surface (Google, GitHub, Stripe, Vercel all use it); "Profile" reads as a public-facing persona, which this is not — Fourth Meridian has no social/profile surface. Account better matches user expectation.

**Account contains** the identity fields exactly as listed: username, first name, last name, date of birth, employment status, use case.

**Email — one decision worth naming:** email is identity *display* but email *change* is a credential-gated security action (OPS-2 S3a `ChangeEmailForm` sends a confirmation link). Recommendation: **Account shows email read-only** (users expect to see their address on the account page), and the **editable change-email flow lives on Security** under "Account Security". One editable surface, no duplication. This matches the ticket's own section 2, which lists Email under Security, and its section 1, which omits Email from the Account field list.

---

## 2. Security — single page, internal sections

**Confirmed as the long-term shape.** Keep Security a single route with in-page section dividers, not further routing:

```
Security
  Account Security
    • Password        (inline form → PATCH /api/user/password)
    • Email           (ChangeEmailForm → confirmation-link flow)
    • Two-factor      (TotpSection → /api/user/totp/*)
  ────────────
  Sessions            (ActiveSessions → /api/user/sessions)
  ────────────
  Security History    (SecurityHistory → /api/user/security-history)
  ────────────
  Danger Zone
    • Deactivate      (DeactivateAccountCard → /api/user/deactivate)
    • Delete          (DeleteAccountCard → /api/user/delete, /api/user/export)
```

Why not sub-route Sessions/History: they are short, read-mostly, self-fetching cards; separate routes would add navigation cost for no density relief. The internal-section model holds until Security gains a genuinely heavy surface (e.g. device-trust management from the deferred OPS-2 S8) — at which point Sessions/History/Devices could graduate to `/security/activity`. Not now.

---

## 3. Data & Privacy — does it scale through OPS-5?

**Yes, with one boundary correction.** As the permanent home for user-facing data governance it holds:

- **Today:** Export Data (promote to a first-class card — API exists, only the UI entry is missing today) and Archive & Trash (the existing `archived-assets` destination).
- **Future:** Privacy controls, AI Data controls, Data Sharing consent, future export/deletion formats.

**Boundary correction — Connected Accounts:** connection *management* (linking/relinking/removing Plaid items) already has a home at the existing `/dashboard/connections` tab. Data & Privacy should own the **privacy/consent** view of connected data (what is shared, revoke sharing, what AI may use) — **not** duplicate connection CRUD. If Data & Privacy grew a full "Connected Accounts" manager it would collide with `/dashboard/connections`. Keep the split: *connections* = plumbing, *Data & Privacy* = consent.

With that boundary, the grouping scales cleanly through OPS-5: nothing in OPS-3/4/5 needs a data-governance home outside this page except async-export *status* (see §Future).

---

## 4. Preferences — user preferences only

**Confirmed.** Preferences is the home for per-user preference values, nothing identity- or security-shaped:

- **Today:** Reporting currency (default for new Spaces) and Default Space — both lift cleanly out of the current Profile card (both already `PATCH /api/user/profile`).
- **Future:** Locale, timezone, dashboard defaults, other personal preferences.

Moving reporting currency + Default Space here is the clean cut that resolves the Phase 1 "Profile mixes identity and preferences" smell.

---

## 5. Notifications — omit until OPS-3

**Reverses Phase 1.** Do **not** create a placeholder route. There is no notification preference in the tree today, so `/dashboard/settings/notifications` would be an empty shell — exactly the anti-pattern we apply to Appearance. Notifications arrives *with* OPS-3 ("Notifications & Preferences"), which ships the first preference and the route in the same slice. Until then the directory page simply does not list it. The directory pattern (§7) makes adding it later a one-line insertion, so nothing is lost by waiting.

---

## 6. Appearance — remove entirely

**Confirmed.** No appearance setting exists (theming is CSS-variable driven, not user-configurable). No route, no nav entry, no placeholder. Reintroduce only if/when a real appearance control is built.

---

## 7. Settings landing — directory page, not redirect

**Reverses Phase 1's redirect.** Make `/dashboard/settings` a **directory/index page** that lists each section with a one-line description:

```
Settings — Manage your Fourth Meridian account.
  Account         Manage your personal information.
  Security        Passwords, sessions, two-factor.
  Preferences     Reporting currency and defaults.
  Data & Privacy  Export and archive.
  (Notifications  — appears with OPS-3)
```

Why the directory beats an auto-redirect:

- **Discoverability** — every section is visible at the entry point; a redirect to `/account` hides that Security, Preferences, and Data even exist.
- **Mobile-first fit** — Fourth Meridian is mobile-first with a BottomNav; the native mobile pattern is *menu → drill into section → back*. A directory is that menu. A redirect makes the Settings tab land mid-section, which feels broken on a phone.
- **Stable URL** — `/dashboard/settings` resolves to real content instead of bouncing; better for bookmarks, back-button, and analytics.
- **No redirect edge cases** — nothing to special-case for deep links or the "changed index URL" risk Phase 1 had to mitigate.

**Interaction model:** directory index at the root; each sub-page carries a lightweight "← Settings" back affordance (mobile-first drill-down). A persistent desktop side-rail is an optional progressive enhancement, not required for the first cut — keeping slice 1 free of a complex responsive nav component. Sidebar/BottomNav "Settings" active state already covers all children via `startsWith("/dashboard/settings")`; no change there.

---

## 8. Revised routing

```
/dashboard/settings                 → directory / index page  (NEW shape: menu, not redirect)
/dashboard/settings/account         → Account   (identity)
/dashboard/settings/security        → Security  (Account Security · Sessions · History · Danger Zone)
/dashboard/settings/preferences     → Preferences
/dashboard/settings/data            → Data & Privacy
/dashboard/settings/notifications   → created only when OPS-3 begins
/dashboard/settings/archived-assets → unchanged (existing route; linked from Data & Privacy)
```

This is the correct long-term shape. `archived-assets` keeps its current path so the existing `<Link>` and any bookmarks survive; only its entry point moves under Data & Privacy.

---

## 9. Revised data-loading architecture — per-page loaders

**Reverses Phase 1's single `getSettingsProfile()`.** Adopt per-page loaders in a new `lib/settings/`:

```
lib/settings/
  getAccount()       → { email, username, firstName, lastName, hasDob, employmentStatus, useCase }
  getPreferences()   → { reportingCurrency, spaces[] }      (user row + ACTIVE memberships)
  getSecurityView()  → { email }                            (only what ChangeEmailForm needs as a prop)
  // Data & Privacy needs no server loader today — archived-assets owns its fetch;
  // Export is a client action. Add getDataPrivacy() when a real server read appears.
```

**Why per-page is now correct (and wasn't the concern Phase 1 thought):** Phase 1 feared "splitting the single `page.tsx` query duplicates the user read." That fear assumed the pages share a render pass. Under nested routes **each page is its own request** — Account and Preferences never render together, so there is no shared query to duplicate and no cross-page dedup to engineer. Each page owning exactly its data is both the simpler model and the more scalable one (a new page adds a loader without touching a shared god-loader).

**Where `cache()` still earns its place:** the *only* intra-request overlap is `settings/layout.tsx` (if it reads the user for a header/nav) versus the page's own loader in the same request. Handle that the way the codebase already does it: back the loaders with a `cache()`-wrapped user primitive (mirroring `getSpaceContext = cache(...)` in `lib/space.ts`), so any within-request overlap dedupes automatically. This gives per-page ownership *and* zero duplicate reads, with an established in-repo precedent.

Each `page.tsx` stays a thin server component: call its loader, pass typed props to its client component, `redirect("/login")` on no session (unchanged from today).

---

## 10. Component migration plan (preserve behavior · APIs · tests · minimal diff)

Current source: `components/dashboard/SettingsClient.tsx` (~620 lines) holds the `InlineField` primitive, `PreferredSpaceCard`, and the inline password form; it imports the six self-contained security/2FA components.

**Extract once, then move — do not rewrite:**

| New location | Contents | Source | Change |
|---|---|---|---|
| `components/settings/InlineField.tsx` (+ shared input styles) | `InlineField`, `INPUT_BASE`, `inputStyle` | lifted verbatim from `SettingsClient` | shared primitive; Account + Preferences import it |
| `components/settings/AccountSettings.tsx` | identity `InlineField` rows + read-only email | `SettingsClient` Profile card | JSX move |
| `components/settings/PreferencesSettings.tsx` | reporting-currency `InlineField` + `PreferredSpaceCard` | `SettingsClient` | JSX move |
| `components/settings/SecuritySettings.tsx` | password form + `ChangeEmailForm` + `TotpSection` + `ActiveSessions` + `SecurityHistory` + `DeactivateAccountCard` + `DeleteAccountCard`, sectioned | `SettingsClient` + existing security components | JSX move; **no edits to fetch/validation/CSRF** |
| `components/settings/DataPrivacySettings.tsx` | Archive & Trash link + new first-class Export card | `SettingsClient` Data card + Export UI over existing `/api/user/export` | JSX move + surface Export |
| `components/settings/SettingsDirectory.tsx` | index menu | new (small) | new |

**Untouched:** every API route; `TotpSection`, `ActiveSessions`, `SecurityHistory`, `DeactivateAccountCard`, `DeleteAccountCard`, `ChangeEmailForm`, `PreferredSpaceCard` move verbatim (self-fetching or fed by props the loader already supplies). `archived-assets` route unchanged.

**Tests:** unaffected. Settings has no component/page-level tests; existing coverage is lib-level (`lib/security-history.test.ts`, `lib/export/*`, `lib/space-nav.test.ts`, email templates). Extracting `InlineField` and moving JSX touches none of them. `SettingsClient.tsx` is deleted only after every card is rehomed.

---

## 11. Implementation slices

1. **Scaffold** — add `settings/layout.tsx` (back-aware chrome) + `SettingsDirectory` index page; extract `InlineField`/shared styles to `components/settings/`; add `lib/settings/` loaders backed by a `cache()`-wrapped user primitive. Old flat page still serves until sections move. Behavior-neutral.
2. **Account** — `/account` page + `AccountSettings`; move identity fields out of `SettingsClient`.
3. **Preferences** — `/preferences` page + `PreferencesSettings`; move reporting currency + Default Space.
4. **Security** — `/security` page + `SecuritySettings`; move password/email/2FA/sessions/history + Danger Zone (largest surface; pure relocation).
5. **Data & Privacy** — `/data` page + `DataPrivacySettings`; front the existing `archived-assets` route and surface Export as a first-class card.
6. **Cutover** — replace `/dashboard/settings/page.tsx` with the directory index; delete `SettingsClient.tsx`.
7. **Notifications** — not in this initiative; ships with OPS-3.

Each slice is independently shippable: sections already moved render on their new route; sections not yet moved keep rendering on the old flat page until slice 6 flips the index.

---

## 12. Estimated complexity

**Low.** No API, schema, migration, or test changes. Work is: extract one primitive, move JSX into five client components + five thin server pages, add per-page loaders, build one directory page. Git diff is dominated by moved lines. The only genuinely new UI is the directory index and the first-class Export card (over an API that already exists).

---

## 13. Risks

- **Two email surfaces.** Account (read-only display) vs Security (editable). *Mitigate:* single editable flow on Security; Account email is display-only, no second form.
- **`InlineField` extraction fidelity.** It carries local save/flash/error state and keyboard handlers. *Mitigate:* lift verbatim into `components/settings/InlineField.tsx`; no logic edits; diff the extracted file against the original block.
- **Security-critical relocation.** Password / email / 2FA must move as pure JSX — no touch to fetch, validation, or CSRF paths.
- **Directory landing changes what `/settings` renders.** Intended, and safer than Phase 1's redirect (no bounce to break); verify BottomNav/Sidebar active-state still lights on the index and every child (`startsWith` covers it).
- **`archived-assets` path stability.** Keep the URL; only its entry point moves.
- **Connected-Accounts overlap (future).** Don't let Data & Privacy duplicate `/dashboard/connections`; scope it to consent/privacy. Recorded here so a later slice doesn't drift.

---

## 14. Future compatibility & likely new sections

- **OPS-3 (Notifications & Preferences):** adds `/notifications` (route + first preference in one slice) and possibly notification-shaped entries on Preferences. Directory gains one line. Clean fit.
- **OPS-4 (Background Jobs & Scheduling):** infrastructure, not a user section. Its one user-visible artifact — async "your export is ready" — is a **notification**, and any export *status/history* list belongs on the existing **Data & Privacy** page. No new top-level section.
- **OPS-5 (Platform Operations):** admin/platform under `/admin`; not user Settings.

**Will any additional Settings section become necessary?** Only one is even plausible on the current roadmap: **Notifications** (OPS-3), already planned. Beyond the roadmap, the two candidates a consumer product typically grows — **Integrations/Connected Accounts** and **Billing/Plan** — are either already served (`/dashboard/connections`) or not on the roadmap. The directory-page IA absorbs any of them as a single new entry without restructuring, which is the point of choosing it.

---

## Summary of changes from Phase 1

| Decision | Phase 1 | Phase 2 (final) |
|---|---|---|
| Identity page name | Profile | **Account** |
| Landing | redirect → /profile | **Directory page** |
| Data loading | one shared `getSettingsProfile()` | **per-page loaders** in `lib/settings/`, `cache()`-backed |
| Notifications | reserved empty route | **omitted until OPS-3** |
| Appearance | deferred (mentioned) | **removed entirely** |
| Security | one page, sections | **unchanged — confirmed** |
| Preferences / Data & Privacy | as proposed | **confirmed, with Connected-Accounts boundary** |

## Recommended implementation order

Scaffold → Account → Preferences → Security → Data & Privacy → Cutover (directory + delete `SettingsClient`). Notifications ships with OPS-3; Appearance not built.

**Verification each slice:** `tsc`/build clean · click-through every moved card against its live API · `grep` confirms no test references a moved component · deep-link + BottomNav/Sidebar active-state on each new route · confirm `archived-assets` link still resolves.

---

*Investigation only — stop here. No implementation begun.*
