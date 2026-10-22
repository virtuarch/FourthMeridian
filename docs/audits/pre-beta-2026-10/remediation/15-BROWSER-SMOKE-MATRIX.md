# 15 — Browser smoke-test matrix (Preview, after PR #1 merges)

**Target:** `https://preview-app.fourthmeridian.com` (app) and `https://preview.fourthmeridian.com` (public site), both behind Vercel SSO.

**When:** run after the nine migrations are on Preview (`docs/operations/preview-migration-runbook-beta1.md`) and PR #1 has deployed to the `v2.6` Preview alias. Confirm `/api/health` shows `status: ok` with a `scheduler` block and no `commit`.

**Who:** owner, or a named tester.

**Rules:**
- Record pass/fail and a screenshot per row.
- Stop at the first P1-class failure.

**Accounts needed** (Preview test data only, never real people):
- **T1:** a fresh invitee with no TOTP.
- **T2:** an existing user with TOTP enrolled.
- **ADM:** a system admin with TOTP.
- **T3:** a second member to share a Space with.

**Constraints:**
- **Plaid:** use Plaid **Sandbox** credentials only. Never refresh or sync the two legacy ACTIVE sandbox Items already on Preview. They are owner-verified legacy items and must not be called (`rls-preview-cutover` record).
- **AI:** each AI row makes a real OpenAI call on the Preview key. Keep to the listed turns, about 10 in total. This is not a load test.

Legend: **[R]** = a remediation fix this row proves (finding ID).

## A. Authentication and session

| # | Steps | Expected |
|---|---|---|
| A1 | Open `/login` signed out; sign in as T2 with a wrong password ×1, then correctly | Generic error on the wrong password; TOTP prompt; dashboard after the code |
| A2 | Sign out from the user menu | Lands on `/login`; Back does not show dashboard data (full reload clears client state) |
| A3 | `/forgot-password` for T2, then for a non-existent address | Identical "check your e-mail" response for both (no enumeration) **[R PRIV-002: audit row stores a hash, not the address]** |
| A4 | Follow the reset link; set a new password; reuse the same link | First use succeeds; second is refused **[R IDEMP-013 conditional token write]** |
| A5 | Settings → Security → Active sessions: revoke another session | Row disappears; a failed revoke shows an error (not silence) **[R UI-006 / e7f1144]** |
| A6 | Settings → Data → export | Download contains AI memory and Daily Briefs sections **[R PRIV-006]** |

## B. MFA (TOTP)

| # | Steps | Expected |
|---|---|---|
| B1 | Sign in as T1 (no TOTP) where TOTP is required; try `/dashboard` and `/admin` directly by URL | Redirected to TOTP setup from **both**; no page renders first **[R SEC-001]** |
| B2 | Enrol TOTP: QR shows; enter the code; save recovery codes | Enrolled; dashboard reachable |
| B3 | Sign in with a recovery code; then reuse the same code | First succeeds; reuse refused **[R recovery-code race fix c885008]** |
| B4 | Settings → Security: disable/re-enable TOTP flow (if offered) | Requires current code; state persists after reload |

## C. Registration and invitations

| # | Steps | Expected |
|---|---|---|
| C1 | Open `/register` with no invite | Refused or redirected, because the registration default is `invite_only` **[R SEC-008]**. If Preview has an explicit `open` setting row, record it, since that is an environment decision. |
| C2 | Admin issues an invite to a new address; open the link; register | Account created; verification e-mail sent (Resend on Preview: record **delivered**, not just "captured") **[R OBS-003]** |
| C3 | Verify e-mail via the link; reuse the link | First verifies; second is a no-op or refusal **[R J-D1 emailHash]** |
| C4 | Invite a username that differs only in case | Resolves to the same user **[R J-D3]** |
| C5 | `/request-access` on the app and on the public site | Privacy notice and consent checkbox present; submit is refused without consent **[R PRIV-012]** |

## D. Spaces

| # | Steps | Expected |
|---|---|---|
| D1 | `/dashboard/spaces`: create a Space; switch to it from the header | Switch works; URL and header follow **[R switch route uses requireSpaceRole]** |
| D2 | Invite T3 as Viewer; change role to Editor; remove T3 | Each destructive action shows a confirmation dialog **[R UI-003]**; T3 loses access immediately |
| D3 | Archive the Space, then restore | Confirmation on archive; data intact after restore |
| D4 | Space settings: toggle a section, reorder, rename a section with a very long label | Toggle and order persist; an over-long label is refused with a message **[R J-D5]** |
| D5 | Open each workspace (Overview, Net Worth Total/Assets/Debt, Cash Flow) with the network throttled or a read failing (DevTools → block one `/api/spaces/...` request) | Error state with Retry, never an empty "no data" state **[R UI-006]** |
| D6 | `/dashboard/credit` | 404 (Credit retired); the Debt workspace still saves a credit score **[R Credit retirement]** |

## E. Account connections

