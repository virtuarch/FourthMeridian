# OPS-2 — Email-Change "Invalid Link": Evidence-Based Investigation

**Status:** INVESTIGATION ONLY — no code, schema, migration, or STATUS changes.
**Symptom:** user requests an email change, clicks the confirmation link, sees **"Invalid link"** — yet the email has already changed and they can immediately sign in with the new address.
**Directive:** do not assume the scanner hypothesis; prove the root cause from the code; preserve one-click UX if a robust alternative exists.

---

## 1. Complete confirm flow (traced, with state transitions)

**Files:** `app/api/user/email/request/route.ts` → `lib/email/email-change-url.ts` → `lib/email/templates/email-change.ts` → `app/(auth)/confirm-email-change/page.tsx` → `app/api/user/email/confirm/route.ts` → `lib/password-reset-token.ts`.

| # | Stage | What happens | State |
|---|---|---|---|
| 1 | **Request** `POST /api/user/email/request` | Fresh-user + password re-auth; validates new address; uniqueness pre-check | — |
| 2 | **Token create** | `rawToken = crypto.randomBytes(32).hex`; `expiry = now+1h` | raw token in memory |
| 3 | **Store** | `user.update`: `pendingEmail=new`, `emailChangeToken=sha256(rawToken)`, `emailChangeExpiry=+1h` | **token stored (hashed), pending set** |
| 4 | **Email** | `buildEmailChangeUrl(APP_URL, rawToken)` → `…/confirm-email-change?token=<raw>`; **plain-text** email to the NEW address; security-alert to OLD address | link carries the raw token |
| 5 | **Audit** | `EMAIL_CHANGE_REQUESTED` | — |
| 6 | **User opens link** | Browser loads `/confirm-email-change?token=X` (a client component) | page mounts |
| 7 | **Client auto-POST** | `useEffect` on mount → `POST /api/user/email/confirm { token }` (guarded by a `submitted` ref) | **fetch fired on load, no human action** |
| 8 | **Token lookup** | `user.findFirst({ where: { emailChangeToken: sha256(token) } })` | reads by hash |
| 9 | **Guards** | no user / no `pendingEmail` → `invalid`; past TTL → `expired`; address taken → `email_taken` | — |
| 10 | **Swap** | one `user.update`: `email=pendingEmail`, `emailVerifiedAt=now`, **`pendingEmail=null`, `emailChangeToken=null`, `emailChangeExpiry=null`** | **token consumed & cleared** |
| 11 | **Revoke** | `revokeAllUserSessions` | sessions gone |
| 12 | **Audit + response** | `EMAIL_CHANGE_COMPLETED`; returns `{ status:"changed", newEmail }` | — |
| 13 | **Render** | page shows the *last* POST's result: `changed` / `expired` / `email_taken` / `invalid` | — |

**Design intent (route header):** the route is explicitly **non-idempotent** — "a successful swap CLEARS the token, so a second click resolves no user → `invalid`." So *any* second POST with the same token returns "invalid" **by design**.

---

## 2. Token lifecycle

- **Created:** step 2, `crypto.randomBytes(32)` (request route).
- **Hashed:** `hashResetToken` = `createHash("sha256").update(raw).digest("hex")` (`lib/password-reset-token.ts:22`). Raw goes in the email; only the hash is stored.
- **Stored:** step 3, `User.emailChangeToken` (hashed) + `pendingEmail` + `emailChangeExpiry`.
- **Read:** **exactly one place** — `confirm/route.ts:46` (`where: { emailChangeToken: sha256(token) }`).
- **Consumed / deleted:** step 10, same route sets `emailChangeToken=null` (+ `pendingEmail=null`, `emailChangeExpiry=null`) on a successful swap.

**Evidence — no hidden consumer.** `grep emailChangeToken` across `app/` + `lib/` returns **exactly three** hits: written in the request route, read in the confirm route, cleared in the confirm route. Nothing else reads or clears it. There is **no** background job, no login-time consumption, no admin path.

**Could any path consume it before the intended interaction?** Only the confirm route's POST can consume it, and that POST is issued **only** by the confirmation page's mount effect. So the token is consumed by *whoever causes that page's client JavaScript to run* — not necessarily the human.

---

## 3. Client behavior (`confirm-email-change/page.tsx`) — examined line by line

