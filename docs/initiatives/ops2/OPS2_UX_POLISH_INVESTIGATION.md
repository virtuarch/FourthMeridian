# OPS-2 — UX Polish: Investigation

**Status:** INVESTIGATION — awaiting approval before implementation
**Source:** manual testing notes after S1–S7c. Investigation only; no code changed.
**Scope:** small, contained correctness/UX fixes on top of the shipped OPS-2 surfaces. No new features, no schema.

Confirmed working per the notes (no action): deactivate/reactivate, delete request/cancel, email delivery/appearance.

---

## 1. Findings & root causes

### 1.1 Change-email confirmation shows "invalid" although the email changes and login works — **HIGH**

**Root cause (high confidence): an email link pre-scanner consumes the single-use token before the user clicks.**

The confirm page (`app/(auth)/confirm-email-change/page.tsx`) fires the token-burning `POST /api/user/email/confirm` **automatically on mount** (in a `useEffect`). The route is deliberately **non-idempotent** — a successful swap clears `emailChangeToken`, so any later request with that token resolves no user and returns `status: "invalid"` (route comment lines 13–15).

The page's `submitted` ref only guards a *double-effect within one page load* (React StrictMode). It does **not** guard two *separate* page loads. Corporate/consumer mail security scanners (Outlook SafeLinks, Proofpoint, Mimecast, Gmail) routinely open link URLs and **execute the page JS** before the recipient ever clicks. Sequence:

1. Scanner loads `/confirm-email-change?token=X` → the auto-`useEffect` POSTs → **email swaps successfully**, token cleared, sessions revoked.
2. User clicks the same link → fresh page load, new `submitted=false` → POSTs again → token already gone → **"invalid"** rendered.

Net observable state: email changed (scanner did it), login works with the new address, but the human sees a red "Invalid link." This exactly matches the note.

The route's own header even states the intended protection — *"POST-only, so email prefetchers / link scanners hitting the PAGE (a GET) never burn the token"* — but the client **defeats that protection by auto-POSTing on load**. The GET/POST split only helps if the POST requires a human action.