| # | Steps | Expected |
|---|---|---|
| E1 | `/dashboard/connections`: connect a **Plaid Sandbox** institution (`user_good` / `pass_good`) | Item connects; accounts appear; first sync completes |
| E2 | Connection menu → Refresh on the new Item | Refresh runs; a failure would show an error toast, not silence **[R e7f1144]** |
| E3 | Add a manual asset (Settings → archived assets / Space add) and a self-custody wallet address (public test address) | Both appear with correct labels; wallet sync shows its state |
| E4 | Disconnect the sandbox Item | Confirmation; Item marked revoked; history retained per the privacy text |

## F. Financial forecasting

| # | Steps | Expected |
|---|---|---|
| F1 | Cash Flow workspace on a Space with payroll | Income reflects all paychecks; a late paycheck shows "incomplete estimate" with a bound, never a silent drop **[R FIN-001]** |
| F2 | Re-categorise a merchant (user correction); reload Cash Flow | Totals move to the corrected category **[R FIN-002]** |
| F3 | Debt workspace: enter an APR and minimum; view payoff | Payoff renders; unknown APR is labelled principal-only |
| F4 | Overview period picker: change the range | Figures and labels follow the range; no console errors |

## G. CSV import

| # | Steps | Expected |
|---|---|---|
| G1 | Import a small CSV (6 rows) into a manual account | 6 rows imported; batch COMPLETED |
| G2 | Import the **same file** again (and, in a second tab, twice at once) | 409 "already imported" pointing at the existing batch. Never 500, never 12 rows **[R IDEMP-001, J-D6]** |
| G3 | Roll back the batch; import the same file again | Rollback removes the rows; re-import is allowed (slot released) |
| G4 | Import a malformed / oversized file | Clear validation message; no PROCESSING batch left behind |

## H. AI tools (real provider calls: about 10 turns total)

| # | Steps | Expected |
|---|---|---|
| H1 | Open the AI page on a Space | Point-of-use disclosure names OpenAI **[R PRIV-011]** |
| H2 | Ask: "What did I spend on groceries last month?" | Answer cites figures consistent with Cash Flow; no long digit runs from descriptors in the shown evidence **[R SEC-AI-005]** |
| H3 | Ask a forecasting question ("When will my debt be paid off at $500/month?") | Tool-backed answer; elapsed time stated |
| H4 | Daily Brief page | Brief renders or explains why not; no repeated retries in the network tab |
| H5 | Operator: AI kill switch ON (Platform → AI policies), ask one question, switch OFF | Refused while ON, with a clear message; works after OFF **[R allowance/kill switch preserved]** |
| H6 | Network tab during one turn | One provider round-trip per tool hop, no retry storm **[R SEC-AI-003]** (server log: `maxRetries: 0`) |

## I. Operator workflows (ADM)

| # | Steps | Expected |
|---|---|---|
| I1 | `/admin` without TOTP in session | Redirected to TOTP **[R SEC-001]** |
| I2 | `/admin/users`, `/admin/audit`: search; open a user | Truncation hint when results are capped **[R f72dc86]**; audit rows show hashed e-mail metadata |
| I3 | `/admin/platform-access`: grant then revoke a platform grant | Works via the admin path (the `db` principal); tenant users still cannot self-grant **[R SEC-014]** |
| I4 | Platform → Growth & Revenue: waitlist, approve a request | Approve once; a double-click does not double-approve **[R IDEMP-011]**; reason is required, none preselected **[R UI-002]** |
| I5 | Platform → Operations / Alerts posture | Posture shows its evaluation age; stale is flagged, not green **[R OBS-001]** |
| I6 | Platform → Policies: edit an AI cost control | Saves; rate limited on its own bucket; read-only users see no write controls **[R UI-021, 948c14e]** |
| I7 | `/merchant-ops`: decide one item | Fixed confirmation message, no internal detail **[R SEC-013]** |

## J. Markets

| # | Steps | Expected |
|---|---|---|
| J1 | Open a Space → sidebar → Markets workspace (and `?view=` deep links to its views) | `WorkspaceComingSoon` state; no broken views or console errors; nothing deleted (owner decision) |

## K. Public site (`preview.fourthmeridian.com`)

| # | Steps | Expected |
|---|---|---|
| K1 | Home, About, Security, Terms, Privacy | 200; no app links that 404 |
| K2 | `/legal/ai` | Lists what is sent to OpenAI (the PRIV-010 draft); **counsel review pending**: note any wording questions |
| K3 | Request access form | Consent checkbox; submission lands in the app's waitlist (I4) |
| K4 | `robots.txt`, `sitemap.xml`, OG image | Present; Preview is `noindex` |
| K5 | Mobile width (≤ 500 px) for K1–K3 | No horizontal scroll; nav usable |

## Record

For each row record: tester, time (UTC), result, screenshot, and any console error. Failures go into `01-FINDINGS-REGISTER.md` as new rows, and a P1-class failure blocks the beta gate (`11` G10).
