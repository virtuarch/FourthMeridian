# Communications Center: API Contract v1.1 DELTA — Phase B + editable content + AI-assisted authoring (2026-10-31)

**Status.** **v1.1 — approved by Session 2 (2026-10-31) with D1–D6 applied.** Session 1 owns this contract and the infrastructure; Session 2 owns the Customer Success UI. **This document designs no UI.**

**Session 2 review changes applied (2026-10-31):**
- **D1:** the GLOBAL Cost Freeze is `platform_cost_frozen`, read through `readGlobalCostFreeze()`. It is not the Beta group's `costFrozen` (§4.5, §6.5).
- **D2:** a server-computed `viewer` block (§1.1, on §2.1, §3.2 and §6.2).
- **D3:** `POST /catalog/[key]/render` for unsaved content (§3.8).
- **D4:** an `ai` availability block on the versions list (§3.2).
- **D5:** the two optimistic tokens and the 409 `CONFLICT` body (§0.3).
- **D6:** test-send eligibility on `viewer`; `divergesFrom` on `CatalogDetail`; publish returns `revision` (§1.1, §2.1, §3.4, §6.9).

**v1.1.1 (2026-10-31, additive; requested by Session 2's UI).** Nothing existing changes shape or meaning.
1. **`CODE_DEFAULT_VERSION_ID = "code-default"`** is exported from the client-safe `lib/notifications/content/types.ts`. It is the sentinel `[id]` for "the code default" (§3.5 rollback, `restoredFromVersionId`). The server's `CODE_DEFAULT_ID` is this same constant.
2. **Per-block limits on `limits`** (§3.2): `heading`, `greeting`, `infoTitle`, `infoItems` (count) and `infoItem` (characters), next to the existing five. Values are the §2.2 numbers (EMAIL 120 / 120 / 120 / 8 / 200); **`null` on IN_APP**, where hero and info blocks are not allowed (as `preheader`). They are the same numbers `validateContent` enforces: a breach is `FIELD_TOO_LONG` located at `{ field: "block", blockIndex, prop: "heading" | "greeting" | "title" | "items", itemIndex? }`, or `TOO_MANY_ITEMS` at `prop: "items"`. `greeting` now has its own limit (it was `heading`'s; the value is unchanged). The fields are optional in the TS type for compatibility, and the server always sends them.
3. **`viewer.rollbackUnavailableReason?: "NO_PERMISSION" | "NOTHING_TO_RESTORE"`** (§1.1). `canRollback: boolean` is unchanged. The reason is absent when `canRollback` is true. `NO_PERMISSION` means the operator lacks CS CONTROL or the leg is not content-editable (`locked` says which). `NOTHING_TO_RESTORE` means the operator is permitted but the stream has never had a published version. Permission is reported first.

**v1.1.2 (2026-11-01) — OWNER RULING N10 (separation of duties) and Preview-only activation.**
1. **Ruling (owner, 2026-11-01), verbatim intent:** a single System Admin **MAY** both approve and activate the same automation. This is the intended policy for the current operating model. There is **no** self-approval restriction and **no** two-person requirement. The controls that make this acceptable are all in force and tested:
   - activation needs CS **CONTROL** (`requireFreshPlatformAccess("CUSTOMER_SUCCESS", "CONTROL")`; a System Admin satisfies it through the SYSTEM_ADMIN authority, which the `DISABLE_SYSTEM_ADMIN` kill switch and pending-TOTP enrolment close);
   - **fresh authentication**: both the activation guard and the approval guard (`requireFreshSystemAdmin`) re-verify the session against the database on the request (revocation, role and TOTP-setup state), never the 30 s cache;
   - the owner approval is bound to the **exact** automation version and definition version (any PATCH or code change voids it; activation refuses a stale `expectedVersion`);
   - activation needs a **documented reason**, audited in the same transaction (`COMMS_AUTOMATION_ACTIVATED`); approval, pause, disable and every change are audited with their reason; an activation refused by the closed gate is audited too (`COMMS_AUTOMATION_ACTIVATION_REFUSED`, result `REFUSED`);
   - the non-production recipient allowlist, the storm limit and per-definition frequency caps, the global Cost Freeze (fail closed), platform admission, and the error-rate and global circuit breakers all stay enforced.
2. **Revisit trigger:** revisit separation of duties when Fourth Meridian has **multiple administrative operators**.
3. **Production automations remain OFF.** Activation is open only on Vercel **Preview** with `COMMS_AUTOMATIONS_PREVIEW_ENABLED="true"` (`automationActivationEnabled`, `lib/notifications/automations/types.ts`). `VERCEL_ENV="production"` is closed whatever any variable says; no flag opens it. The closed-gate code is unchanged: `ACTIVATION_DISABLED_PENDING_HARDENING` (409, `viewer.activationDisabledReason`, job `skipReason`); only its operator text changed.

**What this is.** A **delta** on `docs/plans/COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md` (cited as **v1 §n**), including its v1.0.1–v1.0.3 notes. v1.0.3 was read from `origin/feat/comms-a2b-policy` (PR #177, not yet merged into `develop`). Whatever this delta does not restate, v1 still governs: vocabulary, list and series conventions, the PII rule, the delivery vocabulary, the mutation envelope and the read APIs. Where the two disagree, **this delta wins**, and every such override is listed in §0.2.

**Basis.**
- Worktree `/Users/chrstn/dev/FM-commsdoc`, branch `docs/comms-contract-v1.1`, cut from `origin/develop` `61ba9a5`. PR #177 files were read with `git show origin/feat/comms-a2b-policy:<path>`.
- Static reading only: no database, no network beyond the `git fetch` the brief asked for, no build and no tests.
- Code citations are `file:line` against `61ba9a5` unless they are marked `#177`.
- Everything new here is **PROPOSED**. There is no migration and no route yet.

**Owner requirements** (2026-10-31) are binding and are applied throughout. Session 2's five requested shapes are §2.6 (version DTO), §2.5 (per-block placeholder errors), §3.7 (`?versionId=` preview), §4.5 (UNAVAILABLE reasons) and §3.1 (409 `PROTECTED`).

---

## 0. What changes

### 0.1 Owner requirements → where they are met

| Requirement | Where |
|---|---|
| Draft → preview → publish; publishing needs CS **CONTROL**, a reason and an audit row in the same transaction | §3.4 |
| Immutable versions with rollback | §2.6, §3.5, §8.1 (content columns have no UPDATE grant) |
| Fixed brand layout: logo, footer and legal locked | §5.1 |
| Closed placeholder allowlist per template, escaped server-side | §2.3, §2.4, §5.2 |
| Security and ceremony templates locked; 409 `PROTECTED` on every write | §2.1, §3.1 |
| AI: the operator writes the draft; the AI rewrites it or checks grammar and tone; side-by-side diff; accept, edit or discard | §4.1–§4.3 |
| AI never publishes and never overwrites the draft | §4.1 (the suggestion is a separate row; a version's content is immutable) |
| Only template text and placeholder names go to the AI | §4.2 |
| Server checks that placeholders are preserved and that no links, financial claims or advice were added | §4.4 |
| Kill switch, allowance and Cost Freeze respected; typed UNAVAILABLE reasons | §4.5, §4.6 |
| Manual editing always works | §4.7 |
| The draft → suggestion → publish chain is audited | §4.8 |
| Automations only from the approved typed trigger catalog; no arbitrary code | v1 §5.1–§5.3 (unchanged), §7 |
| Activation needs CONTROL (O-1) | §6.3 |
| C5 lifecycle guard per recipient through `getBetaLifecycleStatesForUsers`; global Cost Freeze halts runs | §6.5 |
| Re-evaluate before a delayed send | §6.6 |
| Dedupe, idempotency, retry and the 5/hour storm limit (#177); loop and storm prevention | §6.6, §6.7 |
| Dry run | §6.8 |
| Test send only to the operator's own address, and outside Production only when it is on the non-prod allowlist | §6.9 |
| No broadcast or marketing in v1 | §6.3 |
| No new customer-facing automation is ACTIVE without explicit owner approval | §6.4 (`ownerApprovedVersion` gate) |

### 0.2 Overrides of v1 (explicit)

| v1 text | v1.1 |
|---|---|
| O-11: operator copy is "code-only"; no free-text bodies in the DB (v1 §4.10, §5.3) | **Superseded by the owner.** Operators edit the content of editable legs through versions (§2, §3). Automations still carry no copy: an automation sends whatever content is live for its target (§6.2) |
| v1 §2 `editable` means "an automation may target it" | Kept, and renamed in prose to *automatable*. Content editing is a **separate** per-leg flag, `contentEditable` (§2.1). Both appear on the DTO |
| v1.0.1: a non-ENABLED definition carries only `PREVIEW`, `VIEW_DELIVERY` and `LINK_OUT` | A **BUILD** definition may also carry `EDIT_CONTENT`, `AI_SUGGEST`, `TEST_SEND` and `AUTOMATE`, so content and a DRAFT automation can be ready before the emitter ships. Activation still needs an AVAILABLE trigger (§6.3) |
| v1 §5.4: a delayed send is persisted as `CommsDelivery{status:"SCHEDULED", notBefore}` | `CommsDelivery` is append-only, one row per attempt (v1.0.2), so it cannot hold mutable schedule state or a unique idempotency key. **`AutomationRunItem` is the claim and schedule row** (§8.4). The ledger receives rows only when an attempt happens or a scheduled item is cancelled |
| v1 §6.1 `idempotencyKey @unique` on `CommsDelivery` | Moved to `AutomationRunItem.idempotencyKey @unique` |
| v1 §5.6.1 matrix: SERVICE via an automation fails closed on UNKNOWN; AWARENESS from registry producers sends on UNKNOWN | **Owner rule:** SERVICE about the recipient's own data **always** sends; AWARENESS is suppressed on PAUSED, ENDED, COST_FREEZE **and UNKNOWN** (§6.5) |
| O-16: the per-recipient wrapper is Session 2's choice | **Resolved.** `getBetaLifecycleStatesForUsers` exists (`lib/entitlements/beta-lifecycle.ts:80`) and needs no billable operation (§6.5) |
| O-3: SELF, or SELF plus an allowlist entry | **SELF only.** The `ALLOWLIST` recipient kind is withdrawn (§6.9) |
| v1 §3.5: every POST carries a required reason | Reason is **optional** on draft save and `ai-suggest`. It is still audited (§9.2). It is required on publish, rollback, owner approval, activation and test send |

### 0.3 Two optimistic tokens (D5)

Content and automations use **different tokens**. They are never interchangeable.

| Resource | Read field | Write field | Bumped by |
|---|---|---|---|
| Content stream (`CommsTemplate`) | `revision` | `expectedRevision` | draft save, publish, rollback |
| Automation (`AutomationDefinition`) | `version` | `expectedVersion` | create, PATCH, state transitions |

A stale token in either is **409 `{ error, code: "CONFLICT", current: number }`**. `current` is the server's present `revision` or `version`, and nothing is written. A version DTO's `version` field is the version **number** inside the stream, not a token.

---

## 1. Vocabulary additions (PROPOSED)

```ts
/** Channels whose content an operator may edit. BANNER and OPERATOR_EMAIL are never editable. */
type EditableChannel = "EMAIL" | "IN_APP";

/** The content stream: one per (definition, channel, variant). "default" unless the leg has code variants (§2.1). */
interface ContentStreamRef { definitionKey: string; channel: EditableChannel; variant: string }

type VersionState = "DRAFT" | "PUBLISHED" | "SUPERSEDED";

/** Who produced a version's content. */
type VersionCreatedByKind =
  | "OPERATOR"       // typed by the operator
  | "AI_ASSISTED"    // saved from an accepted AI suggestion, possibly edited afterwards (aiEditedAfterAccept)
  | "ROLLBACK";      // a server-made copy of an earlier published version (§3.5)

type SupportedAction = /* v1 */ "PREVIEW" | "TEST_SEND" | "VIEW_DELIVERY" | "AUTOMATE" | "PAUSE_AUTOMATION"
  | "ACTIVATE_AUTOMATION" | "LINK_OUT"
  /* v1.1 */ | "EDIT_CONTENT" | "AI_SUGGEST";

type AiSuggestMode = "POLISH" | "CHECK";            // POLISH = rewrite for clarity and tone; CHECK = minimal grammar/spelling/tone fixes
type AiTone = "NEUTRAL" | "WARM" | "CONCISE";        // POLISH only; default NEUTRAL
type AiUnavailableReason = "KILL_SWITCH" | "COST_FREEZE" | "ALLOWANCE" | "PROVIDER";   // Session 2 shape 4
```

**`CatalogItem` additions** (v1 §2.1):

```ts
interface CatalogItemV11 extends CatalogItem {
  /** Per editable leg: its variants and what is live now. Empty when nothing is content-editable. */
  content: Array<{
    channel: EditableChannel;
    variants: string[];
    live: Array<{ variant: string; source: "CODE_DEFAULT" } | { variant: string; source: "PUBLISHED"; versionId: string; version: number }>;
  }>;
  /** True when every write to this definition's content is refused with 409 PROTECTED (§2.1). */
  contentLocked: boolean;
}
```

### 1.1 The `viewer` block (D2, D6a)

The `viewer` block is computed by the server for the **session operator**, on:
- `GET /catalog/[key]` (`CatalogDetailV11.viewer`);
- `GET /catalog/[key]/versions` (`VersionsResponse.viewer`);
- `GET /automations/[id]` (`AutomationDetailV11.viewer`).

The UI uses it instead of probing for 403s, and never names permission levels.

```ts
interface Viewer {
  canEditContent: boolean;      // POST /versions would pass the gate:      CS WRITE   ∧ leg contentEditable
  canPublish: boolean;          // publish:                                  CS CONTROL ∧ leg contentEditable
  canRollback: boolean;         // rollback:                                 CS CONTROL ∧ leg contentEditable ∧ the stream has a SUPERSEDED version or a published one (code-default target)
  rollbackUnavailableReason?: "NO_PERMISSION" | "NOTHING_TO_RESTORE";   // v1.1.1 — absent ⇔ canRollback
  canAiSuggest: boolean;        // ai-suggest gate:                          CS WRITE   ∧ leg contentEditable   (availability is `ai`, §3.2, not this)
  canTestSend: boolean;         // POST /test-send gate:                     CS WRITE   ∧ definition has an EMAIL or IN_APP leg
  canEditAutomation: boolean;   // POST / PATCH /automations:                CS WRITE   ∧ definition automatable ∧ ¬protected
  canDryRun: boolean;           // dry-run:                                  CS WRITE   ∧ definition automatable
  canActivate: boolean;         // activate gate:                            CS CONTROL ∧ definition automatable   (preconditions are activationBlockers, §6.2)
  canApproveAsOwner: boolean;   // owner-approval gate:                      role = SYSTEM_ADMIN ∧ customer-facing automatable definition
  canPauseDisable: boolean;     // pause / disable:                          CS WRITE
  testSendEligible: boolean;    // D6a — the §6.9 guards would admit a test send to SELF right now
  testSendIneligibleReason: "SELF_UNVERIFIED" | "NONPROD_ALLOWLIST" | null;   // null ⇔ eligible; the same codes as the 422 `guard`
}
```

- **Derivation.** Each flag uses the **same** decision functions as the routes: `decidePlatformAccess` (`lib/platform/authorize.ts:92`) over the operator's grants, with the SYSTEM_ADMIN break-glass, AND-ed with the resource facts shown.
- **Freshness is not evaluated.** Reads use the non-fresh gate, so the fresh re-check happens on the write. A flag that is `true` can therefore still meet a 403 `OPERATOR_TOTP_REQUIRED` or a freshness refusal. It never meets an insufficient-level 403.
- **The allowlist is never leaked.** `testSendEligible` tells the operator only whether **their own** address would pass. It reveals nothing about the contents or size of `EMAIL_NONPROD_ALLOWLIST`. In Production it is `true` whenever the operator's email is verified.

---

## 2. The content model

### 2.1 Which legs are editable

A leg `(definition, channel)` is **`contentEditable`** when all of these hold. The rule is computed in code and a test pins the resulting list.

1. `definition.protected === false`. This excludes every `SECURITY_CRITICAL` and `CEREMONY` definition (v1 §2 invariant).
2. `consentClass ∈ {SERVICE, AWARENESS}`. **OPERATOR** mail (staff alerts, inboxes) stays code-only. MARKETING does not exist.
3. `status ∈ {ENABLED, BUILD}`.
4. `channel ∈ {EMAIL, IN_APP}`, the channel is not in the registry type's `excludedChannels`, and the leg is not `READ_ONLY_SURFACE` (banners are written by Platform Ops).
5. An EMAIL leg renders through the generic `notification` template, or through a new BUILD template introduced by this delta (§5.3). Legs on a **ceremony template stay locked**. Those templates are `password-reset`, `email-verification`, `email-change`, `space-invite`, `beta-invite` and `security-alert`; they carry tokens or security copy.

**Writes to a leg that fails the rule:**
- A leg failing rule 1 or 5, or any leg of a `protected` definition, returns **409 `PROTECTED`**. This covers `POST /versions`, publish, rollback, `ai-suggest`, and an automation targeting it (v1 §2). It applies even when the body is malformed: the protection check runs before validation.
- A leg failing rules 2, 3 or 4 returns **409 `NOT_EDITABLE`**. This is the house code; see `policy-groups-http.ts:35`.

**Editable at v1.1.** The list is derived and test-pinned.

| Key | Channels | Variants |
|---|---|---|
| `SPACE_INVITE_RECEIVED` | IN_APP. The EMAIL leg is the `space-invite` ceremony and stays locked | default |
| `SPACE_INVITE_ACCEPTED`, `MEMBER_REMOVED`, `MEMBER_ROLE_CHANGED` | the registry's non-excluded channels | default |
| `SYNC_FAILED` | IN_APP, EMAIL | one per `CONNECTION_STATES` value plus `legacy-no-state` (the same variants as `lib/notifications/catalog/preview.ts` fixtures) |
| `SYNC_COMPLETED`, `IMPORT_COMPLETED`, `IMPORT_COMPLETED_WITH_ERRORS` | IN_APP | default |
| `PLAID_ITEM_REAUTH_REQUIRED`, `PLAID_ITEM_REVOKED`, `WALLET_SYNC_FAILED` (BUILD) | IN_APP, EMAIL | default |
| `ACCOUNT_WELCOME` (BUILD) | EMAIL | default |

**Locked.** Everything else is locked. That includes every ACCOUNT_SECURITY key, `PLATFORM_ACCESS_GRANTED`, the ceremony keys, `BETA_INVITATION_ISSUED` (a token link), the operator keys and the banners.

**Known divergence.** Editing `SYNC_FAILED` changes the bell and the email copy, **not** the Connections page. That page reads `lib/notifications/connection-attention.ts` directly. This is accepted and is shown on the catalog detail as `divergesFrom: "connection-attention"`.

**`CatalogDetail` additions** (`GET /catalog/[key]`; D2, D6b):

```ts
interface CatalogDetailV11 extends CatalogDetail, CatalogItemV11 {
  /** Present only on legs whose edited copy can differ from a surface that reads the code copy directly (SYNC_FAILED, PLAID_ITEM_REAUTH_REQUIRED, PLAID_ITEM_REVOKED). */
  divergesFrom?: "connection-attention";
  viewer: Viewer;                     // §1.1
}
```

### 2.2 Content body and blocks

The content blocks are a **strict subset** of the design system's `EmailBlock` (`lib/email/design/blocks.ts:31-38`), with one difference: a CTA names a link placeholder instead of carrying a URL.

```ts
type ContentBlock =
  | { kind: "hero"; heading: string; greeting?: string }
  | { kind: "paragraph"; text: string }
  | { kind: "cta"; label: string; link: string }            // `link` = the NAME of a LINK placeholder (§2.3), never a URL
  | { kind: "info"; title?: string; items: string[]; ordered?: boolean }
  | { kind: "divider" };
// Not available to operators: "expiry" (ceremony link lifetime) and "security" (the security variant).

interface ContentBody {
  subject: string;                 // EMAIL: the subject line. IN_APP: the notification title.
  preheader: string | null;        // EMAIL only (required, non-empty). IN_APP: must be null.
  blocks: ContentBlock[];
}
```

**Structural rules.** Breaking one is an error, with the §2.5 code shown.

| Rule | EMAIL | IN_APP | Code |
|---|---|---|---|
| Allowed kinds | hero, paragraph, cta, info, divider | paragraph (0–1), cta (0–1) | `BLOCK_KIND_NOT_ALLOWED` |
| Block count | 1–12 | 0–2 | `TOO_MANY_BLOCKS` / `EMPTY_CONTENT` |
| `hero` | at most 1, and only as block 0 | — | `BLOCK_ORDER` |
| `cta` | at most 1; `link` must be a LINK placeholder of this template | at most 1; `link` must be `inAppHref` (the registry href, fixed in code) | `PLACEHOLDER_KIND_MISMATCH` / `UNKNOWN_PLACEHOLDER` |
| `subject` | 1–120 chars, one line | 1–120 chars | `FIELD_TOO_LONG` / `EMPTY_FIELD` |
| `preheader` | 1–140 chars | null | `FIELD_TOO_LONG` / `EMPTY_FIELD` |
| `heading` | ≤ 120; `greeting` ≤ 120 | — | `FIELD_TOO_LONG` |
| `paragraph.text` | ≤ 1,200 | ≤ 280 | `FIELD_TOO_LONG` |
| `cta.label` | ≤ 40 | ≤ 40 | `FIELD_TOO_LONG` |
| `info` | ≤ 8 items; each ≤ 200; title ≤ 120 | — | `TOO_MANY_ITEMS` / `FIELD_TOO_LONG` |

**Rules for every text field.**
- Plain text only. Nothing is ever interpreted as HTML: the renderer escapes it (§5.2).
- Control characters, CR/LF in single-line fields, Unicode line separators and bidi overrides are refused (`CONTROL_CHARACTERS`). The class is the same as `cleanText`, `lib/email/design/escape.ts:51-61`.

### 2.3 Placeholders: a closed allowlist per template

- **Syntax:** `{{name}}`, where `name` matches `^[a-z][A-Za-z0-9]{0,31}$`.
- **Expansion:** one pass, no nesting, no filters and no expressions. A literal `{{` or `}}` anywhere else is a `MALFORMED_PLACEHOLDER` error.

Each editable leg declares its allowlist **in code**, next to its catalog definition:

```ts
interface PlaceholderSpec {
  name: string;
  kind: "TEXT" | "LINK";
  /** Where the value comes from at send time. Never from the request, never operator-supplied. */
  source:
    | { from: "PAYLOAD"; field: string }                 // a trigger payload / Notification.metadata pointer-contract field
    | { from: "RECIPIENT"; field: "firstName" }          // the recipient's own User row
    | { from: "APP_LINK"; path: string };                // trusted app base (lib/email/app-link.ts) + a code path
  /** TEXT: any of subject | preheader | body. LINK: only cta.link. */
  allowedIn: ReadonlyArray<"subject" | "preheader" | "body" | "cta">;
  maxLength: number;          // TEXT: the value is cleanText()-ed and capped to this
  fallback: string;           // used when the value is missing; output is never empty, never "undefined"
  sample: string;             // synthetic value for preview, dry run and test send (fictional; @example.invalid style)
  pii: boolean;               // true for names; such values never reach a ledger, an audit row or the AI (§4.2)
}
```

**v1.1 allowlists.** Fallbacks repeat today's registry fallbacks (`str(d, field, fallback)` in `lib/notifications/registry.ts`).

| Template (key / channel) | TEXT | LINK |
|---|---|---|
| `ACCOUNT_WELCOME` / EMAIL | `firstName` (RECIPIENT, pii, fallback "there") | `appUrl` → `/dashboard` |
| `PLAID_ITEM_REAUTH_REQUIRED`, `PLAID_ITEM_REVOKED`, `SYNC_FAILED`, `SYNC_COMPLETED` | `institutionName` (PAYLOAD, fallback "your bank" / "A connection") | `actionUrl` → `/dashboard/connections` (EMAIL); `inAppHref` (IN_APP) |
| `WALLET_SYNC_FAILED` | `networkName` (PAYLOAD `network`, mapped BTC→"Bitcoin", ETH→"Ethereum", SOL→"Solana") | `actionUrl` → `/dashboard/connections`; `inAppHref` |
| `SPACE_INVITE_RECEIVED` / IN_APP | `spaceName` (fallback "a Space"), `inviterName` (pii, fallback "A member") | `inAppHref` |
| `SPACE_INVITE_ACCEPTED` | `memberName` (pii, fallback "Your invitee"), `spaceName` | `actionUrl` → `/dashboard/spaces`; `inAppHref` |
| `MEMBER_REMOVED` | `spaceName` | `inAppHref` |
| `MEMBER_ROLE_CHANGED` | `spaceName`, `oldRole`, `newRole` | `actionUrl`; `inAppHref` |
| `IMPORT_COMPLETED` / `_WITH_ERRORS` | `rowCount` / `errorCount` | `inAppHref` |

**Required placeholders.**
- An EMAIL leg with a code-default CTA must keep exactly one `cta` whose `link` is its LINK placeholder. Without it the error is `REQUIRED_PLACEHOLDER_MISSING`, with `location: null`.
- A template may mark TEXT placeholders as required. `institutionName` is required in the reauth, revoked and sync-failed subjects, so a customer can tell which connection the message is about.

### 2.4 Escaping and substitution (server-side, always)

Substitution happens **on plain strings, before rendering**. The design-system renderer then escapes every string (§5.2). It runs in this order:

1. Resolve each value from its `source`.
2. Apply `cleanText(value, spec.maxLength)` (`escape.ts:58`). This strips controls, newlines and bidi characters and caps the length.
3. A missing or empty value takes `fallback`.
4. Replace `{{name}}` in one pass. A substituted value that itself contains `{{` is inserted literally and never re-expanded.
5. LINK values come only from `APP_LINK`: the trusted app base plus a code path, passed through `safeHttpUrl` (`escape.ts:34`).

Operator text never supplies a URL. `link` names a placeholder, and the text lint (§2.5) refuses URLs in prose.

### 2.5 Validation issues: typed, per block (Session 2 shape 2)

Every write validates the whole body and returns **all** issues at once.

```ts
type ContentLocation =
  | { field: "subject" }
  | { field: "preheader" }
  | { field: "block"; blockIndex: number; prop: "heading" | "greeting" | "text" | "label" | "link" | "title" | "items"; itemIndex?: number };

type ContentIssueCode =
  // placeholders
  | "UNKNOWN_PLACEHOLDER"           // {{x}} not in this template's allowlist
  | "MALFORMED_PLACEHOLDER"         // unbalanced braces, empty name, bad characters
  | "PLACEHOLDER_KIND_MISMATCH"     // LINK used in text, or TEXT used as cta.link
  | "PLACEHOLDER_NOT_ALLOWED_HERE"  // e.g. a placeholder outside its spec.allowedIn
  | "REQUIRED_PLACEHOLDER_MISSING"
  | "PLACEHOLDERS_DROPPED"          // AI only (§4.4): the suggestion lost a placeholder the base used
  | "PLACEHOLDERS_ADDED"            // AI only: the suggestion introduced a placeholder the base did not use
  // structure and length
  | "BLOCK_KIND_NOT_ALLOWED" | "BLOCK_ORDER" | "TOO_MANY_BLOCKS" | "TOO_MANY_ITEMS" | "EMPTY_CONTENT"
  | "EMPTY_FIELD" | "FIELD_TOO_LONG" | "CONTROL_CHARACTERS"
  | "STRUCTURE_CHANGED"             // AI only: block count, kinds or order differ from the base
  // content lint (§4.4 lexicons)
  | "LINK_NOT_ALLOWED"              // URL, bare domain, email address or phone number in text
  | "PII_LIKE_CONTENT"              // ≥ 4-digit run, address-like or secret-like (assertOperatorNoteSafe's classes, lib/audit.ts:301)
  | "FINANCIAL_CLAIM"               // numbers, currency or percentages not present in the code default, or claim lexicon hits
  | "ADVICE_LANGUAGE";              // financial / legal / tax advice lexicon

interface ContentIssue {
  code: ContentIssueCode;
  severity: "error" | "warning";
  location: ContentLocation | null;   // null = template-level (e.g. REQUIRED_PLACEHOLDER_MISSING)
  placeholder?: string;               // the offending name, when there is one
  message: string;                    // operator-facing, no content echoed beyond the placeholder name
}
```

**Severity.**

| Code | Manual drafts | AI suggestions (§4.4) |
|---|---|---|
| Placeholder, structure and length codes | **error** | **error** |
| `LINK_NOT_ALLOWED`, `PII_LIKE_CONTENT` | **error** | **error** |
| `FINANCIAL_CLAIM`, `ADVICE_LANGUAGE` | **warning**. The operator is accountable, and publishing still needs CONTROL and a reason | **error** when the base did not already trip it |

- An error makes the request **400 `{ error, code: "CONTENT_INVALID", issues: ContentIssue[] }`**, and nothing is written.
- Warnings are returned on the saved version (`issues`), shown at publish and recorded in the publish audit as `warningCodes`.

### 2.6 The version DTO (Session 2 shape 1)

```ts
interface TemplateVersionDTO {
  id: string;
  version: number;                       // 1-based within the stream
  state: VersionState;                   // DRAFT | PUBLISHED | SUPERSEDED (derived, §8.1)
  subject: string;
  preheader: string | null;
  blocks: ContentBlock[];
  placeholdersUsed: string[];            // distinct names, first-use order
  createdBy: { kind: VersionCreatedByKind; actorKind: "PLATFORM_OPERATOR" | "SYSTEM_ADMIN" };  // no operator identity (audit has it)
  createdAt: string;
  publishedAt: string | null;            // set once, when this version became PUBLISHED
  auditLogId: string;                    // the AuditLog row that created this version
  // ── optimistic token + lineage
  revision: number;                      // the stream's revision at read time; send back as expectedRevision
  stream: ContentStreamRef;
  publishAuditLogId: string | null;
  parentVersionId: string | null;        // the version this edit started from (draft lineage)
  basePublishedVersionId: string | null; // what was live when this draft was saved (stale-draft check, §3.4)
  restoredFromVersionId: string | null;  // ROLLBACK only
  sourceSuggestionId: string | null;     // AI_ASSISTED only
  aiEditedAfterAccept: boolean | null;   // AI_ASSISTED only: did the operator change the suggestion before saving
  issues: ContentIssue[];                // warnings under the CURRENT validator (re-run on read; errors impossible for stored rows unless the validator tightened)
}
```

**State.** `PUBLISHED` is the version the stream points at. `SUPERSEDED` was published once and is no longer live. `DRAFT` was never published. A DRAFT is never edited in place: each save is a new version. Versions are **immutable**: no endpoint and no grant changes a version's content.

---

## 3. Content endpoints (Phase B1)

Base path: `/api/platform/customer-success/notifications`. All responses carry `Cache-Control: no-store`.

**Order in every handler:**
1. gate (401/403);
2. rate limit (429);
3. key / stream / version existence (404);
4. **protection (409 `PROTECTED`, then `NOT_EDITABLE`)**;
5. body validation (400);
6. work.

This is v1.0.1's order, with the protection check placed before validation so that a protected template never yields a validation hint.

### 3.1 Gating matrix (additions to v1 §4.1)

| Endpoint | Gate | Reason | Same-tx audit | Bucket |
|---|---|---|---|---|
| `GET /catalog/[key]/versions`, `GET /catalog/[key]/versions/[id]`, `GET /catalog/[key]/preview?versionId=` | CS **READ** | — | — | `cs-comms-read` 120/min |
| `POST /catalog/[key]/render` (unsaved content, D3) | CS **READ** | — | **none** (nothing is persisted) | `cs-comms-render` 30/min |
| `POST /catalog/[key]/versions` (save draft) | fresh CS **WRITE** | optional | `COMMS_TEMPLATE_DRAFT_SAVED` | `cs-comms-write` 20/min |
| `POST /catalog/[key]/versions/[id]/ai-suggest` | fresh CS **WRITE** | optional | `COMMS_TEMPLATE_AI_SUGGESTED` | `cs-comms-ai` 10 per 10 min per operator |
| `POST /catalog/[key]/versions/[id]/publish` | fresh CS **CONTROL** | **required** | `COMMS_TEMPLATE_PUBLISHED` | `cs-comms-control` 10/min |
| `POST /catalog/[key]/versions/[id]/rollback` | fresh CS **CONTROL** | **required** | `COMMS_TEMPLATE_ROLLED_BACK` | `cs-comms-control` |

- **409 `PROTECTED`** is returned for **every** write in this table (and for §6 writes) whose target is a protected definition or a locked leg (§2.1). This is Session 2 shape 5.
- The gates are `requirePlatformAccess` and `requireFreshPlatformAccess` (`lib/platform/authorize.ts:198,213`). SYSTEM_ADMIN break-glass applies, as everywhere else.

### 3.2 `GET /catalog/[key]/versions?channel=&variant=&state=&cursor=&limit=`

```ts
interface VersionsResponse extends ListEnvelope<TemplateVersionDTO> {   // newest first; keyset on (version desc)
  stream: ContentStreamRef;
  revision: number;                          // current optimistic token
  live: { source: "CODE_DEFAULT" } | { source: "PUBLISHED"; versionId: string; version: number };
  /** The code default as a body (never a row): what "rollback to code default" restores, and the left side of a first diff. */
  codeDefault: ContentBody & { placeholdersUsed: string[] };
  placeholders: Array<Pick<PlaceholderSpec, "name" | "kind" | "allowedIn" | "maxLength" | "fallback" | "sample">>; // no `source`, no pii values
  limits: { blocks: number; subject: number; preheader: number | null; paragraph: number; ctaLabel: number;
            heading: number | null; greeting: number | null; infoTitle: number | null; infoItems: number | null; infoItem: number | null };  // v1.1.1 per-block; null = kind not allowed (IN_APP)
  contentEditable: boolean;                  // false ⇒ items empty, and every write → 409 PROTECTED / NOT_EDITABLE
  locked: { reason: "PROTECTED" | "NOT_EDITABLE" } | null;
  viewer: Viewer;                            // §1.1 (D2)
  ai: AiAvailability;                        // D4
}

/** D4 — §4.5 checks 1–3 evaluated read-only, WITHOUT calling the model and without reserving anything. */
interface AiAvailability {
  available: boolean;
  reason?: Exclude<AiUnavailableReason, "PROVIDER">;   // set when available = false (PROVIDER is only known after a call)
  detail?: string;                                       // the §4.5 detail code (e.g. "KILL_SWITCH", "UNVERIFIED")
  remainingCallsToday?: number;                          // this operator: COMMS_AUTHORING_DAILY_CALLS − today's calls (incl. in-flight)
  remainingUsdToday?: number | null;                     // min(per-operator, fleet) remaining USD; null when today's spend has unpriced rows
  checkedAt: string;
}
```

- **`ai` is advisory.** It is computed from the same readers as §4.5: `readPaidRequestsAdmission`, `readGlobalCostFreeze` and the authoring-allowance read, done without a lock or a reservation. The 503 from `ai-suggest` stays **authoritative**: state can change between this read and the click.
- **Fail closed.** A reader failure yields `available: false`, with that reader's fail-closed reason (`KILL_SWITCH` / `UNAVAILABLE`, `COST_FREEZE` / `UNVERIFIED`, `ALLOWANCE`). It never fails the whole response.
- When `contentEditable` is false, `ai` is still returned, and `viewer.canAiSuggest` is false.

- `channel` is required when the key has more than one editable channel. `variant` defaults to `"default"`.
- A stream that has never been saved returns `items: []`, `revision: 0` and `live.source: "CODE_DEFAULT"`.
- Reads on a protected key return 200 with `contentEditable: false`. Reads are never refused.
- A failed read returns 503 `UNAVAILABLE`, never an empty list (v1 §3.4).

### 3.3 `POST /catalog/[key]/versions` (save a draft) and `GET /catalog/[key]/versions/[id]`

```ts
type SaveDraftRequest = {
  reason?: { code: OperatorReasonCode; note?: string };
  expectedRevision: number;                  // required
  body: {
    channel: EditableChannel; variant?: string;
    parentVersionId: string | null;          // null = started from the code default
    content: ContentBody;
    source: { kind: "MANUAL" } | { kind: "AI_SUGGESTION"; suggestionId: string };
  };
};
// 201 → MutationResult<TemplateVersionDTO>  (state DRAFT, createdBy.kind OPERATOR | AI_ASSISTED)
```

The handler does the following in one `fm_system` transaction, under `pg_advisory_xact_lock(hashtext('comms-template:' || key || ':' || channel || ':' || variant))`:
1. Upsert the `CommsTemplate` head. `revision ≠ expectedRevision` returns **409 `CONFLICT`**, and nothing is written.
2. Validate (§2.5). An error returns **400 `CONTENT_INVALID`**.
3. When `source.kind = "AI_SUGGESTION"`:
   - the suggestion must exist, belong to this stream, be `OFFERED` and be unexpired. Otherwise the result is **409 `SUGGESTION_EXPIRED`** or 404;
   - `parentVersionId` must equal the suggestion's `baseVersionId`;
   - `createdBy.kind = "AI_ASSISTED"`, and `aiEditedAfterAccept = (contentHash ≠ suggestion.suggestedHash)`;
   - the suggestion becomes `ACCEPTED`, with `acceptedVersionId` set.
4. Insert version `headVersion + 1`, with `basePublishedVersionId = head.publishedVersionId`. Then `revision += 1`.
5. Write the audit row (§9.2). Its id becomes `auditLogId`.

`GET /catalog/[key]/versions/[id]` returns `TemplateVersionDTO`, or 404 when the id is not a version of this key.

### 3.4 `POST /catalog/[key]/versions/[id]/publish`

```ts
type PublishRequest = MutationRequest<{ acknowledgeWarnings: boolean }> & { expectedRevision: number };
// 200 → MutationResult<{
//   published: TemplateVersionDTO;
//   superseded: { versionId: string; version: number } | { source: "CODE_DEFAULT" };
//   revision: number;          // D6c — the stream's NEW revision (expectedRevision + 1); use it for the next write
// }>
```

All of the following happen in **one transaction**, under the same advisory lock:
1. CS **CONTROL** fresh; reason required.
2. `revision ≠ expectedRevision` → **409 `CONFLICT`**.
3. `[id]` must be a **DRAFT** of this stream. A PUBLISHED or SUPERSEDED version → **409 `INVALID_STATE`**; republishing an old version is a rollback (§3.5).
4. `draft.basePublishedVersionId ≠ head.publishedVersionId` → **409 `STALE_DRAFT`**. Someone published since this draft was based; the operator rebases by saving a new draft from the live version.
5. Re-validate under the current validator. Errors → **400 `CONTENT_INVALID`**. Warnings present and `acknowledgeWarnings = false` → **409 `WARNINGS_UNACKNOWLEDGED`**, with `issues`.
6. Write the audit row `COMMS_TEMPLATE_PUBLISHED`:
   - `target {kind:"COMMS_TEMPLATE", id: "<key>:<channel>:<variant>"}`;
   - `change {before:{versionId|null}, after:{versionId, version, contentHash}}`;
   - `detail {warningCodes, createdByKind, sourceSuggestionId|null}`.
   It returns the row id (§9.2).
7. `UPDATE CommsTemplateVersion SET publishedAt = now(), publishAuditLogId = <id> WHERE id = [id] AND publishedAt IS NULL`. The count must be 1, otherwise CONFLICT.
8. `UPDATE CommsTemplate SET publishedVersionId = [id], revision = revision + 1 WHERE id = … AND revision = expectedRevision`. The count must be 1, otherwise CONFLICT.

**Effect.** Content is resolved **at send time** (§5.4).
- Every send after commit uses the new version, including SCHEDULED automation items.
- In-app rows already created keep their stored title and body (`Notification.title/body`, `prisma/schema.prisma:3821-3822`). Nothing is rewritten retroactively.
- Publishing does **not** pause automations. Content is copy, not reach; the reach gate is activation plus owner approval (§6.3, §6.4).

### 3.5 `POST /catalog/[key]/versions/[id]/rollback`

```ts
type RollbackRequest = MutationRequest<{ channel?: EditableChannel; variant?: string }> & { expectedRevision: number };
// 200 → MutationResult<{ published: TemplateVersionDTO | { source: "CODE_DEFAULT" }; superseded: { versionId: string; version: number } | null; revision: number }>
```

- **`[id]` = a SUPERSEDED version of the stream.** The server inserts version `headVersion + 1` as an exact copy of `[id]`'s content (`createdBy.kind = "ROLLBACK"`, `restoredFromVersionId = [id]`) and publishes it in the same transaction, with the same steps 1, 2 and 6–8 as §3.4. History stays append-only; this is the house pattern of `rollbackPolicyGroup`, `lib/platform/policies/policy-groups-write.ts:307`. The copy is re-validated: if the validator has since tightened, the result is 400 `CONTENT_INVALID`, and the operator edits a new draft instead.
- **`[id]` = the reserved id `code-default`** (with `channel` and `variant` in the body) sets `head.publishedVersionId = null`. The code default is live again, and the previous version becomes SUPERSEDED.
- `[id]` that is a DRAFT, or the currently PUBLISHED version → **409 `INVALID_STATE`**.
- Audit: `COMMS_TEMPLATE_ROLLED_BACK`, with `change {before:{versionId}, after:{versionId|null, restoredFromVersionId|"CODE_DEFAULT"}}`.

### 3.6 `POST /catalog/[key]/versions/[id]/ai-suggest`

See §4.

### 3.7 `GET /catalog/[key]/preview?channel=&variant=&versionId=` (Session 2 shape 3)

This extends v1 §4.4.
- `versionId` is optional. It names any version (DRAFT, PUBLISHED or SUPERSEDED) **of this key**. When `versionId` is absent, the preview shows the live content (the published version, or the code default).
- The content renders through §5 with **synthetic values only**: each placeholder's `sample`, and the v1 fixtures for everything else. `synthetic: true` is always set and the subject carries the `[PREVIEW]` prefix. No query parameter supplies a value.
- Response: v1 `PreviewResponse`, plus `{ versionId: string | null; source: "CODE_DEFAULT" | "VERSION"; issues: ContentIssue[] }`.
- A `versionId` that belongs to another key or stream → **404 `NOT_FOUND`**. A channel that does not match the version's channel → 409 `INVALID_STATE`.
- A render failure → 503 `UNAVAILABLE` with `code: "RENDER"`, never a blank preview.

### 3.8 `POST /catalog/[key]/render` (live preview of UNSAVED content, D3)

```ts
type RenderRequest = { channel: EditableChannel; variant?: string; content: ContentBody };
type RenderResponse = PreviewResponse & { versionId: null; source: "UNSAVED"; issues: ContentIssue[] };
```

- **Gate and bucket.** CS **READ**, with the dedicated bucket `cs-comms-render` at 30/min per operator.
- **Persists nothing and audits nothing.** No version, suggestion, ledger or AuditLog row is written. The request body is never logged.
- **Saving stays explicit:** `POST /versions` (§3.3).
- **Same validator, same samples.** It uses the same validator as §2.5, the same substitution as §2.4 (each placeholder's `sample`, never a real value) and the same render as §5. `synthetic: true` and the `[PREVIEW]` subject prefix are always set.
- **Validation errors do not fail the request.** It returns **200**, with `issues` carrying the errors and warnings. The HTML and text are rendered when the content is renderable. When an error makes rendering impossible (e.g. an unknown placeholder used as `cta.link`), `html`, `text` and `inApp` are `null`. A body that is not a `ContentBody` at all → 400 `VALIDATION`.
- **Errors.** A protected key or locked leg → 409 `PROTECTED`. A leg that is not editable → 409 `NOT_EDITABLE`. Neither returns render output.
- **Body size.** The body is capped at 32 KB: over the cap → 400 `VALIDATION`.

---

## 4. AI-assisted authoring ("Polish with Fourth Meridian AI")

### 4.1 Flow and invariants

1. The operator writes and **saves** a draft (§3.3). The suggestion always has a saved base, so the left pane of the diff is an immutable row.
2. `POST …/versions/[id]/ai-suggest` returns a **suggestion**: a separate `CommsAiSuggestion` row. **It never writes a version and never touches the base.**
3. The UI shows the base and the suggestion side by side, field by field (`changes[]`). The operator then does one of three things:
   - **accepts** the suggestion: saves a new draft from it, with `source: AI_SUGGESTION`;
   - **edits** it first: the same save, which records `aiEditedAfterAccept: true`;
   - **discards** it: nothing is written, and the suggestion expires after 24 h as `EXPIRED`.
4. Publishing is unchanged (§3.4): CONTROL plus a reason. **The AI has no path to publish.** Neither `ai-suggest` nor anything it returns can reach `publish`, `rollback` or a send.

### 4.2 What is sent to the model (data minimisation)

The prompt contains **only**:
- the base version's `subject`, `preheader` and block texts;
- the block kinds and order;
- the placeholder **names** used (`{{institutionName}}`, verbatim);
- the requested `mode` and `tone`.

It never contains:
- a placeholder **value**, sample or fallback;
- recipient, customer, Space or account data;
- delivery or ledger data;
- the operator's identity, the reason note, or any other version.

**Test-pinned.** A unit test builds the request for every editable leg and asserts that the serialised messages contain only the base content strings, the fixed instruction text and the placeholder names. The base content itself already passed `PII_LIKE_CONTENT` (§2.5), so no address or long digit run can be in it.

**Call path.** The call goes through the one provider seam, `generateStructuredWithUsage` (`lib/ai/provider.ts:628`), with a strict JSON schema mirroring `ContentBody` plus `notes[]`. It runs inside `runWithAiInvocationContext` (`lib/ai/invocation-context.ts:82`) with:
- `surface: "comms_authoring"`;
- `subSurface: "comms_authoring:polish" | "comms_authoring:check"`;
- `userId`: the operator;
- `correlationId`: the suggestion id.

The `AiInvocation` ledger therefore records cost and outcome as for any surface, and never records content.

### 4.3 `POST …/versions/[id]/ai-suggest`

```ts
type AiSuggestRequest = {
  reason?: { code: OperatorReasonCode; note?: string };
  body: { mode: AiSuggestMode; tone?: AiTone };
};

interface AiSuggestResult {                            // 200
  suggestionId: string;
  baseVersionId: string;
  mode: AiSuggestMode;
  base: ContentBody;                                   // echo of [id], for the left pane
  suggestion: ContentBody;                             // same block count, kinds and order as base (§4.4)
  changes: Array<{ location: ContentLocation; before: string; after: string }>;   // changed fields only, in document order
  notes: Array<{ location: ContentLocation | null; category: "GRAMMAR" | "SPELLING" | "TONE" | "CLARITY" | "CONSISTENCY"; text: string }>; // ≤ 10, each cleanText ≤ 200; display only, never sent
  checks: { structurePreserved: true; placeholdersPreserved: true; linksAdded: false; financialClaimsAdded: false; adviceAdded: false };
  model: string;
  expiresAt: string;                                   // createdAt + 24 h
  checkedAt: string;
}
```

**Responses.**
- `200`: the suggestion passed every check (§4.4) and is stored `OFFERED`.
- `200` with `changes: []`: the model found nothing to change. The suggestion is stored as `OFFERED`, and accepting it would be a no-op.
- **`422 { error, code: "SUGGESTION_REJECTED", suggestionId, issues: ContentIssue[] }`**: the model's output failed a check. **The rejected text is not returned.** The row is stored `REJECTED`, with `rejectionCodes` and without content (§8.3).
- **`503 { error, code: "AI_UNAVAILABLE", reason: AiUnavailableReason, retryAfterSeconds?: number }`**: see §4.5. The row is stored `UNAVAILABLE`.
- 409 `PROTECTED` / `NOT_EDITABLE` (§2.1); 404 when `[id]` is not a version of this key; 429 when the bucket is exhausted. No row is written for 429.

### 4.4 Server-side checks on the model's output

The checks are deterministic code; there is no second model call. They are evaluated **against the base**, and every failure is an `error` (§2.5):

| Check | Rule | Code |
|---|---|---|
| Schema | strict JSON schema; any parse or shape failure | `STRUCTURE_CHANGED` (`location: null`) |
| Structure | same number of blocks, same kinds, same order, same `info.items` counts; `cta.link` unchanged | `STRUCTURE_CHANGED` |
| Placeholders | for every field, the **multiset** of `{{names}}` equals the base's | `PLACEHOLDERS_DROPPED` / `PLACEHOLDERS_ADDED` (per field, with `placeholder`) |
| Links | no URL, bare domain, email address or phone number that the base field lacked | `LINK_NOT_ALLOWED` |
| Financial claims | (a) every number, currency symbol or code, and percentage token in the output field already appears in the base field; (b) no hit from the closed claim lexicon (e.g. "guarantee", "risk-free", "returns", "APR", "interest rate", "save $", "earn", "grow your money") that the base did not already contain | `FINANCIAL_CLAIM` |
| Advice | no hit from the closed advice lexicon ("you should invest", "we recommend", "buy", "sell", "tax advice", "legal advice", "financial advice", "consult a", "deduct", "write off") that the base did not already contain | `ADVICE_LANGUAGE` |
| Everything in §2.2 / §2.5 | lengths, controls, PII-like runs, block rules | as §2.5 |

- The lexicons are code (`lib/notifications/content/lint.ts`, PROPOSED), word-boundary and case-insensitive, and pinned by tests. They are deliberately conservative: a false positive costs a rejection, and the operator can still edit by hand.
- `notes[]` text passes `cleanText`, and is dropped (not rejected) when it trips the link lexicon.

### 4.5 UNAVAILABLE reasons (typed, checked before any model call)

These checks run in this order after the gate, the bucket, the 404 check and protection. The first failure answers.

| # | Check | Reason | Source |
|---|---|---|---|
| 1 | Paid AI requests paused: the kill switch, maintenance, or an unreadable or unavailable setting (fail closed) | `KILL_SWITCH` (with `detail: "KILL_SWITCH" \| "MAINTENANCE" \| "BOTH" \| "UNREADABLE" \| "UNAVAILABLE"`) | `readPaidRequestsAdmission` (`lib/platform/ai/paid-requests-admission.ts`). The provider chokepoint re-checks it (`assertPaidRequestsAdmitted`, `provider.ts:324`); an `AiPausedError` thrown mid-call maps here too |
| 2 | **GLOBAL Cost Freeze** (D1): `readGlobalCostFreeze()` returns `frozen: true` | `COST_FREEZE` with `detail: "FROZEN"` (state `ON`), or `detail: "UNVERIFIED"` (state `INVALID` or `UNAVAILABLE`) | `lib/platform/cost-freeze.ts:24`: an **uncached** read of the PlatformSetting `platform_cost_frozen`, judged by `judgeGlobalCostFreeze` (`lib/platform/cost-freeze.core.ts`) |
| 3 | Authoring allowance (§4.6) exhausted, or its read failed (fail closed) | `ALLOWANCE` (`retryAfterSeconds` = seconds to the next UTC midnight) | §4.6 |
| 4 | The provider call failed: timeout, refusal, empty or unparseable output, an unpriced model (`UnpricedModelError`), quota or rate limit | `PROVIDER` (with `detail` = the `classifyAiFailure` outcome, `lib/ai/invocation.ts:122`) | recorded through the existing failure path; no provider text is returned |

**Cost-freeze rule for authoring (D1, explicit).** Only the **global** verdict blocks operator authoring.

| `GlobalCostFreezeState` | `frozen` | ai-suggest |
|---|---|---|
| `ON` | true | refused: `COST_FREEZE` / `FROZEN` |
| `INVALID`, `UNAVAILABLE` | true (fail closed) | refused: `COST_FREEZE` / `UNVERIFIED` |
| `OFF`, `MISSING` | false (`MISSING` = absent means off) | not blocked by check 2 |

- **A Beta-GROUP-only freeze does NOT block operator authoring.** That is `PolicyGroup.costFrozen` on `BETA_FULL_ACCESS_V1` with the global flag off. It is a customer-entitlement restriction, and the operator is not a customer.
- The group flag is **not** read by `ai-suggest`.

- The HTTP status is always **503**, and the `code` is always `AI_UNAVAILABLE`, so the UI has a single branch.
- `Retry-After` is set for `ALLOWANCE`, and for `PROVIDER` when the outcome is `RATE_LIMITED`.

### 4.6 The authoring allowance

The customer allowance counts only the customer surfaces (`CUSTOMER_SURFACES = ["chat","brief"]`, `lib/platform/ai/spend-by-surface-core.ts:26`; `customer-spend-today.ts:60`). An operator is not a customer, so authoring has its **own** cap. It is **always enforced** and independent of `allowance.enforced`. The figures are adopted defaults (§11.2), as code constants:
- **Per operator:** `COMMS_AUTHORING_DAILY_USD = 2.00` per UTC day, and `COMMS_AUTHORING_DAILY_CALLS = 40`. The call cap is the backstop when spend is unpriced.
- **Fleet:** `COMMS_AUTHORING_FLEET_DAILY_USD = 10.00` per UTC day across all operators.

**How it is enforced.** The decision reuses the reservation primitive of `lib/platform/ai/allowance-reservation.ts`, generalised (PROPOSED) to take a surface set and a subject key. It is one short `fm_system` transaction under `pg_advisory_xact_lock(hashtext('ai-allowance:comms_authoring:' || operatorId))` that:
- reads today's `RETURNED` rows for `surface = "comms_authoring"`;
- adds the in-flight reservations;
- decides, and reserves the call.

The handler releases the reservation in `finally`. Economics → AI budget lists `comms_authoring` in `bySurface` as overhead, never as fleet customer spend.

### 4.7 Manual editing always works

- No content endpoint other than `ai-suggest` reads the kill switch, the allowance, the provider or the Cost Freeze. While AI is unavailable, `POST /versions`, preview, test send, publish and rollback all keep working.
- The UI disables only the Polish button and shows the typed reason.

### 4.8 The audited chain

Every step leaves a row, and the rows link by id:

```
version (DRAFT, auditLogId: COMMS_TEMPLATE_DRAFT_SAVED)
  └─ suggestion (CommsAiSuggestion; requestAuditLogId: COMMS_TEMPLATE_AI_SUGGESTED; AiInvocation.correlationId = suggestion.id)
       └─ version (DRAFT, createdBy AI_ASSISTED, sourceSuggestionId, aiEditedAfterAccept; COMMS_TEMPLATE_DRAFT_SAVED)
            └─ publish (publishAuditLogId: COMMS_TEMPLATE_PUBLISHED, detail.sourceSuggestionId)
```

- Audit `change` and `detail` hold ids, versions, content **hashes**, codes and counts, never the text (`lib/audit.ts:185`, "fixed keys only").
- The text lives in `CommsTemplateVersion` and in OFFERED/ACCEPTED `CommsAiSuggestion` rows.

---

## 5. Rendering operator content through the design system (PR #157)

### 5.1 The locked frame

Operators edit **only** `ContentBody`. Everything else comes from code on every render:

| Part | Source |
|---|---|
| Document shell, dark mode, Outlook ghost table | `renderEmail` (`lib/email/design/render.ts:132`) |
| Header: logo (`LOGO_PATH`) and text wordmark "Fourth Meridian" plus the brass rule | `headerHtml` (`blocks.ts`), `config.ts:27` |
| Footer: the reason line, the preference link, the support contact, legal links and © | `footerHtml` / `footerText` (`blocks.ts:222`), `LEGAL_LINKS` (`config.ts:30`) |
| The footer **reason** and **preference link** | code per definition. For registry email legs: `notificationFooterReason(category)` plus the settings URL (`lib/email/templates/notification.ts`). For the BUILD templates: a fixed sentence per key (§5.3) |
| Sender identity | `product-notification` (as `notification`); unchanged |
| Variant | always `"standard"`. Operator content can never be rendered as `"security"`, and the `security` and `expiry` blocks are not in `ContentBlock` (§2.2) |

### 5.2 Block mapping and escaping

| `ContentBlock` | `EmailBlock` (design system) | Plain text (`blockText`) |
|---|---|---|
| `hero {heading, greeting?}` | `hero {heading, greeting?}` | `heading\n\ngreeting` |
| `paragraph {text}` | `paragraph {text}` | `text` |
| `cta {label, link}` | `cta {label, url: <resolved LINK value>}` | `label:\n<url>` |
| `info {title?, items, ordered?}` | `info {title?, items, ordered?}` | `title\n- item` / `1. item` |
| `divider` | `divider` | `----` |

**The render pipeline:**

```
resolveLiveContent(stream)            // §5.4
  → substitute(body, values, specs)    // §2.4: cleanText per value, fallback, one pass, LINK via APP_LINK + safeHttpUrl
  → toEmailBlocks(body)                // the table above
  → renderEmail({ subject, preheader, blocks, footer: codeFooter(key), variant: "standard" })
  → { subject, html, text }            // HTML and text from the SAME block list (render.ts header)
```

- **Escaping is server-side and single-sourced.** `renderEmail` passes every string through `escapeHtml` and every URL through `safeHttpUrl` (`escape.ts:25,34`). Substituted values are plain strings by then, so a value such as `<b>` or `"><script>` renders as text.
- **Plain text** is generated by `renderEmail` from the same blocks: `WORDMARK`, then each `blockText`, then `footerText`. There is no separately authored text part, so HTML and text cannot drift.
- **Subject and preheader:** the substituted string, a single line, capped again after substitution (120 and 140 characters). `[PREVIEW]` or `[TEST]` is prefixed when applicable.
- **A render that throws** (an unsafe URL, a rule violation) is the existing `RENDER` failure (`lib/email/send.ts`). The ledger records `errorCode: "RENDER"`, and **the send falls back to the code default**, recorded with `contentVersionId: null` and a `RENDER_FALLBACK` log line. A published version that cannot render must never silence a SERVICE message.

### 5.3 In-app and the BUILD templates

- **IN_APP.** The substituted `subject` becomes `Notification.title`; the paragraph, if any, becomes `body`; and the `cta.label`, if any, becomes the registry `actionLabel`. `href`, `icon`, category, priority and dedupe still come from the registry entry. `createNotification` (`lib/notifications/create.ts:414`) calls `def.render(data)`, and B1 wraps that call as `renderWithLiveContent(type, data)`. With no published version it returns the registry render exactly, and a parity test pins that equality for every editable type.
- **Registry EMAIL legs.** `buildNotificationEmailData` (`lib/notifications/channels/email-data.ts:20`) reads the live EMAIL version, if any. With no published version, today's `notification` rendering is used **byte for byte**; that parity test is pinned too.
- **BUILD templates** (`ACCOUNT_WELCOME`, `PLAID_ITEM_REAUTH_REQUIRED`, `PLAID_ITEM_REVOKED`, `WALLET_SYNC_FAILED`). Each one gets a code `defaultContent: ContentBody` and a code footer reason, rendered by one new template, `operator-content`. `EMAIL_TEMPLATE_VERSIONS` gains `"operator-content": 1`. The code default is what `codeDefault` returns (§3.2) and what `code-default` rollback restores.

### 5.4 Resolution at send time and ledger provenance

- `resolveLiveContent(stream)` does one indexed read of `CommsTemplate` and the published `CommsTemplateVersion`, through `fm_system`.
- Results are cached in-process for at most **30 s**, matching the policy-catalogue freshness bound, and the cache is invalidated on publish within the instance.
- A read failure uses the **code default**: content is optional, delivery is not. The failure is logged.
- **Ledger.** `CommsDelivery` gains `contentVersionId String?` (B1 migration, §8.6). `null` means the code default, and `templateVersion` keeps its v1 meaning (the code template version). Analytics can then attribute any send to the exact copy it carried.

---

## 6. Automations (Phase B2): delta on v1 §4.6–§4.10 and §5

### 6.1 Endpoints

Everything not restated here is as in v1 §4.6–§4.10.

| Endpoint | Gate | Reason | Audit | Bucket |
|---|---|---|---|---|
| `GET /automations`, `GET /automations/[id]`, `GET /automations/[id]/runs` | CS READ | — | — | `cs-comms-read` |
| `POST /automations` (create DRAFT) | fresh CS WRITE | required | `COMMS_AUTOMATION_CREATED` | `cs-comms-write` |
| `PATCH /automations/[id]` (DRAFT or PAUSED only) | fresh CS WRITE | required | `COMMS_AUTOMATION_UPDATED` | `cs-comms-write` |
| `POST /automations/[id]/dry-run` | fresh CS WRITE | required | `COMMS_AUTOMATION_DRY_RUN` | `cs-comms-dryrun` 10/min |
| `POST /automations/[id]/owner-approval` | **`requireFreshSystemAdmin`** (`lib/session.ts:368`) | required | `COMMS_AUTOMATION_OWNER_APPROVED` | `cs-comms-control` |
| `POST /automations/[id]/activate` | fresh CS **CONTROL** (O-1, decided) | required | `COMMS_AUTOMATION_ACTIVATED` | `cs-comms-control` |
| `POST /automations/[id]/pause` | fresh CS WRITE | required | `COMMS_AUTOMATION_PAUSED` | `cs-comms-write` |
| `POST /automations/[id]/disable` | fresh CS WRITE | required | `COMMS_AUTOMATION_DISABLED` | `cs-comms-write` |
| `POST /test-send` | fresh CS WRITE | required | `COMMS_TEST_SEND` | `cs-comms-test` 5/10 min |

- **CRUD.** There is no DELETE. "Delete" is `disable`: it is terminal, and the row is kept for audit (v1 §4.9). The way to revive a disabled automation is to clone it, which is `POST` with the same body.
- **409 `PROTECTED`** is returned on create or PATCH when `definitionKey` names a protected definition (v1 §2 invariant, restated per Session 2 shape 5).

### 6.2 `AutomationDetail` additions (v1 §4.6)

```ts
interface AutomationDetailV11 extends AutomationDetail {
  variant: string;                               // content variant the sends use (default "default")
  customerFacing: boolean;                       // derived: definition audience ∉ {OPERATOR_INBOX, PLATFORM_STAFF}
  ownerApproval: { approvedVersion: number; approvedDefinitionVersion: number; approvedAt: string; current: boolean } | null;
  lastDryRun: { runId: string; at: string; automationVersion: number; wouldExceedMaxRecipients: boolean } | null;
  activationBlockers: ActivationBlocker[];       // empty ⇒ activate would pass the §6.3 checks
  liveContent: { channel: EditableChannel; source: "CODE_DEFAULT" | "PUBLISHED"; versionId: string | null }[];
  viewer: Viewer;                                // §1.1 (D2): the flags; activationBlockers stay the precondition answer
}
type ActivationBlocker =
  | "TRIGGER_NOT_AVAILABLE" | "DEFINITION_NOT_ACTIVATABLE" | "PROTECTED" | "MARKETING_NOT_IN_V1"
  | "OWNER_APPROVAL_REQUIRED" | "DRY_RUN_REQUIRED" | "STATE";
```

**Automations carry no copy.** An automation sends the stream's live content (§5.4) for its channel and `variant`. PATCH validation still refuses any copy field (v1 §4.10).

### 6.3 `POST /automations/[id]/activate`: preconditions

The body is `MutationRequest<{}>` with `expectedVersion`. The checks below are evaluated in this order. The first failure returns **409** with the code shown, and nothing is written.

1. State is `DRAFT` or `PAUSED`. Otherwise `INVALID_STATE`. A stale `expectedVersion` returns `CONFLICT`.
2. The definition is not `protected`. Otherwise `PROTECTED`.
3. The definition `status ∈ {ENABLED, BUILD}`, **and** the trigger's catalog status is `AVAILABLE`, meaning its emitter has shipped (§7). Otherwise `INVALID_STATE` with blocker `TRIGGER_NOT_AVAILABLE` or `DEFINITION_NOT_ACTIVATABLE`. `BUILD_OFF` (the digest) always fails here.
4. `consentClass ≠ MARKETING`. Otherwise `INVALID_STATE` with blocker `MARKETING_NOT_IN_V1`. **There is no broadcast:** no resolver can address more than one event's subjects, actors or Space role holders (v1 §5.3), and `maxRecipientsPerRun ≤ 500`.
5. **`customerFacing` ⇒ `ownerApprovedVersion = version` and `ownerApprovedDefinitionVersion = definitionVersion`.** Otherwise **`OWNER_APPROVAL_REQUIRED`** (§6.4).
6. A dry run of **this** `version` completed `SUCCEEDED` within the last 7 days, with `wouldExceedMaxRecipients = false`. Otherwise **`DRY_RUN_REQUIRED`**.
7. Activation then commits the following in the same transaction as the audit: `state = ACTIVE`, `activatedVersion = version`, `activatedAt`, and `autoPausedReason = null`.

Re-activating from `PAUSED` runs the same checks. A PATCH while paused bumps `version`, so it needs a new owner approval and a new dry run.

### 6.4 The owner-approval gate (`ownerApprovedVersion`)

The rule: **no customer-facing automation is ever ACTIVE unless the owner approved that exact automation version against that exact definition version.**

- `POST /automations/[id]/owner-approval`, with body `MutationRequest<{}>` and `expectedVersion`.
- The gate is `requireFreshSystemAdmin()`. The owner acts as SYSTEM_ADMIN (O-18); a CS CONTROL grant is not enough.
- It sets `ownerApprovedVersion = version`, `ownerApprovedDefinitionVersion = definitionVersion`, `ownerApprovedAt` and `ownerApprovedById`, with the audit row in the same transaction.
- It is allowed in `DRAFT` or `PAUSED`; otherwise `INVALID_STATE`.
- Approval **does not activate**. A CS CONTROL operator activates afterwards (§6.3).
- **Invalidation is automatic and needs no write:**
  - any PATCH bumps `version`;
  - any code change bumps `definitionVersion`; v1 §2.2 rule 5 auto-pauses the automation with `DEFINITION_CHANGED`.
  Either way `ownerApproval.current` becomes false. There is no revoke endpoint: pause and disable already stop sending.
- Automations whose `customerFacing = false` (staff or inbox resolvers) skip rule 5 of §6.3. They still need CONTROL and a dry run.

### 6.5 The C5 lifecycle guard (owner rule, replaces v1 §5.6.1's matrix)

**Authority.** `getBetaLifecycleStatesForUsers(userIds)` (`lib/entitlements/beta-lifecycle.ts:80`):
- returns `Map<userId, "ACTIVE"|"PAUSED"|"ENDED"|"COST_FREEZE"|"UNKNOWN">` (`:55`);
- uses one fresh-catalogue read and one assignment query per batch;
- never throws; every id is in the map, and a failed read gives UNKNOWN for everyone.

It is called **once per send batch** at schedule time and **again** immediately before a delayed send (§6.6). O-16 is closed: no billable operation is needed.

**"SERVICE about the recipient's own data"** means all three of:
- `consentClass = SERVICE`;
- `audience = ACCOUNT_HOLDER`;
- the recipient resolved through `EVENT_SUBJECT_USER`, so the event is about the recipient's own connection or account.

A SERVICE send to anyone else (for example a `SPACE_ROLE` resolver) is treated as AWARENESS below.

**Matrix.** S = send. B = `SUPPRESSED` / **`BETA_LIFECYCLE`**. Per-recipient precedence is: the consent-class exemption first, then the state.

| Message | ACTIVE | PAUSED | ENDED | COST_FREEZE | UNKNOWN |
|---|---|---|---|---|---|
| SECURITY_CRITICAL (any origin) | S | S | S | S | S |
| CEREMONY (any origin) | S | S | S | S | S |
| SERVICE, own data (registry, direct **or automation**) | S | S | S | S | S |
| AWARENESS via an **automation** (either channel) | S | B | B | B | **B** |
| AWARENESS from a registry or direct producer: **EMAIL leg** | S | B | B | B | **B** |
| AWARENESS from a registry producer: **IN_APP leg** | S | S | S | S | S (O-17, default) |
| Any other automation send | S | B | B | B | B |
| OPERATOR (staff, inboxes) | not evaluated | | | | |

**Two freezes, two rules (D1, explicit).**
- **Per-recipient: a Beta-GROUP freeze.** The recipient's group has `costFrozen = true`. This is handled **only** by the matrix above: `getBetaLifecycleStatesForUsers` returns `COST_FREEZE` for that recipient, and their AWARENESS and automation sends become `BETA_LIFECYCLE`. It does **not** halt the run, and other recipients continue.
- **Run-level: the GLOBAL Cost Freeze.** `readGlobalCostFreeze()` (`lib/platform/cost-freeze.ts:24`) is an **uncached** read of `platform_cost_frozen`. It returns `frozen: true` for state `ON`, and for `INVALID` or `UNAVAILABLE` (fail closed). `OFF` and `MISSING` are not frozen. The global flag is also folded into the catalogue, so recipients read `COST_FREEZE` there as well; the run halts before that matters.

**When the global verdict is frozen:**
- **every LIVE automation run HALTS**, with `haltReason: "PROVIDER_FREEZE"`;
- its `SCHEDULED` items become `CANCELLED` / `PROVIDER_FREEZE`;
- nothing further is sent.

This applies **before** the per-recipient matrix, and it applies even to SERVICE-own-data automations. The owner rule halts live runs; registry and direct SERVICE producers, such as `SYNC_FAILED`, are untouched. Runs check at start, before each send batch, and the scanner checks before every delayed item.

### 6.6 The send pipeline: idempotency, schedule, re-evaluation, retry

**At trigger** (LIVE). This runs after the emitter's commit and never inside a tenant transaction (v1 §5.1).
1. Global checks: the GLOBAL Cost Freeze verdict, `readGlobalCostFreeze()` (§6.5), the global breaker (§6.7), and the automation still `ACTIVE` at `activatedVersion`. A failure HALTS the run.
2. Resolve recipients, capped at `maxRecipientsPerRun`. Over the cap the run HALTS and the automation auto-pauses `STORM_BREAKER` (v1 §5.7).
3. **Claim** one `AutomationRunItem` per (recipient, channel), with `idempotencyKey = sha256(automationId ‖ activatedVersion ‖ triggerRef ‖ recipientId ‖ channel)` under a **unique** index. The insert is the claim: a replayed trigger, a duplicate wake or a double click inserts nothing (`ON CONFLICT DO NOTHING`), and the duplicate is counted as `deduped` in the run, not as a suppression.
4. Evaluate conditions, eligibility, account restriction, admission, the lifecycle batch (§6.5), preferences, dedupe and the frequency cap (v1 §5.6 order). A failure writes the item `SUPPRESSED` with its reason, plus one `CommsDelivery` row (`status SUPPRESSED`, `messageKey = item.id`).
5. If `delay = 0`, the item is sent within the run (step 6 below). Otherwise it is `SCHEDULED` with `notBefore`.

**At send** (immediate, or by the scanner on the existing job-dispatcher wake, so delays have up to the wake interval of jitter):
1. **Claim the item:** `UPDATE … SET status='SENDING', leaseUntil=now()+5 min WHERE id=… AND status='SCHEDULED' AND notBefore<=now()`. The count must be 1. An expired lease returns the item to `SCHEDULED`. The provider's idempotency key is `item.id:attempt` (INFERRED SDK support, UNVERIFIED, as v1 §5.5).
2. **Re-evaluate everything**, freshly: the automation is `ACTIVE` at the same `activatedVersion`, the GLOBAL Cost Freeze verdict (uncached), account restriction, admission, **`getBetaLifecycleStatesForUsers` for the batch**, conditions, eligibility (e.g. `connection.status_in` still `NEEDS_REAUTH`, `connection.removed_by_user` still false), preferences, dedupe and the frequency cap. A failure makes the item `CANCELLED` with its reason, plus a ledger row.
3. Render the live content (§5).
4. EMAIL → `sendEmail`. It applies the environment guard and then the **per-recipient storm limit: 5 accepted emails per rolling 60 min across SERVICE, AWARENESS and MARKETING keys** (`EMAIL_STORM_LIMIT`, `lib/notifications/delivery/storm.ts` #177). Automation email counts toward it. `RATE_LIMITED` or `RATE_LIMIT_UNVERIFIED` marks the item `SUPPRESSED`, and it is **not retried**: a later attempt would be the same burst. IN_APP → `createNotification`, the only writer (v1 §4.14).
5. **Retry:** `STANDARD` means 3 attempts in total, at +15 min and +4 h, then `DEAD` (v1 §5.5). Each attempt appends a `CommsDelivery` row (v1.0.2). Every retry re-runs step 2 first.

**Dedupe across producers.** In-app dedupe is `(userId, dedupeKey)` across all types (`prisma/schema.prisma:3837`). `PLAID_ITEM_REAUTH_REQUIRED` therefore uses the **same** key string as `SYNC_FAILED` (`SYNC_FAILED:item:{plaidItemId}:open`), so the cron and the webhook never both raise a bell. B2 moves the three BUILD in-app legs into `NOTIFICATION_REGISTRY`, so they go through `createNotification`.

### 6.7 Loop and storm prevention (v1 §5.7, restated with numbers)

| Guard | Rule |
|---|---|
| No self-triggering | the trigger catalog has no comms event (`lib/notifications/catalog/triggers.ts` header); the engine never emits a domain event |
| Per-run cap | `maxRecipientsPerRun`, default 50, ceiling 500; over the cap ⇒ HALTED and the automation auto-pauses `STORM_BREAKER` |
| Per-recipient email storm limit | 5 per rolling 60 min (#177), enforced in `sendEmail` |
| Per-recipient, per-key frequency cap | the definition default; an automation can only tighten it |
| Global automation breaker | more than **200 accepted automation sends per 10 min** auto-pauses **every** automation (`STORM_BREAKER`) and raises a Platform Ops alert (new `ALERT_RULES` kind). Registry and direct sends are untouched. `GLOBAL_EMAIL_CAP_PER_HOUR` stays null until the Resend quota is known (#177) |
| Error-rate breaker | at least 20 attempts and more than 50% failed in an hour ⇒ auto-pause `ERROR_RATE` |
| Fan-out | `PLATFORM_AREA_STAFF` is capped at 50 |

### 6.8 `POST /automations/[id]/dry-run`

This extends v1 §4.7.
- **Body:** `MutationRequest<{ sample?: { triggerRef?: string }; window?: "7d" | "30d" }>`.
- It replays the recorded trigger events (the `AuditLog` rows written by `emitDomainEvent`) through the **whole** at-trigger and at-send evaluation of §6.6, including the §6.5 lifecycle matrix, the global freeze and the storm-limit **count**, as a read.
- It **sends nothing**, claims no item and writes no `CommsDelivery` row. It writes one `AutomationRun{mode:"DRY_RUN"}` row with counts, plus the audit row.
- **Result:** v1 `DryRunResult`, plus:
  - `deduped: number`;
  - `lifecycle: Record<UserLifecycleState, number>` (people counts, small-cell withheld as `Aggregate`, v1 §3.1);
  - `content: { channel, source, versionId }[]`;
  - `activationBlockers` (§6.2).
- **Examples** render the **live** content with placeholder `sample` values only (synthetic, v1 §4.7).

### 6.9 `POST /test-send` (replaces v1 §4.8)

```ts
type TestSendRequest = MutationRequest<{
  key: string;
  channel: "EMAIL" | "IN_APP";
  variant?: string;
  versionId?: string;        // any version of this key's stream; default = live content
  fixture?: string;          // a named synthetic case
}>;
interface TestSendResult { deliveryId: string; status: DeliveryStatus; provider: string | null; contentVersionId: string | null }
```

- **The recipient is always the operator.** The server resolves it from the session user's row, and no address or recipient field exists in the request. The O-3 `ALLOWLIST` kind is withdrawn. The operator's email must be verified, otherwise **422 `GUARD_REFUSED`** with `guard: "SELF_UNVERIFIED"`.
- **Eligibility in advance (D6a).** `viewer.testSendEligible` and `viewer.testSendIneligibleReason` (§1.1) report ahead of time the same guard the 422 would return, so the UI can disable the action and explain why. Neither reveals anything about the allowlist beyond whether the operator's own address passes.
- **Outside Production**, the operator's address must also be on `EMAIL_NONPROD_ALLOWLIST` (`lib/email/recipient-guard.ts:56`). Otherwise the server returns **422 `GUARD_REFUSED`** with `guard: "NONPROD_ALLOWLIST"` before any render. The test is refused openly rather than silently captured, so the operator knows nothing arrived.
- **Content:** synthetic values only, a `[TEST]` subject prefix, the `standard` variant, and the locked frame.
- **Ledger:** `mode = "TEST"` (B2 column, §8.6), excluded from analytics by default.
- A test send is OPERATOR-class: it is not lifecycle-evaluated and is exempt from the per-recipient storm limit (#177 exempts OPERATOR mail). The `cs-comms-test` bucket bounds it.
- `protected` definitions may be test-sent with their **code** content: test sends are synthetic and go only to the operator (v1 §4.8). `versionId` on a protected key → 409 `PROTECTED`.
- IN_APP test sends create a bell in the operator's own inbox through `createNotification`, with `metadata._commsTest = true`, auto-archived after 24 h.

---

## 7. Trigger catalog: the owner-approved new notifications

Every trigger is code: a typed payload, the resolvers valid for it and an emitter site (v1 §5.1). Payload fields are names, types and a PII flag, never values. Each trigger moves from `PROPOSED` to `AVAILABLE` in `lib/notifications/catalog/triggers.ts` **in the same PR that ships its emitter**; activation requires `AVAILABLE` (§6.3).

| Trigger | Emitter (B2) | Payload | Resolver | Definition | Consent class | Delivered by |
|---|---|---|---|---|---|---|
| `account.registered` | after commit, `app/api/auth/register/route.ts` | `userId` POINTER string · `invited` boolean · `registeredAt` iso-date | `EVENT_SUBJECT_USER` | `ACCOUNT_WELCOME` · EMAIL | **AWARENESS** (O-5 as recommended) | an automation; condition `recipient.has_verified_email`, delay ≥ 30 min (re-evaluated, so an unverified address is `CANCELLED`/`ELIGIBILITY_FAILED`); dedupe `ACCOUNT_WELCOME:user:{userId}`, never repeats |
| `plaid.item.webhook_needs_reauth` | after `applyWebhookHealthTransition` succeeds with status `NEEDS_REAUTH` (`lib/plaid/webhook-receiver.ts`, step 4c) | `plaidItemId` POINTER · `institutionName` DISPLAY · `errorCode` DISPLAY (Plaid code, closed set) | `EVENT_SUBJECT_USER` | `PLAID_ITEM_REAUTH_REQUIRED` · IN_APP + EMAIL | **SERVICE**, own data | an automation; eligibility `connection.removed_by_user=false`, `connection.status_in [NEEDS_REAUTH]`; dedupe = the `SYNC_FAILED` open key |
| `plaid.item.webhook_revoked` | the same site, status `REVOKED` | `plaidItemId` · `institutionName` · `errorCode` | `EVENT_SUBJECT_USER` | `PLAID_ITEM_REVOKED` · IN_APP + EMAIL | **SERVICE**, own data | an automation; honours `removedByUser` (PR #164); dedupe `PLAID_ITEM_REVOKED:item:{plaidItemId}:open` |
| `wallet.sync.failed` | at the `SyncIssue WALLET_SYNC_FAILED` writes (`lib/crypto/btc-sync.ts`, `eth-sync.ts`, `sol-sync.ts`) | `financialAccountId` POINTER · `network` DISPLAY (`BTC`\|`ETH`\|`SOL`) · `issueCode` DISPLAY (closed) | `EVENT_SUBJECT_USER` | `WALLET_SYNC_FAILED` · IN_APP + EMAIL | **SERVICE**, own data; `emailIndependentOfInApp: true` (the O-7 ruling applied to the same class) | an automation; dedupe `WALLET_SYNC_FAILED:account:{financialAccountId}:open` |
| `platform.grant.created`, `platform.grant.reinstated` | after commit, `app/api/admin/platform-grants/route.ts` | `grantId` POINTER · `granteeUserId` POINTER · `area` DISPLAY · `level` DISPLAY · `reinstated` boolean | `EVENT_SUBJECT_USER` | `PLATFORM_ACCESS_GRANTED` · IN_APP + EMAIL | **SECURITY_CRITICAL**, `protected` | **a code producer, not an automation.** Protected definitions cannot be automated, paused or edited (v1 §2), so it ships as a registry-type plus security-email send at the emitter, locked on |
| `schedule.daily` | — | — | `EVENT_SUBJECT_USER` | `DIGEST_SENT` | AWARENESS | **built OFF:** `BUILD_OFF`; activation always refused (§6.3 rule 3) until O-14 |

- **PII.** No field above is `pii: true`. Names and addresses enter only as RECIPIENT placeholders at render time (§2.3) and never sit on the trigger payload, the ledger or the dedupe key (v1 §2 invariant).
- **`definitionVersion`.** It bumps on each of these definitions when B2 wires them: channels go `defaultOn: true`, and the trigger becomes `AVAILABLE`.

---

## 8. Persistence (PROPOSED, no migration yet)

**House pattern** for every table below, verbatim from `20261031200000_comms_delivery_ledger` and `20261030120000_policy_group_editor`:
- `REVOKE ALL … FROM fm_app, fm_auth, fm_system`;
- `GRANT SELECT … TO fm_backup`;
- the least-privilege grants to `fm_system` listed per table;
- `ENABLE` and `FORCE ROW LEVEL SECURITY`, with `CREATE POLICY fm_system_all … FOR ALL TO fm_system USING (true) WITH CHECK (true)`;
- the `anon/authenticated/service_role` revoke `DO $$` block.

`fm_app` and `fm_auth` get **nothing**: operators read and write through `fm_system`; the send path resolves content through `fm_system` (§5.4), as the ledger writer does (`lib/notifications/delivery/store.ts`).

**Naming.** The two generic names in the brief are prefixed (`CommsTemplateVersion`, `CommsAiSuggestion`), because the Prisma model namespace is flat. `CommsTemplate`, the head row, is added for the optimistic token, as `PolicyGroup` is to `PolicyGroupVersion`.

### 8.1 `CommsTemplate` (head) and `CommsTemplateVersion` (B1)

```prisma
model CommsTemplate {
  id                 String   @id @default(cuid())
  definitionKey      String
  channel            String                 // EMAIL | IN_APP
  variant            String   @default("default")
  publishedVersionId String?                // null = the code default is live
  revision           Int      @default(0)   // optimistic token: +1 on draft save, publish, rollback
  headVersion        Int      @default(0)   // highest version number issued
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@unique([definitionKey, channel, variant])
}

model CommsTemplateVersion {
  id                     String    @id @default(cuid())
  templateId             String                 // FK → CommsTemplate(id) ON DELETE RESTRICT
  version                Int
  subject                String
  preheader              String?
  blocks                 Json                   // ContentBlock[] — validated before insert
  placeholdersUsed       String[]
  contentHash            String                 // sha256 of canonical JSON {subject, preheader, blocks}
  validatorVersion       Int
  createdByKind          String                 // OPERATOR | AI_ASSISTED | ROLLBACK
  actorKind              String                 // PLATFORM_OPERATOR | SYSTEM_ADMIN
  createdById            String?                // soft ref (as PolicyGroupVersion.createdById)
  parentVersionId        String?
  basePublishedVersionId String?
  restoredFromVersionId  String?
  sourceSuggestionId     String?
  aiEditedAfterAccept    Boolean?
  createdAuditLogId      String
  publishedAt            DateTime?              // set ONCE
  publishAuditLogId      String?
  createdAt              DateTime  @default(now())
  @@unique([templateId, version])
  @@index([templateId, createdAt])
}
```

**Grants (`fm_system`).**
- `CommsTemplate`: `SELECT, INSERT, UPDATE`, no DELETE.
- `CommsTemplateVersion`: `SELECT, INSERT`, plus **column-level** `UPDATE ("publishedAt", "publishAuditLogId")` only. The content columns are physically immutable: no role the app uses can change them.

**State is derived, not stored:**
- `PUBLISHED` ⇔ `CommsTemplate.publishedVersionId = id`;
- `SUPERSEDED` ⇔ `publishedAt IS NOT NULL` and not current;
- `DRAFT` ⇔ `publishedAt IS NULL`.

### 8.2 Content audit link

There is no new table. Content audit uses `AuditLog` rows (§9.2), referenced by `createdAuditLogId` and `publishAuditLogId`.

### 8.3 `CommsAiSuggestion` (B1, the AI-suggestion audit)

```prisma
model CommsAiSuggestion {
  id                String    @id @default(cuid())   // = AiInvocation.correlationId
  templateId        String                           // soft ref → CommsTemplate
  baseVersionId     String
  mode              String                           // POLISH | CHECK
  tone              String?
  status            String                           // OFFERED | REJECTED | UNAVAILABLE | ACCEPTED | EXPIRED
  unavailableReason String?                          // KILL_SWITCH | COST_FREEZE | ALLOWANCE | PROVIDER
  unavailableDetail String?                          // the closed detail code (§4.5)
  rejectionCodes    String[]                         // ContentIssueCode values (REJECTED)
  suggestedContent  Json?                            // ContentBody — OFFERED / ACCEPTED only; template text only, no customer data
  suggestedHash     String?
  notes             Json?                            // cleaned notes (OFFERED / ACCEPTED)
  model             String?
  requestedById     String                           // soft ref, operator
  requestAuditLogId String
  acceptedVersionId String?
  expiresAt         DateTime
  createdAt         DateTime  @default(now())
  resolvedAt        DateTime?
  @@index([templateId, createdAt])
  @@index([status, expiresAt])
}
```

**Grants (`fm_system`):** `SELECT, INSERT, DELETE` (retention), plus column-level `UPDATE ("status", "acceptedVersionId", "resolvedAt")`.

### 8.4 `AutomationDefinition`, `AutomationRun`, `AutomationRunItem` (B2)

- **`AutomationDefinition`** is v1 §6.3 plus:
  - `variant String @default("default")`;
  - `customerFacing Boolean` (derived and stored at create; re-derived on PATCH);
  - `ownerApprovedVersion Int?`, `ownerApprovedDefinitionVersion Int?`, `ownerApprovedAt DateTime?`, `ownerApprovedById String?`;
  - `lastDryRunId String?`.
  Grants: `SELECT, INSERT, UPDATE`, no DELETE (disabled rows are kept).
- **`AutomationRun`** is v1 §6.3 plus `haltReason String?`, `dedupedCount Int @default(0)`, and `windowFrom DateTime?` / `windowTo DateTime?` (dry run). Grants: `SELECT, INSERT, UPDATE, DELETE` (retention).
- **`AutomationRunItem`** is **new**, the claim and schedule row:

```prisma
model AutomationRunItem {
  id                 String    @id @default(cuid())   // = CommsDelivery.messageKey of its sends
  runId              String                           // FK → AutomationRun(id) ON DELETE CASCADE
  automationId       String
  automationVersion  Int
  channel            String                           // EMAIL | IN_APP
  recipientUserId    String?                          // soft ref; purge cancels + nulls
  idempotencyKey     String    @unique                // §6.6
  dedupeKey          String?                          // non-PII by construction
  status             String                           // SCHEDULED | SENDING | SENT | SUPPRESSED | CANCELLED | FAILED | DEAD
  reason             String?                          // SuppressionReason
  notBefore          DateTime
  attempt            Int       @default(0)
  nextAttemptAt      DateTime?
  leaseUntil         DateTime?
  lastDeliveryStatus String?                          // the latest DeliveryStatus written to the ledger
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  @@index([status, notBefore])
  @@index([status, nextAttemptAt])
  @@index([runId])
  @@index([automationId, dedupeKey])
  @@index([recipientUserId, createdAt])
}
```

Grants: `SELECT, INSERT, UPDATE, DELETE`.

### 8.5 `CommsProviderEvent` (B3)

As v1 §6.4. Grants: `SELECT, INSERT, DELETE`.

### 8.6 `CommsDelivery` column additions (additive, nullable)

| Column | Phase | Meaning |
|---|---|---|
| `contentVersionId String?` | B1 | the operator version the send rendered; null = code default (§5.4) |
| `mode String @default("LIVE")` | B2 | `LIVE \| TEST` (§6.9) |
| `automationRunItemId String?` + index | B2 | soft ref; equals `messageKey` for automation sends |

The table stays append-only: `fm_system` keeps `SELECT, INSERT, DELETE` and has no UPDATE.

### 8.7 Retention and purge (`jobs/data-retention.ts`)

| Table | Retention |
|---|---|
| `CommsTemplate`, `CommsTemplateVersion` | kept (content history is the audit trail) |
| `CommsAiSuggestion` | `ACCEPTED`: kept (its version references it). Other statuses: 90 days. `OFFERED` past `expiresAt` → `EXPIRED` (sweep) |
| `AutomationDefinition` | kept |
| `AutomationRun`, `AutomationRunItem` | 90 days, in parity with the ledger (O-9). Items cascade with their run |
| `CommsProviderEvent` | 30 days (v1 §6.5) |

**Account purge** (`lib/account-deletion/purge.ts`), in the purge transaction:
- the user's `SCHEDULED` and `SENDING` items become `CANCELLED` / `ACCOUNT_RESTRICTED`;
- `recipientUserId` is nulled on all of their items.

Operator ids (`createdById`, `requestedById`, `ownerApprovedById`) are soft references and stay, like `PolicyGroupVersion.createdById`.

---

## 9. Errors and audit (consolidated additions)

### 9.1 Error codes (additions to v1 §3.4)

| HTTP | `code` | When |
|---|---|---|
| 400 | `CONTENT_INVALID` | content validation errors; the body carries `issues: ContentIssue[]` (§2.5) |
| 409 | `PROTECTED` | **every write** to a protected definition or a locked leg: versions, publish, rollback, ai-suggest, automation create or PATCH, test send with `versionId` |
| 409 | `NOT_EDITABLE` | a non-protected leg that is not content-editable (banner, excluded channel, VOCABULARY/PROPOSED/BUILD_OFF/RETIRED) |
| 409 | `CONFLICT` | `expectedRevision` (content) or `expectedVersion` (automation) is stale. Body `{ error, code: "CONFLICT", current: number }` (D5, §0.3) |
| 409 | `STALE_DRAFT` | the draft's `basePublishedVersionId` is not live any more |
| 409 | `WARNINGS_UNACKNOWLEDGED` | publish with warnings and `acknowledgeWarnings: false` |
| 409 | `SUGGESTION_EXPIRED` | saving from a suggestion that is not OFFERED or has expired |
| 409 | `OWNER_APPROVAL_REQUIRED` | activating a customer-facing automation without a current owner approval |
| 409 | `DRY_RUN_REQUIRED` | activating without a current successful dry run |
| 409 | `INVALID_STATE` | v1 meaning, plus: publishing a non-DRAFT version, rolling back to a DRAFT or the live version, MARKETING, BUILD_OFF, a non-AVAILABLE trigger |
| 422 | `SUGGESTION_REJECTED` | the AI output failed §4.4 checks; `issues` only, no text |
| 422 | `GUARD_REFUSED` | test send: `guard: "SELF_UNVERIFIED" \| "NONPROD_ALLOWLIST"` |
| 503 | `AI_UNAVAILABLE` | `reason: KILL_SWITCH \| COST_FREEZE \| ALLOWANCE \| PROVIDER` (§4.5) |

### 9.2 Audit

**New AuditActions:**
- `COMMS_TEMPLATE_DRAFT_SAVED` (reason optional);
- `COMMS_TEMPLATE_AI_SUGGESTED` (reason optional);
- `COMMS_TEMPLATE_PUBLISHED` (**reason required**);
- `COMMS_TEMPLATE_ROLLED_BACK` (**reason required**);
- `COMMS_AUTOMATION_OWNER_APPROVED` (**reason required**);
- plus v1's `COMMS_AUTOMATION_*`, `COMMS_TEST_SEND` and `CUSTOMER_DELIVERY_HISTORY_VIEWED`.

The required ones join `REASON_REQUIRED_ACTIONS` (`lib/audit.ts:221`).

**`OperatorTargetKind`** (`lib/audit.ts:199`) gains `"COMMS_TEMPLATE"` (id `<key>:<channel>:<variant>`), `"COMMS_AUTOMATION"` and `"COMMS_TEST_SEND"`.

**Change to `recordOperatorAction`** (PROPOSED). It returns `Promise<{ id: string }>` (today `Promise<void>`, `lib/audit.ts:366`), so that `auditLogId` can be returned and stored in the same transaction. The change is backward compatible: existing callers ignore the value.

**Same transaction, always.** Draft save, publish, rollback, suggestion-row insert, owner approval, activation, pause, disable and test send each write their audit row inside the `$transaction` that changes state. The audit write is a precondition: a failed audit write rolls back the change (v1 §3.5).

---

## 10. Phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **B1**: versions, editor support, preview, AI suggest | Migration: `CommsTemplate`, `CommsTemplateVersion`, `CommsAiSuggestion`, `CommsDelivery.contentVersionId`. Content validator and lint (`lib/notifications/content/*`); placeholder allowlists and code defaults for every editable leg; `renderWithLiveContent` (in-app) and the live-content email path; `operator-content` template; the §3 endpoints, the `?versionId=` preview and `POST /render` (D3); `viewer` (D2) and `ai` availability (D4); `ai-suggest` with the §4.5 order and the §4.6 authoring allowance (reservation generalised to a surface set); `recordOperatorAction` returns its id; new audit actions and target kinds; `contentEditable` / `content` on the catalog DTO | No published version ⇒ every editable leg renders **byte-identical** to today (parity tests); 409 `PROTECTED` pinned for every write × every protected key; the AI request test proves only template text and placeholder names leave (§4.2); kill switch, GLOBAL freeze (`ON`/`INVALID`/`UNAVAILABLE`), allowance and provider each yield their typed 503, and a Beta-group-only freeze does not (D1); manual save, preview and publish pass with AI paused |
| **B2**: automations, dry run, test send, activation | Migration: `AutomationDefinition`, `AutomationRun`, `AutomationRunItem`, `CommsDelivery.mode` and `.automationRunItemId`. The engine (§6.6) on the dispatcher wake; the BUILD emitters (§7) with trigger status → AVAILABLE in the same PRs; the three BUILD in-app legs moved into `NOTIFICATION_REGISTRY`; `PLATFORM_ACCESS_GRANTED` as a code producer; the §6.5 matrix in the send path (including the registry AWARENESS EMAIL-leg change); global breaker and alert kind; dry run; test send (§6.9); owner approval (§6.4); activation (§6.3) | No customer-facing automation can reach ACTIVE without a current `ownerApprovedVersion` (test); dry-run counts equal live counts on replay; replayed triggers create zero items; global freeze verdict (`readGlobalCostFreeze`) ⇒ HALTED runs with zero sends, while a Beta-group-only freeze suppresses only that group's recipients (D1); the four BUILD messages run only behind owner-approved ACTIVE automations |
| **B3**: webhook delivery confirmation and remaining migrations | Migration: `CommsProviderEvent`. `POST /api/webhooks/resend` (§10.1); a delivery event **appends** a `CommsDelivery` row with the same `messageKey` and `attempt` and status `DELIVERED`, `BOUNCED` or `COMPLAINED`, which wins as the final status under the v1.0.2 tie rule (latest `createdAt`); `delivery_delayed` records the event only; reconciliation flags `ACCEPTED` with no event after 72 h (never resends); `notification-retry` moves onto `CommsDelivery` and `NotificationDelivery` is frozen; O-6 Space-invite fold; anomaly fan-out (D-4) and `emailStatus` copies (D-5) folded; retention entries for every Phase B table | `measured.delivered` turns true when the secret is set and at least one verified event exists; one ledger and one retry path; Platform Ops email health reads `CommsDelivery` |

### 10.1 `POST /api/webhooks/resend` (B3)

- A **machine route**:
  - no session;
  - listed in the write-origin machine-route census (`lib/security/write-origin.test.ts`);
  - `RESEND_WEBHOOK_SECRET` (env **name**) holds the svix `whsec_…` secret.
- **Verification** uses `node:crypto` and adds no new dependency:
  1. take the `svix-id`, `svix-timestamp` and `svix-signature` headers;
  2. reject when the timestamp is outside ±5 min;
  3. compute `HMAC-SHA256(base64decode(secret without "whsec_"), "${id}.${timestamp}.${rawBody}")` and compare it, in constant time, against each space-separated `v1,<base64>` entry.
- Unverified bodies → 401. They are never stored and never logged in full.
- **Replay** → `providerEventId @unique` (the svix id), so a duplicate is acknowledged and ignored.

### 10.2 v1.2 note — Phase C as built (2026-10-31)

- **Route:** `POST /api/webhooks/resend` (`app/api/webhooks/resend/route.ts`; decision in `lib/notifications/delivery/provider-events.ts`, verification in `lib/notifications/delivery/svix.ts`). Listed in `MACHINE_WRITE_PATHS`.
- **Inert until configured:** with no usable `RESEND_WEBHOOK_SECRET` every request is **503 `UNAVAILABLE`** and nothing is verified, read, stored or counted.
- **Order:** inert check → per-IP rate limit (600/min) → body cap (64 KB; Content-Length pre-check, then the raw body) → svix verify (401; counted by reason only, under `ApiUsageCounter` provider `RESEND_WEBHOOK`, unit `rejections`) → parse (400) → classify → match → one transaction (event insert + optional ledger append). A duplicate svix id is **200 `{ duplicate: true }`** and writes nothing. A store failure is 500, so Resend retries; the transaction left nothing behind.
- **Stored types:** `delivered | bounced | complained | delivery_delayed` only. `email.opened` / `email.clicked` (O-13) and every other type are acknowledged and **dropped before any read or write**.
- **`CommsProviderEvent`** (migration `20261031230000_comms_provider_events`): `providerEventId` (svix id, unique), `type`, `providerMessageId`, `deliveryId` and `messageKey` (soft refs; null = unmatched), `outcome` (`APPLIED | NO_CHANGE | NOTE | UNMATCHED`), `occurredAt`, `receivedAt`. No address, subject, body, bounce text or payload. Grants: fm_system `SELECT, INSERT, DELETE`.
- **Retention: 90 days** (owner decision 2026-10-31). This supersedes the 30 days in §8.7 and v1 §6.5.
- **Reconciliation:** by Resend message id (`CommsDelivery.providerMessageId`, which A-2a already stores; now indexed). A status-moving event **appends** a ledger row (same `messageKey` and `attempt`) with `DELIVERED`, `BOUNCED` or `COMPLAINED`. The new nullable `CommsDelivery.deliveredAt` holds the provider's delivery instant. **Forward only**, ranked `ACCEPTED < DELIVERED < BOUNCED < COMPLAINED`: a late `delivered` never overwrites `BOUNCED`/`COMPLAINED`, and a repeat is `NO_CHANGE`. `delivery_delayed` is a `NOTE` and never writes the ledger. An event for an attempt that a later attempt superseded is `NO_CHANGE`. An unknown id is stored `UNMATCHED` and never creates a ledger row.
- **§4.11 analytics:** the type is now `measured: { delivered: boolean; opens: false; clicks: false }`. `delivered` is **per environment**: it is true only when the secret is configured **and** at least one verified event exists. Only then are the optional `series.delivered`, `series.bounced` and `series.complained` present. The six C4 keys are unchanged. A delivered message counts once, as `DELIVERED`, not also as `ACCEPTED`.
- **Platform Ops email health** (`GET /api/platform/platform-ops/email-health`) gains a read-only `webhook` block: `configured`, `lastVerifiedEventAt`, `countsByType`, `unmatched`, `signatureFailures {total, byReason}`, and `acceptedWithoutEvent72h` (ACCEPTED with no outcome after 72 h; a flag, never a resend; null until configured).
- **N-b:** an `UNCERTAIN_ACCEPTANCE` send has no provider message id, so it can never match an event. Its ACCEPTED row is **expected-unmatchable** (`isExpectedUnmatchable`). It is excluded from `acceptedWithoutEvent72h` and reported separately as `acceptedUncertain72h`.
- **Review fixes (F1–F6, 2026-10-31):**
  - **F1:** match, decide and write run in one transaction, serialised per message by `pg_advisory_xact_lock(hashtext('comms-msg:<channel>:<messageKey>'))`, with a re-read after the lock. Within an attempt the current status is rank-aware (COMPLAINED > BOUNCED > DELIVERED > other) in the decision, the analytics read and the rollup.
  - **F2:** an event with no ledger row yet, whose own `created_at` is under 5 min old, gets **409 `RETRY`** and is not stored. Its svix id is not consumed, so svix redelivers it. Older unknown ids are stored UNMATCHED.
  - **F3:** `measured.delivered` ignores UNMATCHED events.
  - **F4:** the 64 KB cap is enforced while streaming, with a running byte count, so a chunked body is capped too.
  - **F5:** unchanged. The per-IP limit is a coarse bound, because svix egress IPs are shared.
  - **F6:** the route-guard census credits `handleResendWebhook`.
  - No migration.
- **§4.11 `acceptedUncertain?: number | null`** (additive, optional; Session 2 request): the final-ACCEPTED provider emails with no provider id (R4 `UNCERTAIN_ACCEPTANCE`, "accepted, can't be confirmed").
  - It is a subset of `totals.ACCEPTED`, scoped to the same environment, observed window and channel/template filters.
  - It is 0 under any status filter other than ACCEPTED, and null when nothing is observed.
- **Follow-ups, not built:** a recipient **suppression list** fed by `BOUNCED`/`COMPLAINED` final statuses (the contract does not specify one); the `notification-retry` move and the remaining B3 folds.

---

## 11. Owner decisions

### 11.1 Closed by this delta (recorded, no action)

- **O-1:** activation = CONTROL.
- **O-2:** no broadcast in v1.
- **O-3:** SELF only, with the non-prod allowlist check outside Production.
- **O-4:** environment guard, as shipped in A-2.
- **O-11:** superseded; operator content editing is allowed under §2–§4.
- **O-12:** no MARKETING.
- **O-14:** digest built OFF.
- **O-15:** Resend webhook approved for B3.
- **O-16:** resolved by `getBetaLifecycleStatesForUsers`.
- **The lifecycle matrix:** owner rule, §6.5.
- **The owner-approval gate:** §6.4.

### 11.2 Adopted defaults (inform; change by saying so)

| Item | Default |
|---|---|
| O-5 welcome consent class | AWARENESS, both invite paths, once per user, after verification (§7) |
| Authoring AI caps | $2.00 and 40 calls per operator per UTC day; $10.00 fleet per day (§4.6) |
| Global automation breaker | 200 accepted automation sends per 10 min (§6.7) |
| Suggestion expiry | 24 h |
| `WALLET_SYNC_FAILED` email independence | follows the O-7 ruling for SERVICE sync failures (§7) |

### 11.3 Defaults agreed with Session 2, reported to the owner

There are no open owner decisions. Session 2 agreed O-17 and O-18 as recommended (2026-10-31). They are recorded as defaults and reported to the owner, who may overrule either.

| # | Decision | Default (in force) |
|---|---|---|
| **O-17** | The owner rule suppresses "AWARENESS sends" on PAUSED, ENDED, COST_FREEZE and UNKNOWN. Does that include **in-app bells from existing registry producers** (Space role changed, import completed), or only email and automation sends? | Email legs and all automation sends are suppressed; registry IN_APP bells keep being created. They cost nothing, and they are part of the product the paused customer can still sign in to |
| **O-18** | Who may record `ownerApprovedVersion`? | `requireFreshSystemAdmin` (the owner's role). A CS CONTROL grant is not enough |

---

## 12. Endpoint index (v1.1)

20 endpoints in all: 19 on the Comms Center API (18 new, plus the preview extended) and 1 machine webhook.

| # | Method and path | Phase | Gate |
|---|---|---|---|
| 1 | `GET /catalog/[key]/versions` | B1 | CS READ |
| 2 | `POST /catalog/[key]/versions` | B1 | CS WRITE |
| 3 | `GET /catalog/[key]/versions/[id]` | B1 | CS READ |
| 4 | `POST /catalog/[key]/versions/[id]/publish` | B1 | CS CONTROL + reason |
| 5 | `POST /catalog/[key]/versions/[id]/rollback` (`[id]` or `code-default`) | B1 | CS CONTROL + reason |
| 6 | `POST /catalog/[key]/versions/[id]/ai-suggest` | B1 | CS WRITE |
| 7 | `GET /catalog/[key]/preview?versionId=` (extended) | B1 | CS READ |
| 7a | `POST /catalog/[key]/render` (unsaved content, D3) | B1 | CS READ (`cs-comms-render` 30/min) |
| 8 | `GET /automations` | B2 | CS READ |
| 9 | `POST /automations` | B2 | CS WRITE |
| 10 | `GET /automations/[id]` | B2 | CS READ |
| 11 | `PATCH /automations/[id]` | B2 | CS WRITE |
| 12 | `POST /automations/[id]/dry-run` | B2 | CS WRITE |
| 13 | `POST /automations/[id]/owner-approval` | B2 | SYSTEM_ADMIN (fresh) |
| 14 | `POST /automations/[id]/activate` | B2 | CS CONTROL |
| 15 | `POST /automations/[id]/pause` | B2 | CS WRITE |
| 16 | `POST /automations/[id]/disable` | B2 | CS WRITE |
| 17 | `GET /automations/[id]/runs` | B2 | CS READ |
| 18 | `POST /test-send` | B2 | CS WRITE |
| 19 | `POST /api/webhooks/resend` | B3 | svix signature |

All paths except #19 are under `/api/platform/customer-success/notifications`.