**Not the cause:** the `submitted` ref (works as intended for StrictMode); Next.js `<Link>` prefetch (the page is reached by full navigation from an email, not a prefetched link); server logic (the swap is correct — that's *why* login works).

### 1.2 Export only discoverable inside Delete Account — **HIGH**

Confirmed. `POST /api/user/export` (S6) has exactly one UI entry point: the "Download my data first" button inside `DeleteAccountCard` (S7b). A user who simply wants their data must open the *delete* flow to find it — poor discoverability and a scary path for a benign action. There is no standalone export affordance in Settings.

### 1.3 Export ZIP always includes `holdings.csv` (and `snapshots.csv`) even when empty; goals not conditional — **MEDIUM**

`lib/export/zip.ts` writes all four tabular CSVs **unconditionally** (lines 27–30). With no holdings, `toHoldingsCsv([])` yields an empty file that still ships in the ZIP, and `manifest.files` (hardcoded in `assemble.ts`) always advertises all six files. Same for `snapshots.csv`. Goals live only in `data.json` (no `goals.csv`) and are always present as `goals: []` when absent — so "include goals only if present" means pruning/omitting empty sections rather than a missing CSV.

Root cause: fixed file list, no emptiness check. This is cosmetic (the export is still correct) but confusing.

### 1.4 Security History shows "unknown on unknown" — **LOW (wording)**

`components/security/SecurityHistory.tsx` line 72 renders `{e.parsed.browser} on {e.parsed.os}`. For any audit event stored without a user-agent (some server-side or older events), `parseUserAgent("")` returns `{browser:"Unknown", os:"Unknown"}` → literally **"Unknown on Unknown"**. The IP line is already conditionally hidden when null, but the device line has no empty-state fallback.

Root cause: no friendly fallback when both UA fields are unknown. Pure presentation.

### 1.5 Mobile untested; some connections load slowly — **OUT OF SCOPE (follow-up)**

These are an untested-surface note and a performance observation, not a diagnosed bug. "Slow connections" likely traces to `getAccountsWithVisibility` issuing per-link follow-up queries and per-Space snapshot/transaction reads, but confirming that needs profiling against real data, and mobile needs a device pass — neither is a small contained fix. Recommend a dedicated perf/mobile pass (OPS-3), not this slice. Flagged, not fixed here.

---

## 2. Suspected root cause for the invalid email-change state (summary)

**Auto-POST-on-mount + single-use non-idempotent token + email link pre-scanners.** The scanner's headless page load consumes the token; the user's real click then hits a spent token and sees "invalid," while the swap the scanner triggered has already succeeded. Fix by requiring an explicit human click to fire the confirm POST (scanners load pages but don't click buttons) — which is also what the route's GET/POST design assumed.

---

## 3. Minimal fix plan

**Fix A — Email-change confirm: gate the POST behind a click (1.1).**
Replace the auto-`useEffect` POST with a "Confirm email change" button that fires the same POST on click. Page still shows the same `changed`/`expired`/`email_taken`/`invalid` results; only the trigger changes. Scanners that load the page (even with JS) won't click, so they can't burn the token. No route/schema change. Keep the `submitted` ref as a within-load double-click guard. (Optional nicety, deferrable: if the visitor is already authenticated and their email already equals the target, show "already changed" instead of "invalid.")

**Fix B — Standalone export affordance (1.2).**
Add a small "Download my data" card/button in `SettingsClient` (its own section, e.g. near Security). It reuses the exact `POST /api/user/export` blob-download logic already in `DeleteAccountCard`. Smallest form: a new `ExportDataCard` component (or extract the ~12-line download handler into a shared helper both cards call, to avoid duplication). No backend change — the S6 route already enforces fresh-user + rate limit + audit.

**Fix C — Omit empty tabular CSVs + honest manifest (1.3).**
In `zip.ts`, add each CSV only when its array is non-empty; build `manifest.files` dynamically from what was actually written (requires passing the file list back, or computing it in `assemble.ts` from the section counts). `transactions.csv`/`accounts.csv` will effectively always be present; `holdings.csv`/`snapshots.csv` appear only with data. For goals (JSON-only), prune empty top-level sections from `data.json` **or** simply document that `[]` = none — recommend the smallest: omit empty CSVs + dynamic `manifest.files`, and leave `data.json` arrays as-is unless you want empty-section pruning (open question below).

**Fix D — Security History fallback wording (1.4).**
In `SecurityHistory.tsx`, compute the device label: if both `browser` and `os` are "Unknown" → render "Unknown device"; if one is known → show the known part; else `"{browser} on {os}"`. Pure copy change, optionally with a tiny helper in `lib/ua-parser.ts` (`formatDevice(parsed)`).

---

## 4. Files likely touched

| Fix | Files |
|---|---|
| A — email confirm click-gate | `app/(auth)/confirm-email-change/page.tsx` (client only) |
| B — standalone export | `components/dashboard/SettingsClient.tsx`; new `components/security/ExportDataCard.tsx` (+ optional shared download helper reused by `DeleteAccountCard.tsx`) |
| C — empty CSVs / manifest | `lib/export/zip.ts`, `lib/export/assemble.ts` (manifest.files); possibly `lib/export/csv.test.ts` |
| D — history wording | `components/security/SecurityHistory.tsx` (+ optional `lib/ua-parser.ts` helper + test) |

No route, schema, migration, cron, or provider changes. All fixes are additive/contained.

---

## 5. Validation plan

- `npx tsc --noEmit`, `npm run lint`, `npm test` green after each fix.
- **A:** manual e2e — load `/confirm-email-change?token=X` and do NOT click → token still valid (no swap); click "Confirm" → `changed`; reload/second click → `invalid` (expected only *after* a real confirm). Simulates the scanner (page load ≠ consume).
- **B:** manual — Settings shows a standalone "Download my data" that returns a valid ZIP; `DeleteAccountCard`'s export still works (if the handler is shared).
- **C:** pure test in `lib/export/csv.test.ts` style — a bundle with empty holdings omits `holdings.csv` and `manifest.files` excludes it; a bundle with holdings includes it; `transactions.csv` round-trip through the importer still passes.
- **D:** pure test — a device-label formatter returns "Unknown device" for empty UA, "{browser} on {os}" otherwise, and the known half when only one side is known.

---

## 6. Priority order

1. **A — email-change confirm click-gate** (HIGH — a security action shows a false failure; erodes trust).
2. **B — standalone export access** (HIGH — GDPR-style data access buried inside a destructive flow).
3. **C — omit empty export CSVs** (MEDIUM — cosmetic correctness).
4. **D — Security History fallback wording** (LOW — copy).
5. **Mobile + slow-connections** (DEFER — separate profiling/QA pass, not this slice).

---

## 7. Open questions

- **Fix C / goals:** omit empty top-level sections from `data.json` too, or keep the stable full schema (empty arrays) and only drop empty *CSV files*? Recommend the latter (smallest, keeps `data.json` schema stable) unless you specifically want `goals` absent when empty.
- **Fix B:** extract the export-download handler into a shared helper (DRY across the two cards) or duplicate the ~12 lines (smaller diff, minor duplication)? Recommend the shared helper.
- **Fix A optional leg:** add the authenticated "already changed" friendly case, or ship just the click-gate? Recommend click-gate only for now.

---

**Stopping here for approval.** No code, schema, or migration changes were made. On approval, recommend implementing in priority order A → B → C → D, each independently shippable, with mobile/perf split into a separate follow-up.