- **Auto-submits?** **Yes.** A `useEffect(() => { … fetch POST … }, [token])` fires on mount with no user interaction (lines 28–54). This is the crux.
- **React Strict Mode?** `next.config.ts` doesn't set `reactStrictMode` (App Router default = on in dev). StrictMode double-invokes effects in **dev only** — but the guard `if (submitted.current) return; submitted.current = true;` is set **synchronously before** the async fetch, on the **same** component instance, so the second invoke returns early. **Only one POST.** Not a cause.
- **Suspense / navigation duplicates?** The effect depends on the **string** `token` (stable for a given URL), not the `useSearchParams()` object, so re-renders don't re-fire; the ref guards anyway. The page is **not** linked internally anywhere (`grep confirm-email-change` in `app/`+`components/` → only the page itself), so there is **no Next.js `<Link>` prefetch** of it. There is **no `middleware.ts`** in the repo, so no redirect/rewrite double-load. Not a cause.
- **Browser refresh?** A refresh (or tab-restore, or re-open) is a **new page load → new component instance → new `submitted=false` → a fresh POST.** The ref only lives for one page load. So a second *load* absolutely fires a second POST → against the now-cleared token → **"invalid."**
- **Race conditions within one load?** None — one POST, one awaited response, one `setStatus`.

**Conclusion:** within a single page load the client is correct and fires exactly one POST. The bug therefore requires the token to have been **consumed by a different page load that executed the JS** before the load the human is looking at.

---

## 4. Email-scanner hypothesis — assessed, not assumed

The mount-POST is consumed only if an agent **executes the page's client JavaScript**. Whether a specific product does that is a property of *that product's infrastructure*, which **is not in this repository** — so it cannot be confirmed from code. Stating each without speculation:

- **Apple Mail Privacy Protection (MPP):** proxies/preloads **remote images in the email body** to defeat open-tracking. It does **not** click links or execute link-target pages. Our email is **plain text with no images**. → **Cannot** trigger our POST.
- **Gmail link checking:** performs URL reputation/safe-browsing checks and may fetch a URL, but does **not** reliably run a page's client-side React and its `useEffect`. → **Unlikely** to trigger.
- **Microsoft Defender Safe Links / Proofpoint URL Defense / Mimecast URL Protect:** do **time-of-click** URL analysis and, for **unknown/low-reputation** URLs, can **"detonate"** the URL in a sandbox that renders pages and *can* execute JavaScript. → **Could** trigger the mount-POST **if** detonation runs and executes our client JS — but this depends on the recipient tenant's policy and the URL's reputation, **not determinable from our code**.

**Honest verdict:** the scanner hypothesis is **plausible for the detonating products and impossible for MPP/most image-proxies**, but **cannot be confirmed from the code alone** — it hinges on the recipient's mail security stack and the URL's reputation, neither of which lives in the repo. Confirming it would require reproducing with the exact provider or inspecting server access logs for a non-browser GET/POST on the confirm endpoint shortly before the user's click.

---

## 5. Alternative root causes, ranked by likelihood

All share the same mechanism — *a second JS-executing load consumed the single-use token first* — and the fix is the same regardless of which occurred. Ranked:

1. **Duplicate load by the mail/redirect chain (most likely, code-independent).** Corporate mail (Outlook/SafeLinks) rewrites the link; clicking hits a SafeLinks endpoint that GET-checks (and for unknown URLs may detonate/execute) the original, **then redirects the browser** to it. If the pre-click check executed our JS, the token is consumed before the browser's own load renders "invalid." Also covers desktop mail clients that pre-open a link via a helper before handing off to the browser.
2. **Scanner detonation (Defender/Proofpoint/Mimecast).** Same mechanism as #1's pre-check; only fires if the product executes JS. Plausible, unconfirmable from code.
3. **User-side double load** — a refresh, a middle-click-then-click, tab restore, or "open twice." Each new load fires a fresh POST; the second sees "invalid." Consistent with the symptom if the first (successful) load was brief/unnoticed.
4. **Stale client state / rendering bug** — **ruled out**: one POST per load, ref-guarded, stable dep, no re-fire.
5. **Token-lookup logic bug** — **ruled out**: single reader, correct hash match, correct guard ordering.
6. **Redirect/middleware double-navigation** — **ruled out**: no `middleware.ts`, no internal prefetch link.
7. **Second hidden consumer** — **ruled out**: only the confirm route touches the token.

---

## 6. Root cause (provable from code)

> **The confirmation is executed as a side effect of *loading the page* (auto-POST on mount) against a strictly single-use, self-clearing token. Any entity that loads the URL and runs its JavaScript — a scanner detonation, a mail/SafeLinks redirect pre-check, or a duplicate/refresh browser load — consumes the token first. The human's actual click then renders the already-spent token as "Invalid link," even though the swap that the earlier load performed has succeeded.**

