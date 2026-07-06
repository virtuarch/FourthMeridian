# OPS-1 S0/S1 — Implementation Proposal (Email Substrate)

**Status:** Proposal — awaiting approval to implement. **No code written yet.**
**Parent plan:** `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md` (this maps to that plan's **Slice 0** + **Slice 1**).
**Doctrine:** additive-first, behavior-neutral substrate before cutover; one chokepoint per capability; provider SDK imported in exactly one file (grep-enforced, like the single-LLM-import rule); no slice depends on an unshipped later slice.

**Scope of this session:** the operational architecture (S0) and transactional email foundation (S1) **only**. Zero production callers. No password reset, verification, invites, or any live email flow. No migrations. No route edits.

---

## 1. Investigation summary (files inspected)

| Area | File(s) | Finding |
|---|---|---|
| Email/provider state | repo-wide grep; `package.json`; `.env.example` | **Clean slate.** No `resend`/`nodemailer`/`sendgrid`/`postmark`, no `sendEmail`, no `lib/email/`. `.env.example:40` mentions emails only in a comment. |
| Reference seam A (single-import) | `lib/ai/provider.ts` | "THE ONLY FILE… THAT MAY IMPORT THE OPENAI SDK." Lazy singleton `getClient()`, fails loud if key absent, `import 'server-only'`. |
| Reference seam B (transport selection) | `lib/rate-limit.ts` | Prod = DB backend, dev/test = in-memory `Map`, env-flag gated, "future swap touches only the store functions." |
| Provider adapter idiom | `lib/providers/plaid/adapter.ts` | Thin object `{ provider, ...fns }`, deliberately un-over-abstracted until a 2nd provider exists. |
| Env pattern | `lib/env.ts` | `_e` snapshot, throwing `req()` getters, `REQUIRED_KEYS` + `validateEnv()`, `isXEnabled` flags. |
| Password-reset remnant | `app/api/auth/forgot-password/route.ts`, `reset-password/route.ts`, `lib/password-reset-token.ts` | Token machinery production-grade; raw `resetUrl` returned only under `NODE_ENV !== "production"` with a "replace with email" TODO. **Slice 2 — out of scope; untouched.** |
| Auth / user model | `prisma/schema.prisma` (User), `lib/session.ts` | Tuple-return `requireUser`/`requireSpaceRole`. No `emailVerified*` field (Slice 3 territory). |
| Invite flow | `app/api/spaces/[id]/invite/route.ts` | Requires already-registered `invitedUserId`; no invite-by-email. Not needed for S0/S1. |
| Events/audit | `lib/events/emit.ts`, `types.ts`, `handlers/` | Typed `DomainEvent` → `AuditLog`, best-effort in-process handlers. Pattern for a future "email-sent" audit action (Slice 2+), **not built now**. |
| Test convention | `scripts/run-tests.ts`, `.github/workflows/ci.yml` | No jest/vitest; each `*.test.ts` is a standalone `tsx` script, inline assertions, exit 0/1. `npm test` runs `prisma generate` first. |

---

## 2. Approved decisions (this session)

1. **`.env.example` scope:** email flags only (`EMAIL_*` / `RESEND_*`). Not the parent plan's full Slice-0 flag pass.
2. **Return contract:** non-throwing `EmailResult`. `sendEmail` never throws into domain logic; the caller inspects the result.
3. **First template:** a generic, non-wired smoke template proving render + transport. No product-meaning template until its consuming slice lands.
4. **Deliverable location:** this document, committed under `docs/initiatives/ops1/`.

---

## 3. Proposed file structure

```
lib/email/
  types.ts          # EmailProvider interface, EmailMessage, EmailResult, EmailTemplateName union
  senders.ts        # sender identity map (purpose -> from/replyTo)
  templates/
    index.ts        # typed registry: name -> render(data) => { subject, text }
    smoke.ts        # generic text-first smoke template (the only concrete template)
  providers/
    resend.ts       # ResendAdapter — the ONLY file importing the `resend` SDK (grep-enforced)
    capture.ts      # dev/test transport: records to an in-memory buffer instead of sending
  send.ts           # EmailService chokepoint: sendEmail(name, to, data): Promise<EmailResult>
  index.ts          # public surface (re-exports sendEmail + types)
  send.test.ts      # tsx: template render + capture-transport + "refuses to send in test mode"
```

**Edits outside `lib/email/`:** only `lib/env.ts` (getters + `isEmailEnabled` flag), `.env.example` (email flags), `package.json` (add `resend`), `STATUS.md` (S0 ledger row). No migrations, no route changes, zero production callers.

**Boundary note (divergence from parent plan's literal wording):** the parent plan names `lib/email/send.ts` as the single SDK import site. Per the standing architecture directive ("Resend must live behind a ResendAdapter only"), the SDK import lives in `lib/email/providers/resend.ts` and `send.ts` stays transport-agnostic. Same intent — one grep-provable import site — cleaner boundary.

---

## 4. Exact minimal scope

### S0 — Operational Architecture (contracts + config)

- **`lib/email/types.ts`**
  - `EmailProvider` interface: `send(msg: EmailMessage): Promise<EmailResult>`.
  - `EmailMessage`: `{ to, from, replyTo?, subject, text }`.
  - `EmailResult` (non-throwing return contract): `{ status: "sent" | "captured" | "skipped" | "error"; id?: string; provider: string; error?: string }`.
  - `EmailTemplateName` union (starts with the single smoke template).
- **`lib/email/senders.ts`** — sender identity map keyed by purpose, per the established conventions:
  - password-reset / email-verification / space-invite / security-alert → `Fourth Meridian <support@fourthmeridian.com>`
  - daily-brief / product-notifications → `Fourth Meridian <notifications@fourthmeridian.com>`
  - beta-invitations / beta-updates → `Fourth Meridian Beta <beta@fourthmeridian.com>`
  - (Map is declared now; only the smoke sender is exercised this session.)
- **`lib/env.ts`** — add optional getters `RESEND_API_KEY`, `EMAIL_FROM_DEFAULT`, and `isEmailEnabled` flag (mirrors `isAiEnabled`). **Not** added to `REQUIRED_KEYS`, so credential-free dev/CI keeps working.
- **`.env.example`** — one-pass add of `RESEND_API_KEY`, `EMAIL_FROM_DEFAULT` placeholders with comments. (Email flags only.)
- **`STATUS.md`** — OPS-1 S0 ledger row.

### S1 — Transactional Email Foundation (pipeline + adapter + one template)

- **`lib/email/providers/resend.ts`** — `ResendAdapter` implementing `EmailProvider`; lazy singleton; **sole `resend` import** (grep-enforced). Returns `{ status: "sent", id, provider: "resend" }` or `{ status: "error", ... }` — never throws.
- **`lib/email/providers/capture.ts`** — dev/test transport implementing `EmailProvider`; records messages to an in-memory buffer; returns `{ status: "captured", provider: "capture" }`.
- **`lib/email/send.ts`** — `sendEmail(name, to, data)`: resolves sender from `senders.ts`, renders template, selects transport (Resend when `RESEND_API_KEY` present and not in test; capture otherwise; **refuses a real send in test mode**), returns `EmailResult`.
- **`lib/email/templates/index.ts` + `templates/smoke.ts`** — typed registry with one generic text-first template.
- **`lib/email/send.test.ts`** — tsx script: (a) template render snapshot, (b) capture-transport records the message, (c) chokepoint refuses to send in test mode.
- **`package.json`** — add `resend` dependency.

### Explicitly excluded (named to prevent creep)

Password reset wiring, email verification, beta invites, deletion/security emails as live flows, HTML framework, any route edits, any migration, newsletters/broadcasts/campaigns/analytics/telemetry/marketing. Deploy is behavior-neutral (zero callers).

---

## 5. Risks / decisions / questions

- **Single-import site location** — moved to the adapter (`providers/resend.ts`) per architecture directive; documented above so the grep rule targets the adapter, not `send.ts`. (Resolved.)
- **Return contract** — non-throwing `EmailResult`, best-effort like the event-handler idiom. (Resolved.)
- **Credential-free CI/dev** — capture transport is default when `RESEND_API_KEY` is absent, so `npm test` and local dev never need secrets. Matches the rate-limit in-memory precedent. (Resolved.)
- **Domain auth** — SPF/DKIM/DMARC already verified on `fourthmeridian.com` and the `send` subdomain (per infra setup), so the adapter can send from the approved identities once wired in a later slice. No action this session.

---

## 6. Validation plan (per house standard, before closeout)

- `npx tsc --noEmit` — green.
- `npm run lint` — green.
- `npm test` — green (new `send.test.ts` included; runs credential-free via capture transport).
- Grep proof: `resend` imported in exactly one file (`lib/email/providers/resend.ts`).
- Grep proof: zero production callers of `sendEmail` (behavior-neutral deploy).

---

## 7. Stop condition

Implementation begins **only on explicit approval**. Slice 2 (real password reset over email) is **not** part of this session and will not be started.