The design flaw is **"confirm-on-load"**: it makes a security-critical, one-time state transition consumable **without human intent**. The route header even documents the intended defense ("POST-only so GET scanners never burn the token") — but the client **defeats it by auto-POSTing on load**, so the GET/POST split provides no protection.

**Confidence:** **HIGH** that this is the mechanism (auto-POST on mount + single-use self-clearing token + exactly one POST per load + no other consumer → a false "invalid" requires a prior JS-executing load). **LOW / unconfirmable-from-code** as to *which specific agent* did the pre-load (scanner vs redirect vs refresh) — and, importantly, **the fix does not require resolving that.**

---

## 7. Possible fixes

### Option A — require a "Confirm email change" button
Replace the mount-POST with a button; the POST fires only on click. Scanners/redirects/refresh loads don't click buttons.
- **Pros:** bulletproof; trivial; no schema.
- **Cons:** adds a click for **every** legitimate user — degrades the one-click UX the directive asks to preserve; doesn't help a user who *refreshes* the result page (still a second POST if they re-trigger).

### Option B — preserve one-click by making confirmation **idempotent** (recommended)
Make the confirm operation return **success on a repeat** instead of "invalid," so it no longer matters that some earlier load consumed the token first.

**Mechanism (no schema change):** resolve the user by token hash and branch on state rather than presence:
- `pendingEmail` set **and** `email !== pendingEmail` → first confirm: perform the swap, revoke sessions, audit `EMAIL_CHANGE_COMPLETED`. **Do not null the token/pending here** — leave them to expire.
- `email === pendingEmail` (the swap already happened for this token's target) → **idempotent success**: return `"changed"` with no re-swap, no re-revoke, no duplicate audit.
- Past `emailChangeExpiry` → `expired` (unchanged); the lingering columns are cleaned up lazily (on the next email-change request, or a cheap "clear if `email === pendingEmail`" on next login).

Result: **whoever** POSTs first (scanner/redirect/refresh or the human), the human's click **always** lands on `"changed"`. One-click UX is fully preserved and the false "invalid" is eliminated **regardless of the unidentified pre-consumer** — which is exactly why this is robust without resolving §4/§5.

- **Security cost:** the confirmation link stays a **functional no-op** for the remainder of its ≤1h TTL after the swap (re-confirming the same, now-current address changes nothing; sessions already revoked). Negligible — standard idempotency for one-time links.
- **Associated small touch:** the Settings "pending email change" indicator must treat `email === pendingEmail` as **no pending change** (since the columns now linger briefly). One guard.

**Other Option-B techniques considered and rejected:**
- *Intermediate GET landing page with a click* → this is just Option A with extra navigation (still an added click).
- *Nonce/cookie handshake* (set a cookie on page load, require it for the POST) → fragile: a JS-detonating scanner also executes cookie-setting JS, and the user is typically **logged out** in a fresh inbox context, complicating cookie scoping. Adds complexity without closing the JS-execution gap.
- *Human-interaction heuristics* (require a real pointer/keyboard event) → brittle and easily wrong for legitimate assistive/automation users.

---

## 8. Recommendation

**Adopt Option B — idempotent confirmation.**

- **Most likely root cause:** confirm-on-load consuming a single-use, self-clearing token before the human's click (§6). **Confidence: HIGH** for the mechanism; the specific pre-consuming agent is unconfirmable from code and **need not be identified**.
- **Recommended fix:** make the confirm endpoint idempotent (return `"changed"` when the swap already applied for the token's target), and stop clearing the token/pending eagerly — let them expire — with a one-line Settings guard for the pending indicator.
- **Why it's preferable to Option A:** it **preserves the one-click experience** the directive prioritizes, it **fixes the symptom for every candidate cause at once** (scanner, redirect, refresh) without needing to prove which occurred, it requires **no schema change and no extra user click**, and it aligns with the route's original single-token design rather than bolting on a UI step. Option A remains the fallback if the team later prefers absolute simplicity over UX.
- **Optional hardening (not required):** additionally gating the POST behind a click (A) *and* idempotency (B) is belt-and-suspenders, but B alone resolves the reported symptom while keeping one click.

**Validation for the eventual fix (when approved):** unit-test the confirm route's four branches incl. the new idempotent `email === pendingEmail → "changed"` path; simulate the reported sequence (consume once, then POST again with the same token → expect `"changed"`, not `"invalid"`); confirm expired/taken paths unchanged; verify the Settings pending indicator hides when `email === pendingEmail`.

---

**Stopping after the investigation. No implementation, code, schema, migration, or STATUS changes were made.**
