# Communications Center: Infrastructure API Contract v1 (2026-10-31)

**Status.** v1 — approved by Session 2 (2026-10-31) with C1–C8 applied. Session 1 owns this contract and the infrastructure behind it: registry, delivery orchestration, automation engine, observability and APIs. Session 2 owns the Customer Success UI. **This document designs no UI.**

**Basis.**
- Facts and gaps come from `docs/plans/COMMS-CENTER-NOTIFICATION-ARCHITECTURE-AUDIT-2026-10-31.md` (cited below as **AUDIT §n**). Code citations are against `develop` `bbfb2e0`.
- Everything below the "Existing" rows is **PROPOSED**. There is no migration and no route yet.
- **OWNER DECISION** items are collected in §9.

**Session 2 review changes applied (2026-10-31):**
- **C1:** two nulls, not observed vs withheld (§3.1, §4.12, §4.14).
- **C2:** dense, self-describing day series (§3.1).
- **C3:** full status vectors (§4.11).
- **C4:** six fixed series (§4.11).
- **C5:** beta lifecycle and cost-freeze guard, with a matrix (§5.6, §5.6.1).
- **C6:** provider-health link (§4.11).
- **C7:** readRate, population and catalog sort (§4.14, §4.12, §4.2).
- **C8:** row types, run counts, dry-run window, 503 rule and subscriptions (§4.6, §4.7, §4.11–§4.14, §7).

---

## 0. Agreed constraints (from Session 2) and how this contract meets them

| Constraint | Where it is met |
|---|---|
| Base path `/api/platform/customer-success/notifications/...` | §4 |
| Reads: `requirePlatformAccess("CUSTOMER_SUCCESS","READ")` (`lib/platform/authorize.ts:198-205`) | §4, every GET |
| Mutations: `requireFreshPlatformAccess("CUSTOMER_SUCCESS","WRITE")` (`authorize.ts:213-220`), a structured reason (`parseOperatorReason`, `lib/audit.ts:307-319`) and `recordOperatorAction` **in the same transaction** as the change (`lib/audit.ts:358-360`; pattern `lib/platform/policies/mutate.ts`) | §4.1 |
| Many-recipient actions proposed as CONTROL | §4.1, O-1 / O-2 |
| `checkedAt` plus explicit floor/cap flags on every list; day series `{day, count \| null}` | §3.1 |
| "Accepted by provider" kept apart from "delivered"; no opens or clicks | §3.3 |
| Catalog items carry `protected`, `editable`, `supportedActions` | §2.1 |
| No recipient emails or bodies in list or analytics payloads; previews are synthetic; per-customer history goes through the audited `customers/[userId]` path | §3.2, §4.6, §4.13 |
| Reuse email health, notices, in-app create/read and `ops_alerts`; do not duplicate them | §4.11, §4.12, §4.14 |

---

## 1. Vocabulary

```ts
/** Existing (lib/notifications/types.ts:76,83,91-97) — reused verbatim. */
type NotificationChannel = "IN_APP" | "EMAIL" | "PUSH" | "SMS" | "WEBHOOK";
type NotificationPriorityValue = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
type NotificationCategory = "ACCOUNT_SECURITY" | "SPACES" | "FINANCIAL" | "AI" | "PLATFORM" | "DIGEST";

/** PROPOSED. Comms-level channels: the two delivery channels plus two READ-ONLY surfaces. */
type CommsChannel = "IN_APP" | "EMAIL" | "OPERATOR_EMAIL" | "BANNER";

/** PROPOSED. Preview renditions (the GET /catalog/[key]/preview ?channel= values). */
type PreviewChannel = "email-html" | "email-text" | "in-app" | "operator" | "banner";

/**
 * PROPOSED. Consent class — what may suppress a message. It is ORTHOGONAL to the
 * preference category (which is the user-facing matrix row).
 *   SECURITY_CRITICAL — never suppressible by any preference; never pausable by an automation
 *   CEREMONY          — part of a flow the user started (reset/verify/confirm); never suppressible
 *   SERVICE           — about the user's own service state (reauth, sync failed); see O-7
 *   AWARENESS         — product awareness; the user's category × channel preference applies
 *   MARKETING         — none exist today; reserved, requires explicit opt-in + unsubscribe (O-12)
 *   OPERATOR          — staff/inbox audience; governed by grants, not customer preferences
 */
type ConsentClass = "SECURITY_CRITICAL" | "CEREMONY" | "SERVICE" | "AWARENESS" | "MARKETING" | "OPERATOR";

type Audience =
  | "ACCOUNT_HOLDER"            // the userId the event is about
  | "SPACE_MEMBER"              // a member of the event's Space (resolver picks which)
  | "APPLICANT"                 // a pre-account address (beta invite)
  | "OPERATOR_INBOX"            // an env-named mailbox (PLATFORM_ALERTS_EMAIL, SECURITY_ALERTS_EMAIL, BETA_REQUESTS_EMAIL)
  | "PLATFORM_STAFF";           // ACTIVE grant holders of an area (+ SYSTEM_ADMIN)

type Severity = "info" | "notice" | "warning" | "critical";

/** Lifecycle of a CATALOG item (not of a send). Extends registry `VOCABULARY | WIRED` (types.ts:185). */
type DefinitionStatus =
  | "ENABLED"          // a producer emits it (registry WIRED, or a direct-send call site)
  | "BUILD"            // owner-approved, not yet wired
  | "BUILD_OFF"        // to be built but shipped disabled pending an owner proposal (Digest)
  | "PROPOSED"         // candidate; not approved; never sends
  | "VOCABULARY"       // declared only (registry VOCABULARY)
  | "NONE_BY_DESIGN"   // deliberately no message (beta denial)
  | "RETIRED";         // tombstone; key is never reused
```

---

## 2. Registry definition type (code-defined, PROPOSED)

The catalog is a **code registry**, compile-checked and migration-free, like `NOTIFICATION_REGISTRY` (`lib/notifications/registry.ts:116-651`). It is a superset. In-app types **reference** their existing registry entry by id, and nothing is duplicated. Direct-send messages (ceremony, security email, operator, beta) gain entries for the first time.

```ts
/** PROPOSED — lib/comms/catalog/types.ts */
interface CommsDefinition {
  /** Stable, immutable, F2 grammar (DOMAIN_OBJECT_EVENT). Equals the NOTIFICATION_REGISTRY id when one exists. */
  key: string;
  /** Bumped on any change to channels, consent, eligibility, audience, trigger or payload (see §2.2). */
  definitionVersion: number;
  displayName: string;                 // operator-facing, e.g. "Institution needs attention"
  description: string;                 // one or two sentences: when it is sent and why
  status: DefinitionStatus;
  category: NotificationCategory | "OPERATOR" | "CEREMONY";
  audience: Audience;
  consentClass: ConsentClass;
  severity: Severity;                  // maps from registry priority: LOW→info, NORMAL→notice, HIGH→warning, CRITICAL→critical
  /** Pointer into the existing registry for IN_APP; null when the definition has no in-app leg. */
  notificationTypeId: import("@/lib/notifications/registry").NotificationTypeId | null;

  channels: ReadonlyArray<{
    channel: CommsChannel;
    defaultOn: boolean;
    /** Email template + its own version; for IN_APP the registry render is the template. */
    template: { id: string; version: number } | null;
    /** How this leg is delivered today. "DIRECT" = sendEmail() outside createNotification (the F12 bypasses). */
    path: "REGISTRY" | "DIRECT" | "READ_ONLY_SURFACE";
  }>;

  trigger: {
    /** A key from the controlled trigger catalog (§5.1), or a code-site trigger for legacy producers. */
    kind: "TRIGGER" | "CALL_SITE";
    triggerKey: TriggerKey | null;
    /** Repo-relative file:line of the producer(s), for the catalog's "where does this come from". */
    sources: readonly string[];
  };

  /** Typed payload; replaces the untyped pointerContract names (types.ts:191) for new definitions. */
  payload: ReadonlyArray<{
    name: string;
    kind: "POINTER" | "DISPLAY" | "LINK";   // LINK = a ceremony URL (never persisted)
    type: "string" | "number" | "boolean" | "iso-date" | "string[]";
    required: boolean;
    /** True when the value can identify a person (address, login identifier, IP, name). Never persisted to the delivery ledger; never in analytics. */
    pii: boolean;
  }>;

  /** Closed predicate keys (§5.2) evaluated at schedule time AND immediately before send. */
  eligibility: readonly EligibilityPredicate[];

  preference: {
    /** Matrix row the user controls; null when consentClass forbids suppression. */
    category: NotificationCategory | null;
    userSuppressible: boolean;          // derived: false for SECURITY_CRITICAL | CEREMONY | OPERATOR
    /** Channels the user can turn off (subset of channels). */
    suppressibleChannels: readonly CommsChannel[];
  };

  dedupe: { strategy: "none" | "suppress" | "window"; keyTemplate: string | null; windowMinutes: number | null };
  frequencyCap: { max: number; perHours: number } | null;   // per recipient per key

  /** Operator side. */
  protected: boolean;                   // true ⇒ no operator action may disable, pause or re-route it
  editable: boolean;                    // true ⇒ an AutomationDefinition may target it (§5)
  supportedActions: readonly SupportedAction[];
  /** Where the writer lives when the Comms Center is read-only for it. */
  ownerSurface: { area: "PLATFORM_OPS" | "GROWTH_REVENUE" | "SECURITY_OPS" | "CUSTOMER_SUCCESS"; href: string } | null;
}

type SupportedAction =
  | "PREVIEW" | "TEST_SEND" | "VIEW_DELIVERY"
  | "AUTOMATE"                        // may be the target of an automation
  | "PAUSE_AUTOMATION" | "ACTIVATE_AUTOMATION"
  | "LINK_OUT";                       // managed elsewhere (banners, alerts, Growth)
```

**Invariants (to be enforced by tests):**
- `consentClass ∈ {SECURITY_CRITICAL, CEREMONY}` ⇒ `protected = true`, `userSuppressible = false` and `supportedActions ∌ PAUSE_AUTOMATION`.
- `consentClass = MARKETING` ⇒ `preference.category ≠ null` and it is never `protected`.
- `notificationTypeId ≠ null` ⇒ `NOTIFICATION_REGISTRY[id]` exists. Its `category` and `priority` must agree with this definition's `category` and `severity`.
- No `payload` field with `kind = "LINK"` may appear in a `dedupe.keyTemplate`. No field with `pii = true` may either. This closes AUDIT R-3 for new definitions.
- Every production `sendEmail` call site names a catalog key (Phase A). A grep test, like PR #164's `catalog.test.ts`, fails on a call site with no key.

### 2.1 Catalog DTO (what the API returns)

```ts
interface CatalogItem {
  key: string;
  definitionVersion: number;
  displayName: string;
  description: string;
  status: DefinitionStatus;
  category: CommsDefinition["category"];
  audience: Audience;
  consentClass: ConsentClass;
  severity: Severity;
  channels: Array<{ channel: CommsChannel; defaultOn: boolean; templateVersion: number | null; path: "REGISTRY" | "DIRECT" | "READ_ONLY_SURFACE" }>;
  userSuppressible: boolean;
  protected: boolean;
  editable: boolean;
  supportedActions: SupportedAction[];
  ownerSurface: { area: string; href: string } | null;
  /** Count of automations targeting this key, by state. */
  automations: { draft: number; active: number; paused: number };
}

interface CatalogDetail extends CatalogItem {
  trigger: CommsDefinition["trigger"];
  payload: Array<Omit<CommsDefinition["payload"][number], never>>; // field NAMES + flags; never values
  eligibility: EligibilityPredicate[];
  dedupe: CommsDefinition["dedupe"];
  frequencyCap: CommsDefinition["frequencyCap"];
  retention: { inAppArchiveDays: number | null; inAppDeleteDays: number | null; deliveryDays: number };
  /** Last 30 UTC days, from the delivery ledger (Phase A); null days = not observed. */
  recent: DaySeries;
}
```

### 2.2 Versioning rules

1. **`key` is immutable.** A key whose meaning changes becomes a new key, and the old one is `RETIRED`. A key is never reused (the AuditAction "grandfather, never rename" rule, `registry.ts:17-25`).
2. **`template.version` bumps** on any change to rendered copy, layout or CTA. It is recorded on every delivery row, so a past send can be tied to its template.
3. **`definitionVersion` bumps** on any change to channels, defaults, consent class, eligibility, audience, trigger, payload, dedupe or frequency cap.
4. Versions live **in code**, so a change means a PR, review and CI. The DB never edits a definition. Automations (§5) are the only DB-editable layer, and they reference `key@definitionVersion`.
5. When a definition's version moves past the version an ACTIVE automation was activated against, the engine **pauses** that automation with `autoPausedReason = "DEFINITION_CHANGED"`. An operator must re-activate it.
6. The registry `status` maps to catalog `status`: `WIRED` → `ENABLED`, `VOCABULARY` → `VOCABULARY`. New statuses are catalog-only.

---

## 3. Shared response conventions

### 3.1 Lists and series

```ts
interface ListEnvelope<T> {
  items: T[];
  /** ISO time the server computed this response. */
  checkedAt: string;
  /** Opaque cursor; null = no more pages. */
  nextCursor: string | null;
  /** Page size actually applied (default 50, max 100). */
  limit: number;
  /** True when a server-side scan ceiling was hit, so totals are a FLOOR (the incidents-daily idiom, lib/platform/customer/incidents-daily.ts:52). */
  floor: boolean;
  /** True when items were truncated at a hard cap regardless of cursor (e.g. a fixed top-N). */
  capped: boolean;
}

/** C1 — null = NOT OBSERVED (no ledger coverage), never 0. */
type Count = number | null;

/**
 * C1 — a scalar aggregate. `withheld: true` = observed but suppressed as a small
 * cell (1–4, §4.12); `value` is then null. `withheld: false` with `value: null`
 * = not observed. The two nulls are never conflated.
 */
type Aggregate = { value: number | null; withheld: boolean };

/**
 * C1 + C2 — DENSE and self-describing. Every UTC day in [from, to] appears once,
 * ascending, no gaps. Days before `coverage.ledgerSince` (or before the
 * retention floor) are `count: null`; observed days with no sends are `0`.
 * A small-cell day is `{ count: null, withheld: true }`.
 */
type DaySeries = {
  window: "7d" | "30d" | "90d";
  from: string;                        // YYYY-MM-DD UTC, first day in the series
  to: string;                          // YYYY-MM-DD UTC, last day (today, UTC)
  days: Array<{ day: string /* YYYY-MM-DD UTC */; count: Count; withheld?: true }>;
  floor: boolean;
};
```

- `days.length` always equals the number of UTC days in the window (7, 30 or 90).

- Pagination is keyset on `(createdAt desc, id desc)`. The cursor is base64url of that pair and opaque to clients.
- The window parameter is `window=7d|30d|90d` (default `7d`). A window longer than the delivery retention window (§6) returns `null` days before the retention floor.

### 3.2 PII rule for payloads

List and analytics payloads carry **no** recipient address, no `userId`, no name, no title, body or link, and no `metadata` values. They may carry:
- catalog keys;
- channels, statuses and reasons;
- counts and timestamps;
- opaque `deliveryId` values.

Per-customer rows are served only by §4.13.

### 3.3 Delivery status vocabulary (PROPOSED)

```ts
type DeliveryStatus =
  | "QUEUED"        // persisted, provider not yet called
  | "SCHEDULED"     // delayed; notBefore in the future
  | "SUPPRESSED"    // not sent by policy — reason required
  | "CANCELLED"     // was QUEUED/SCHEDULED; pre-send re-evaluation or operator pause stopped it
  | "CAPTURED"      // in-memory transport (no provider); never counted as accepted outside development
  | "ACCEPTED"      // provider API accepted (Resend returned an id). NOT "delivered".
  | "FAILED"        // provider/adapter error; retryable
  | "DEAD"          // FAILED at the attempt cap; terminal
  | "DELIVERED"     // provider webhook (signature-verified) reported delivery — Phase C only
  | "BOUNCED"       // webhook only — Phase C
  | "COMPLAINED";   // webhook only — Phase C

type SuppressionReason =
  | "PREFERENCE_OFF" | "NO_RECIPIENT" | "OBSOLETE"            // OBSOLETE = read/archived/expired before retry
  | "DEDUPE_OPEN" | "FREQUENCY_CAP" | "ELIGIBILITY_FAILED"
  | "ADMISSION_REFUSED"                                        // maintenance / ingestion pause (lib/platform/admission)
  | "ACCOUNT_RESTRICTED"                                       // deactivated / deletion pending (schema.prisma:396-401)
  | "BETA_LIFECYCLE" | "ENTITLEMENT" | "PROVIDER_FREEZE"
  | "ENVIRONMENT_GUARD"                                        // Preview/allowlist guard (O-4)
  | "AUTOMATION_PAUSED" | "STORM_BREAKER";
```

**Mapping of today's values** (`NotificationDelivery.status`, `prisma/schema.prisma:3816`):
- `sent` → `ACCEPTED`. The legacy `deliveredAt` is read as `acceptedAt` (AUDIT §1.11).
- `captured` → `CAPTURED`.
- `error` → `FAILED` while `attempts < 3`, else `DEAD` (`jobs/retry-notifications.ts:64`).
- `skipped` → `SUPPRESSED` with reason `NO_RECIPIENT`, or `OBSOLETE` when it was closed by the retry job. The two are indistinguishable today, so legacy rows report `reason: null`.

**No open or click tracking.** There are no tracking pixels and no link rewriting (O-13).

### 3.4 Errors

The house shape is `{ error: string, code?: string }` (`app/api/platform/platform-ops/operational-controls/route.ts:55-60`).

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION` | malformed body, unknown key or predicate, unsafe reason note (`assertOperatorNoteSafe`, `lib/audit.ts:293-300`) |
| 401 | — | no session (`requireUser`) |
| 403 | — or `OPERATOR_TOTP_REQUIRED` | insufficient grant / operator 2FA (`authorize.ts:60-65`) |
| 404 | `NOT_FOUND` | unknown key, automation or run |
| 409 | `CONFLICT` | `expectedVersion` (optimistic token) is stale; nothing written |
| 409 | `PROTECTED` | the action targets a `protected` definition |
| 409 | `INVALID_STATE` | e.g. activate from DISABLED, edit an ACTIVE automation |
| 422 | `GUARD_REFUSED` | test send refused by recipient restriction or environment guard |
| 429 | `RATE_LIMITED` | `limitByUser` bucket (`lib/rate-limit.ts:39`) |
| 503 | `UNAVAILABLE` | the ledger (or source table) could not be read. Payloads never fabricate zeros, empty lists or all-null series; every read endpoint in §4.11–§4.14 states this explicitly (C8) |

### 3.5 Mutation envelope (all POST/PATCH)

```ts
interface MutationRequest<B> {
  reason: { code: import("@/lib/audit").OperatorReasonCode; note?: string };  // lib/audit.ts:207-216
  expectedVersion?: number;   // required on PATCH and state transitions
  body: B;
}
interface MutationResult<T> { ok: true; result: T; auditLogId: string }
```

- **Audit:** one `recordOperatorAction` row **inside the same `$transaction`** as the state change. `actor` comes from `operatorActorFrom(auth, "CUSTOMER_SUCCESS")` (`lib/platform/operator-actor.ts`). The `target` uses new `OperatorTargetKind` values `"COMMS_AUTOMATION"` and `"COMMS_TEST_SEND"` (extending `lib/audit.ts:199-205`). `change` holds ids, enums and counts only.
- **New AuditActions**, all added to `REASON_REQUIRED_ACTIONS` (`lib/audit.ts:221`):
  - `COMMS_AUTOMATION_CREATED`, `_UPDATED`, `_ACTIVATED`, `_PAUSED`, `_DISABLED`;
  - `COMMS_AUTOMATION_DRY_RUN`;
  - `COMMS_TEST_SEND`;
  - `CUSTOMER_DELIVERY_HISTORY_VIEWED` (read audit, same fail-closed pattern as `CUSTOMER_PROFILE_VIEWED`, `customers/[userId]/route.ts:29-40`).

---

## 4. Endpoints

Base path: `/api/platform/customer-success/notifications`. All responses are `Cache-Control: no-store`.

### 4.1 Gating matrix

| Endpoint | Gate | Reason + same-tx audit | Rate bucket |
|---|---|---|---|
| `GET /catalog`, `/catalog/[key]`, `/catalog/[key]/preview`, `/triggers`, `/automations`, `/automations/[id]`, `/automations/[id]/runs`, `/delivery`, `/preferences`, `/in-app`, `/banners` | CS **READ** | — | `cs-comms-read` 120/min |
| `POST /automations` (create draft), `PATCH /automations/[id]` | fresh CS **WRITE** | yes | `cs-comms-write` 20/min |
| `POST /automations/[id]/dry-run` | fresh CS **WRITE** (it writes an AutomationRun row) | yes | `cs-comms-dryrun` 10/min |
| `POST /test-send` | fresh CS **WRITE** | yes | `cs-comms-test` 5/10 min |
| `POST /automations/[id]/pause`, `/disable` | fresh CS **WRITE** (reduces sending) | yes | `cs-comms-write` |
| `POST /automations/[id]/activate` | fresh CS **CONTROL**, **OWNER DECISION O-1** | yes | `cs-comms-control` 10/min |
| Any future broadcast (in-app to many) | fresh CS **CONTROL**, **OWNER DECISION O-2** | yes | — |

- The rule is that decreasing sending is WRITE and increasing reach is CONTROL.
- The SYSTEM_ADMIN break-glass bypass applies as everywhere else (`authorize.ts:146`).
- Admission is **not** consulted for authorization (`lib/platform/admission/facts.ts:90-96`). It is consulted at **send** time (§5.6).

### 4.2 `GET /catalog`

Query parameters:
- `status?`, `category?`, `audience?`, `channel?`, `consentClass?`;
- `q?` (matches key or displayName);
- `cursor?`, `limit?`.

```ts
type CatalogResponse = ListEnvelope<CatalogItem> & { totals: Record<DefinitionStatus, number> };
```

- The catalog is a code registry, so `floor` and `capped` are always false.
- **Default sort (C7c):** `status` in the order `ENABLED, BUILD, BUILD_OFF, PROPOSED, VOCABULARY, NONE_BY_DESIGN, RETIRED`, then `displayName` ascending (ASCII case-folded), then `key` as the tiebreak.
- **Registry size (C7c):** 58 items at v1.
  - 35 `NOTIFICATION_REGISTRY` entries (`lib/notifications/registry.ts:116-651`; 21 WIRED, 14 VOCABULARY).
  - 13 direct-send and banner keys (§8.1).
  - 5 BUILD keys (§8.2).
  - 4 new PROPOSED keys (§8.5).
  - 1 NONE_BY_DESIGN key (§8.4).
- `limit=100` therefore returns the whole catalog in one page, with `nextCursor: null`. A test pins `catalog size ≤ 100` so this stays true. Past 100, the cursor applies as for any list.

### 4.3 `GET /catalog/[key]`

Returns `CatalogDetail` (§2.1), or 404. The `recent` series reads the ledger and comes back as `null` days until Phase A has written rows.

### 4.4 `GET /catalog/[key]/preview?channel=email-html|email-text|in-app|operator|banner`

```ts
interface PreviewResponse {
  key: string; definitionVersion: number; templateVersion: number | null;
  channel: PreviewChannel;
  synthetic: true;                     // always; the server refuses to render real data here
  subject: string | null;              // email only; always prefixed "[PREVIEW]"
  html: string | null;                 // email-html (sandbox it client-side: no scripts in templates)
  text: string | null;                 // email-text | in-app body | banner description | operator text
  inApp: { title: string; body: string | null; href: string | null; icon: string } | null;
  variants: string[];                  // named synthetic cases, e.g. "reauth-required", "legacy-no-state"
  checkedAt: string;
}
```

- Optional `variant=<name>`.
- Fixtures are synthetic only: the reserved token `preview-not-redeemable`, recipients under `@example.invalid` (RFC 2606) and fixed dates (`lib/email/preview.ts:25-33`). Fixtures are code. **No query parameter supplies data.**
- `operator` renders `platform-alert` or the internal security variant with synthetic alerts.
- `banner` renders the client notice copy (`components/notices/notice-model.ts:60`).
- 409 `INVALID_STATE` if the definition has no such channel.

### 4.5 `GET /triggers`

```ts
interface TriggerItem {
  key: TriggerKey; displayName: string; description: string;
  source: "DOMAIN_EVENT" | "HEALTH_TRANSITION" | "JOB_OUTCOME" | "LIFECYCLE" | "SCHEDULE";
  payload: Array<{ name: string; type: string; pii: boolean }>;
  /** Recipient resolvers valid for this trigger. */
  resolvers: RecipientResolver[];
  status: "AVAILABLE" | "PROPOSED";    // PROPOSED = event not emitted yet (AUDIT §1.9)
}
type TriggersResponse = ListEnvelope<TriggerItem>;
```

### 4.6 `GET /automations`, `GET /automations/[id]`, `GET /automations/[id]/runs`

```ts
interface AutomationSummary {
  id: string; name: string; state: AutomationState;
  triggerKey: TriggerKey; definitionKey: string; definitionVersion: number;
  channels: CommsChannel[];
  version: number;                     // optimistic token
  activatedVersion: number | null;
  autoPausedReason: AutoPauseReason | null;
  lastRun: { id: string; at: string; status: AutomationRunStatus } | null;
  updatedAt: string;
}
type AutomationState = "DRAFT" | "ACTIVE" | "PAUSED" | "DISABLED";
type AutoPauseReason = "DEFINITION_CHANGED" | "STORM_BREAKER" | "ERROR_RATE" | "TRIGGER_RETIRED";

interface AutomationDetail extends AutomationSummary {
  description: string;
  conditions: Condition[];             // §5.2
  recipient: RecipientResolver;
  delay: { minutes: number } | null;
  dedupeKeyTemplate: string;
  frequencyCap: { max: number; perHours: number };
  retryPolicy: RetryPolicy;
  maxRecipientsPerRun: number;
  history: Array<{ at: string; action: string; actorKind: "PLATFORM_OPERATOR" | "SYSTEM_ADMIN" | "SYSTEM"; auditLogId: string }>; // no operator identity beyond kind; full identity via audit
}

interface AutomationRunItem {
  id: string; mode: "LIVE" | "DRY_RUN"; status: AutomationRunStatus;
  automationVersion: number; triggerRef: string;  // opaque (AuditLog id / event id)
  startedAt: string; completedAt: string | null;
  counts: { matched: number; eligible: number; scheduled: number; accepted: number; failed: number;
            captured: number; cancelled: number;                       // C8
            suppressed: Record<SuppressionReason, number> };           // every reason key present, 0 allowed
  /** Set when status = "HALTED" (C5: PROVIDER_FREEZE; §5.7: STORM_BREAKER). */
  haltReason: SuppressionReason | null;
}
type AutomationRunStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "HALTED";
type RunsResponse = ListEnvelope<AutomationRunItem>;
```

The list endpoints take `state?` and `cursor/limit`, and return `ListEnvelope<AutomationSummary>`.

### 4.7 `POST /automations/[id]/dry-run`

- The body is `MutationRequest<{ sample?: { triggerRef?: string }; window?: "7d" | "30d" }>`.
- It replays the trigger over the window's recorded events, or a single `triggerRef`. It evaluates conditions, recipients and every send-time guard, and **sends nothing**.
- It writes one `AutomationRun{mode:"DRY_RUN"}` row plus the audit row.

```ts
interface DryRunResult {
  runId: string;
  /** C8 — echoes the window actually replayed (the request's, or the default "7d"); null when a single triggerRef was replayed. */
  window: { window: "7d" | "30d"; from: string; to: string } | null;
  counts: AutomationRunItem["counts"];
  /** Up to 5 synthetic-rendered examples; never a real recipient or real payload values. */
  examples: Array<{ variant: string; subject: string | null; inAppTitle: string | null }>;
  wouldExceedMaxRecipients: boolean;
  floor: boolean; checkedAt: string;
}
```

### 4.8 `POST /test-send`

```ts
type TestSendRequest = MutationRequest<{
  key: string; channel: "EMAIL" | "IN_APP"; variant?: string;
  /** "SELF" = the operator's own verified account email/in-app inbox; "ALLOWLIST" = one entry id (O-3). */
  recipient: { kind: "SELF" } | { kind: "ALLOWLIST"; entryId: string };
}>;
interface TestSendResult { deliveryId: string; status: DeliveryStatus; provider: string | null }
```

- The client **never** supplies an address. The server resolves `SELF` from the session user's row.
- The send uses synthetic fixtures and a `[TEST]` subject prefix. It is written to the ledger with `mode = "TEST"` and is excluded from analytics by default.
- 422 `GUARD_REFUSED` when the allowlist entry is unknown, or when the environment guard (O-4) refuses.
- `protected` definitions may be test-sent: test sends are synthetic and go only to the operator.

### 4.9 `POST /automations/[id]/{activate|pause|disable}`

- The body is `MutationRequest<{}>` with `expectedVersion`.
- Allowed transitions:
  - `DRAFT → ACTIVE` (activate, CONTROL);
  - `ACTIVE → PAUSED` (WRITE);
  - `PAUSED → ACTIVE` (CONTROL);
  - `{DRAFT, ACTIVE, PAUSED} → DISABLED` (WRITE, terminal; clone to revive).
- `pause` cancels every `SCHEDULED` delivery of that automation (each becomes `CANCELLED` / `AUTOMATION_PAUSED`) in the same transaction.
- `activate` re-validates against the current `definitionVersion` and the trigger catalog. It refuses when the target definition has `consentClass = MARKETING` and the opt-in model (O-12) is not shipped.
- Returns `MutationResult<AutomationDetail>`.

### 4.10 `PATCH /automations/[id]` (draft edit)

- Allowed only in `DRAFT` or `PAUSED`. Any other state returns 409 `INVALID_STATE`.
- The body is `MutationRequest<Partial<Pick<AutomationDetail, "name" | "description" | "conditions" | "recipient" | "delay" | "dedupeKeyTemplate" | "frequencyCap" | "retryPolicy" | "maxRecipientsPerRun" | "channels">>>`.
- `channels` must be a subset of the target definition's channels.
- Every field is validated against the closed sets in §5. **There is no free-text copy, no template body and no code** (O-11).
- Bumps `version`.
- `POST /automations` creates a DRAFT with the same body plus `triggerKey` and `definitionKey` (WRITE).

### 4.11 `GET /delivery?window=&channel=&status=&template=`

```ts
/** C3 — EVERY key present with a number (0 allowed), over the OBSERVED range only. */
type StatusCounts = Record<DeliveryStatus, number>;
type ReasonCounts = Record<SuppressionReason, number>;

interface DeliveryAnalytics {
  window: "7d" | "30d" | "90d";
  from: string; to: string;            // C2 — YYYY-MM-DD UTC bounds of the window
  filters: { channel: CommsChannel | null; status: DeliveryStatus | null; template: string | null /* catalog key */ };
  /** C3 — null as a WHOLE when coverage.ledgerSince is null (nothing observed). */
  totals: StatusCounts | null;
  suppressedByReason: ReasonCounts | null;
  /** C3 — each row carries the same full status vector as `totals` (incl. CAPTURED, CANCELLED). Null when ledgerSince is null. */
  byKey: Array<{ key: string; counts: StatusCounts }> | null;
  /** C4 — every key always present; each a dense DaySeries (C2). */
  series: Record<"accepted" | "failed" | "dead" | "suppressed" | "captured" | "cancelled", DaySeries>;
  /** The honest ceiling: until Phase C, "delivered" is not measured. */
  measured: { delivered: false; opens: false; clicks: false };
  /** Coverage: which sends are on the ledger. Days before ledgerSince are null in every series. */
  coverage: { ledgerSince: string | null; directSendsCovered: boolean; environment: "production" | "preview" | "development" };
  /** Resend health is owned by Platform Ops → Providers. Link, do not duplicate. */
  providerHealth: { href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers"; source: "GET /api/platform/platform-ops/email-health" };
  floor: boolean; capped: boolean; checkedAt: string;
}
```

- Aggregates only (§3.2). This endpoint does **not** re-implement `getEmailDeliveryHealth` (`lib/platform/email-health.ts:58-88`). It reads the new ledger.
- **Observed range.** `totals`, `suppressedByReason` and `byKey` count only `[max(from, ledgerSince), to]`. When the window starts before `ledgerSince`, the response still carries numbers for the observed part, and the series show which days are null.
- **Delivery counts are not small-cell withheld.** They count messages, not people, and carry no recipient. The small-cell rule (C1 `withheld`) applies to people counts (§4.12, §4.14). `DaySeries.withheld` is therefore never set here.
- **Preview** (and any non-Production environment, O-4) records every non-allowlisted send as `CAPTURED`. On Preview, expect `series.accepted` to be all `0` on observed days and the volume to show under `series.captured` (C4).
- `providerHealth.href` uses the workspace id `platform-providers` (`lib/platform/workspaces.ts:69`).
- **Ledger failure:** a failed ledger read returns **503 `{ error, code: "UNAVAILABLE" }`** (§3.4). It never returns zeros, empty `byKey` or all-null series.

### 4.12 `GET /preferences` (aggregate, no PII)

```ts
interface PreferenceAggregate {
  /** C7b — ACTIVE accounts only (definition below). Never withheld. */
  population: number;
  rows: Array<{
    category: NotificationCategory; locked: boolean;
    /** C1 — counts are number | null; small cells set withheld. */
    channels: Record<"IN_APP" | "EMAIL", { default: boolean; optedOut: number | null; optedIn: number | null; withheld: boolean }>;
  }>;
  /** Suppression a user cannot see: e.g. SYNC_FAILED email lost because FINANCIAL IN_APP is off (create.ts:323-326). */
  coupledSuppression: Array<{ key: string; usersAffected: Aggregate; explanation: string }>;
  floor: boolean; checkedAt: string;
}
```

- This is a read-only aggregation over `NotificationPreference` (`prisma/schema.prisma:3839-3849`), using the registry defaults from `lib/notifications/preferences.ts:64-70`.
- **Population (C7b):** a `User` row counts when all of the following hold:
  - `role = USER` (`schema.prisma:360`), which excludes SYSTEM_ADMIN;
  - `deactivatedAt IS NULL` (`:396`);
  - `deletionScheduledAt IS NULL` (`:407`).
  These are the only status fields: there is no `status` column on `User`. Pending deletion also sets `deactivatedAt` (`:400-401`), so the second clause already excludes it, and the third is belt-and-braces. Override rows of excluded users are not counted.
- **Small cells (C1):** an observed count from 1 to 4 is returned as `null` with `withheld: true`. `null` with `withheld: false` means not observed: no preference read was possible, or it lies outside coverage. `0` is returned as `0`. The threshold of 5 is confirmed under O-9.
- **Ledger failure:** a failed `NotificationPreference` or `User` read returns **503 `UNAVAILABLE`**. It never returns an empty `rows` array.
- Operators **cannot** change a user's preferences. There is no mutation.

### 4.13 Per-customer delivery history (outside the base path, deliberately)

`GET /api/platform/customer-success/customers/[userId]/deliveries?window=&cursor=&limit=`

- Gate: CS READ.
- `CUSTOMER_DELIVERY_HISTORY_VIEWED` is recorded **before** the response leaves the server, and the read **fails closed** if the audit write fails (pattern `customers/[userId]/route.ts:29-40`).
- Response (C8):

  ```ts
  type CustomerDeliveriesResponse = ListEnvelope<{
    deliveryId: string; key: string; channel: CommsChannel;
    status: DeliveryStatus;
    reason: SuppressionReason | null;    // set when status ∈ SUPPRESSED | CANCELLED; null otherwise
    attempts: number;
    createdAt: string; acceptedAt: string | null; lastAttemptAt: string | null;
  }>;
  ```

- It still carries no address, title or body. Identity is already established by the customer path.
- **Ledger failure:** returns **503 `UNAVAILABLE`**, never an empty list. The view-audit row is still written, because the operator did attempt the view.

### 4.14 In-app management

**What operators may do in v1: read aggregates only.**

`GET /in-app?window=` returns:

```ts
{
  window: "7d" | "30d" | "90d"; from: string; to: string;
  byKey: Array<{
    key: string;
    created: number;                     // Notification rows created in the window
    suppressedDedupe: Count;             // null until Phase A records dedupe suppressions
    skippedPreference: Count;            // null until Phase A records preference skips
    readRate: number | null;             // C7a — definition below
  }>;
  series: DaySeries;                     // created per UTC day, dense (C2)
  floor: boolean;
  checkedAt: string;
}
```

- The source is `Notification` (`schema.prisma:3765-3796`, index `[category, createdAt]`). Under F8, in-app reach is measured on `Notification`, never on a delivery row (`lib/notifications/types.ts:38-44`).
- **`readRate` (C7a):**
  - numerator: Notification rows of that key **created in the window** with `readAt IS NOT NULL` (read at any time up to `checkedAt`);
  - denominator: Notification rows of that key **created in the window**;
  - `null` when the denominator is below 5.
  - Rows already deleted by cleanup (`lib/notifications/cleanup.ts:6-14`) are absent from both sides. With the 90-day window and the default 30 + 90-day retention this affects only rows read long ago, and it sets `floor: true` when the window exceeds the type's `autoArchiveDays + deleteDays`.
- **Ledger failure:** a failed `Notification` read returns **503 `UNAVAILABLE`**, never an empty `byKey`.
- **There is no operator create, edit, read or archive of any user's Notification row.** The F14 boundary (`types.ts:46-52`) stands. `createNotification` (`lib/notifications/create.ts:273`) and `read.ts` stay the only writers. The Comms Center reuses them through the orchestrator and never writes `Notification` directly.
- Broadcast (`MAINTENANCE_SCHEDULED`, `FEATURE_RELEASED`, `POLICY_UPDATED`, `registry.ts:563-603`) is **not** in v1. If approved, it is CONTROL (O-2).

### 4.15 Banners (read plus a link to the Platform Ops writer)

`GET /banners`:

```ts
interface BannersResponse {
  maintenance: {
    active: boolean | null;            // readMaintenanceNotice() — lib/platform/notices/maintenance-notice.ts:29-41
    writer: { area: "PLATFORM_OPS"; level: "CONTROL"; href: string; api: "PATCH /api/platform/platform-ops/operational-controls" };
  };
  perUserNotices: Array<{ key: "TWO_FACTOR_REMINDER" | "CONNECT_INVITATION"; description: string; source: string }>; // catalog facts, not per-user values
  checkedAt: string;
}
```

There is no second writer. Activation stays under `requireFreshPlatformAccess("PLATFORM_OPS","CONTROL")` (`operational-controls/route.ts:63`).

### 4.16 Operator alerts

The catalog lists `PLATFORM_ALERT` and the Security Ops variants with `ownerSurface` pointing to `ops_alerts` (`lib/platform/workspaces.ts:319`; `app/api/platform/platform-ops/alerts/route.ts`) and to Security Ops. They are `supportedActions: ["PREVIEW","LINK_OUT"]`. The Comms Center never evaluates rules and never mutes them.

---

## 5. Automation model

### 5.1 Controlled trigger catalog (typed events only, no arbitrary code)

```ts
type TriggerKey =
  // AVAILABLE (an emitter exists today)
  | "space.member.invited" | "space.member.joined" | "space.member.removed" | "space.member.role_changed" // lib/events/types.ts:55-59
  | "plaid.item.sync_failed" | "plaid.item.history_ready"                                               // lib/plaid/sync-notifications.ts:72,99
  | "import.batch.completed"                                                                              // app/api/accounts/[id]/import/route.ts:463
  // BUILD (owner-approved; emitter to be added — Phase B)
  | "plaid.item.webhook_needs_reauth" | "plaid.item.webhook_revoked"   // at lib/plaid/webhook-receiver.ts:242-252
  | "wallet.sync.failed"                                                 // at the SyncIssue WALLET_SYNC_FAILED write, lib/crypto/*-sync.ts
  | "account.registered"                                                 // after commit, app/api/auth/register/route.ts
  | "platform.grant.created" | "platform.grant.reinstated"               // app/api/admin/platform-grants/route.ts:129-135
  // PROPOSED (no emitter; listed so the vocabulary is stable)
  | "beta.invitation.expiring" | "beta.program.status_changed"
  | "wallet.import.completed" | "platform.maintenance.scheduled" | "provider.incident.opened"
  | "schedule.daily";                                                    // digest only; BUILD_OFF
```

- **Every trigger is code.** It has a typed payload, a list of valid resolvers and an emitter site.
- The trigger catalog **excludes every comms-originated event**: delivery accepted, failed, read or bounced. An automation can therefore never trigger on its own output (§5.7).
- Emitters write to the existing AuditLog through `emitDomainEvent` (`lib/events/emit.ts:165-196`), or call the orchestrator after commit. They never call it inside a tenant transaction (`emit.ts:40-46`).

### 5.2 Conditions: a closed predicate set

```ts
type Condition =
  | { op: "recipient.has_verified_email" }
  | { op: "recipient.account_age_days"; cmp: "gte" | "lte"; value: number }
  | { op: "recipient.cohort_in"; cohortIds: string[] }
  | { op: "recipient.lifecycle_stage_in"; stages: import("@/lib/platform/customer/customer-core").LifecycleStage[] } // customer-core.ts:113
  | { op: "recipient.has_platform_grant"; area: string }
  | { op: "event.field_equals"; field: string; value: string | number | boolean }  // field ∈ trigger payload, non-PII only
  | { op: "event.count_in_window"; cmp: "gte"; value: number; windowHours: number }
  | { op: "connection.status_in"; statuses: Array<"ACTIVE" | "NEEDS_REAUTH" | "ERROR" | "REVOKED"> }
  | { op: "connection.removed_by_user"; value: false }; // PR #164 removedByUser rule

type EligibilityPredicate = Condition["op"];
```

- Conditions are AND-ed, with at most 8. There is no OR, no expressions and no regex.
- `field` is validated against the trigger's payload schema with `pii=false`.

### 5.3 Recipient resolution, channel selection, template assignment

```ts
type RecipientResolver =
  | { kind: "EVENT_SUBJECT_USER" }                       // the user the event is about
  | { kind: "EVENT_ACTOR_USER" }
  | { kind: "SPACE_ROLE"; roles: Array<"OWNER" | "ADMIN" | "MEMBER"> }
  | { kind: "PLATFORM_AREA_STAFF"; area: "SECURITY_OPS" | "PLATFORM_OPS" | "CUSTOMER_SUCCESS" | "GROWTH_REVENUE"; includeSystemAdmin: boolean } // replaces anomaly-alerts.ts:167-182
  | { kind: "OPERATOR_INBOX"; env: "PLATFORM_ALERTS_EMAIL" | "SECURITY_ALERTS_EMAIL" | "BETA_REQUESTS_EMAIL" }; // env NAME, never a value
```

- **Channels** are a subset of the definition's channels. Each recipient then passes through preference resolution (`resolveChannelEnabled`, `lib/notifications/preferences.ts:85-100`) unless the consent class forbids suppression.
- **Template:** an automation targets a `definitionKey`, and the definition fixes the template per channel. Operators choose a definition and, where one exists, a named variant. They never author copy (O-11).
- **IN_APP delivery** always goes through `createNotification` (no second writer). **EMAIL** always goes through `sendEmail`.

### 5.4 Delay with re-evaluation

- `delay.minutes` can be 0 to 10,080 (7 days).
- A delayed send is persisted as a `CommsDelivery{status:"SCHEDULED", notBefore}`.
- **Immediately before the send**, the engine re-evaluates:
  - every condition;
  - eligibility;
  - preferences;
  - the dedupe and frequency caps;
  - every send-time guard (§5.6);
  - the automation's state (it must still be ACTIVE at the activated version).
- A failure becomes `CANCELLED` with the matching reason.

### 5.5 Dedupe, idempotency, retry, frequency limits

- **Dedupe key:** `dedupeKeyTemplate` over non-PII payload fields plus `{recipientId}`. A delivery with the same `(definitionKey, dedupeKey)` in a non-terminal or ACCEPTED state within the window becomes `SUPPRESSED` / `DEDUPE_OPEN`.
- **Idempotency key:** `sha256(automationId ‖ activatedVersion ‖ triggerRef ‖ recipientId ‖ channel)`, stored in a unique column. The insert is the claim. A replayed trigger, a duplicate cron wake or a double-click creates nothing (the claim-first idiom of `jobs/retry-notifications.ts:28-39`). The same key is sent as Resend's idempotency header in Phase B. **INFERRED** availability in the SDK version in use (UNVERIFIED).
- **Retry policy:** `type RetryPolicy = "NONE" | "STANDARD"`. STANDARD means 3 total attempts at +15 min and +4 h, then `DEAD`. Operators cannot set a custom backoff. The existing daily `notification-retry` (`jobs/retry-notifications.ts`) keeps serving legacy rows until Phase C.
- **Frequency cap:** per recipient, per definition key. The default comes from the definition. An automation may only **tighten** it.

### 5.6 Send-time guards: never bypassable

The orchestrator evaluates these at send time, in this order. They are not configurable by an automation, and each failure yields a `SuppressionReason`.

1. **Environment guard** (O-4): outside Production, only allowlisted recipients, otherwise `CAPTURED` / `ENVIRONMENT_GUARD`. Today's gap is AUDIT R-1.
2. **Admission:** maintenance mode and ingestion pause, through `admitOperationalWork` (`lib/platform/admission/facts.ts:96-102`). SECURITY_CRITICAL and CEREMONY are exempt, so a password reset still works during maintenance.
3. **Account restrictions:** a deactivated account or a pending deletion (`prisma/schema.prisma:396-401`) suppresses everything except SECURITY_CRITICAL and CEREMONY.
4. **Beta lifecycle (C5):** the recipient's lifecycle state, read through Session 2's beta lifecycle authority and the billable gate. It is applied by the matrix in §5.6.1. `registration_mode` and `product_status` are **not** consulted; they gate signup, not messaging.
5. **Entitlements:** the effective entitlements (`resolveEffectiveEntitlements`, `lib/entitlements/resolve.ts`), read through the same gate. `NOT_ENTITLED` for the capability a message is about becomes `ENTITLEMENT`.
6. **Provider cost freeze (C5):**
   - **Per recipient:** covered by step 4 (`COST_FREEZE`).
   - **Global:** when the authoritative Beta group has its cost freeze on, every **LIVE automation run** stops. It is marked `HALTED` with `haltReason: "PROVIDER_FREEZE"`, its `SCHEDULED` deliveries become `CANCELLED` / `PROVIDER_FREEZE`, and nothing further is sent.
   - Registry producers (`createNotification`) and direct security and ceremony sends are **untouched**.
   - The run checks at start and before each send batch.
   - The ingestion pause (step 2) and the AI kill switch still apply where a message implies provider or AI work.
7. **Preferences:** for AWARENESS, SERVICE (O-7) and MARKETING only.
8. Dedupe, then the frequency cap.

- **Security-critical messages are not suppressible by marketing or awareness preferences.** That holds by construction: `consentClass = SECURITY_CRITICAL` skips step 7, and `protected = true` refuses every automation action.
- **Consequence:** `SECURITY_ANOMALY_DETECTED` must move to an `OPERATOR` consent class, with locked staff delivery (O-8). This fixes AUDIT R-2.

#### 5.6.1 Beta lifecycle matrix (C5)

**Authority.** The source of truth is Session 2's lifecycle authority plus the billable gate from PR #162: `lib/entitlements/billable-gate.ts`, with `assertBillableAllowed` and `billableAllowedForUsers`.

**Verified, from local ref `origin/feat/beta-lifecycle-evaluator` at `1487076`, which is not yet on `develop` `bbfb2e0`:**
- `getBetaLifecycleState(client?)` returns the state of the **Beta group** (`BETA_FULL_ACCESS_V1`): `ACTIVE | PAUSED | ENDED | UNKNOWN`. It takes **no `userId`** (`lib/entitlements/beta-lifecycle.ts:23,33-40`).
- The **per-user** answer is the billable gate's decision. Its denial reasons are `COST_FREEZE | BETA_PAUSED | BETA_ENDED | POLICY_UNAVAILABLE | NOT_ENTITLED | NO_OWNER` (`lib/entitlements/billable-gate-core.ts:50`). It applies the lifecycle and freeze precedence of `lib/entitlements/lifecycle.ts`: cost freeze → ended → paused.
- The batch form is `billableAllowedForUsers(userIds, operation)`, with one catalogue read and one assignment query (`billable-gate.ts:129`). The single form is `assertBillableAllowed` (`:96`).

**The contract therefore needs a per-recipient wrapper**, `getBetaLifecycleState(userId)` as Session 2 named it. Its exact name and file belong to Session 2. It must return:

```ts
type RecipientBetaState = "ACTIVE" | "PAUSED" | "ENDED" | "COST_FREEZE" | "UNKNOWN";
// From the billable gate's per-user decision:
//   allowed            → ACTIVE
//   COST_FREEZE        → COST_FREEZE
//   BETA_PAUSED        → PAUSED
//   BETA_ENDED         → ENDED
//   POLICY_UNAVAILABLE → UNKNOWN     (unreadable / stale catalogue — fails closed for automations)
//   NO_OWNER           → UNKNOWN
//   NOT_ENTITLED       → ACTIVE here; decided at step 5 as ENTITLEMENT
```

- The gate's operation list (`BILLABLE_OPERATIONS`, `billable-gate-core.ts:42-47`) has no messaging operation.
- **OWNER DECISION / Session 2 item (O-16):** either add a METERED `"comms_automation"` operation, or have the wrapper read the resolver restriction directly. Either way the mapping above is the contract.

**Matrix.** S = send. B = `SUPPRESSED` / `BETA_LIFECYCLE`.

| Message origin and consent class | ACTIVE | PAUSED | ENDED | COST_FREEZE | UNKNOWN |
|---|---|---|---|---|---|
| SECURITY_CRITICAL (any origin) | S | S | S | S | **S** (never fails closed) |
| CEREMONY (any origin) | S | S | S | S | **S** (never fails closed) |
| SERVICE about the recipient's own data, registry or direct producer (e.g. `SYNC_FAILED`) | S | S | S | S | S |
| SERVICE about the recipient's own data, **via an automation** (e.g. `PLAID_ITEM_REAUTH_REQUIRED`) | S | S | S | S | **B** (automations fail closed) |
| AWARENESS, registry or direct producer | S | B | B | B | S (legacy producers keep today's behaviour; no new failure mode) |
| AWARENESS **via an automation** | S | B | B | B | **B** |
| Any other automation send (MARKETING, if ever) | S | B | B | B | **B** |
| OPERATOR (staff and inboxes) | not evaluated: staff are not beta customers | | | | |

- A global cost freeze also halts LIVE automation runs (step 6). This happens **before** any per-recipient evaluation, so a frozen platform produces `HALTED` runs, not thousands of `B` rows.
- Every `B` row is visible in `suppressedByReason.BETA_LIFECYCLE` (§4.11) and in the run's `counts.suppressed` (§4.6).
- Dry runs (§4.7) evaluate the same matrix, so an operator sees the lifecycle effect before activating.

### 5.7 Loop and storm prevention

- **No self-triggering.** Triggers exclude comms events (§5.1). The orchestrator never emits a domain event.
- **Per-run cap:** `maxRecipientsPerRun`, default 50, hard ceiling 500. Above the cap the run halts (`HALTED`), sends nothing further, and auto-pauses the automation (`STORM_BREAKER`).
- **Global breaker:** more than N accepted sends per 10 minutes across all automations (N is O-10) auto-pauses **every** automation, leaves registry and direct sends untouched, and raises a Platform Ops alert. This adds an `ALERT_RULES` kind (`lib/alerts/rules.ts:100-110`) with no second alert store.
- **Error-rate breaker:** at least 20 attempts with more than 50% failed in an hour auto-pauses the automation (`ERROR_RATE`).
- **Fan-out** to PLATFORM_AREA_STAFF is capped at 50 recipients.

### 5.8 Cancellation, suppression and audit

- Every state transition is an operator action, audited in the same transaction (§3.5).
- Every engine decision (scheduled, cancelled, suppressed, halted) is a ledger row or AutomationRun count. **It is not an AuditLog row:** the audit stays for human actions.
- `auditLogId` on the delivery ledger points at the triggering fact.

---

## 6. Persistence proposal (PROPOSED, no migration yet)

### 6.1 `CommsDelivery`: one ledger for every send

`CommsDelivery` is a new table, not an extension of `NotificationDelivery`.
- `NotificationDelivery` requires a Notification FK and dies with it (`schema.prisma:3813-3814`; AUDIT §4), so it cannot hold direct sends.
- In Phase A, `sendEmail` gains an optional context argument and writes `CommsDelivery` itself. That covers all 19 call sites without per-site bookkeeping.
- `NotificationDelivery` stays the retry outbox for registry email until Phase C migrates the retry job. After that it is frozen and read-only, with legacy mapping per §3.3.

```prisma
model CommsDelivery {
  id                String    @id @default(cuid())
  definitionKey     String                 // catalog key
  definitionVersion Int
  templateVersion   Int?
  channel           String                 // CommsChannel
  mode              String    @default("LIVE")   // LIVE | TEST
  audience          String                 // Audience
  recipientUserId   String?                // soft ref, no FK (survives purge as orphan id; nulled by purge — §6.4)
  recipientHash     String?                // auditEmailHash(address) (lib/audit.ts:137); never the address
  notificationId    String?                // soft ref to Notification (IN_APP twin), no FK
  automationId      String?
  automationRunId   String?
  auditLogId        String?                // the triggering fact
  dedupeKey         String?                // non-PII by construction (§2 invariant)
  idempotencyKey    String?   @unique
  status            String                 // DeliveryStatus
  reason            String?                // SuppressionReason
  provider          String?                // "resend" | "capture"
  providerMessageId String?
  attempts          Int       @default(0)
  notBefore         DateTime?
  lastAttemptAt     DateTime?
  nextAttemptAt     DateTime?
  acceptedAt        DateTime?
  deliveredAt       DateTime?              // webhook-verified only (Phase C)
  terminalAt        DateTime?
  errorCode         String?                // closed set: TIMEOUT | PROVIDER_4XX | PROVIDER_5XX | RENDER | NO_TRANSPORT
  errorDetail       String?                // redactProviderError() output, ≤300 (lib/email/providers/resend.ts:89-95)
  environment       String                 // production | preview | development
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@index([createdAt])
  @@index([definitionKey, createdAt])
  @@index([channel, status, createdAt])
  @@index([recipientUserId, createdAt])
  @@index([status, nextAttemptAt])        // retry/scheduled scanner
  @@index([definitionKey, dedupeKey, createdAt])
  @@index([automationRunId])
  @@index([providerMessageId])
}
```

The ledger never stores a body, subject, link, token, address or payload values.

### 6.2 `CommsDeliveryDaily`: counts-only rollup

```prisma
model CommsDeliveryDaily {
  day           DateTime @db.Date
  definitionKey String
  channel       String
  status        String
  reason        String   @default("")
  count         Int
  @@id([day, definitionKey, channel, status, reason])
}
```

A nightly dispatcher job writes it, so long trends survive ledger retention.

### 6.3 Automations

```prisma
model AutomationDefinition {
  id                  String   @id @default(cuid())
  name                String
  description         String   @default("")
  triggerKey          String
  definitionKey       String
  definitionVersion   Int                  // the version it was validated against
  channels            String[]
  conditions          Json                 // Condition[] — validated against the closed set on every write
  recipient           Json                 // RecipientResolver
  delayMinutes        Int?
  dedupeKeyTemplate   String
  frequencyCapMax     Int
  frequencyCapHours   Int
  retryPolicy         String   @default("STANDARD")
  maxRecipientsPerRun Int      @default(50)
  state               String   @default("DRAFT")   // DRAFT | ACTIVE | PAUSED | DISABLED
  version             Int      @default(1)          // optimistic token, bumped on every write
  activatedVersion    Int?
  autoPausedReason    String?
  createdById         String
  updatedById         String
  activatedAt         DateTime?
  pausedAt            DateTime?
  disabledAt          DateTime?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([state, triggerKey])
  @@index([definitionKey])
}

model AutomationRun {
  id                String   @id @default(cuid())
  automationId      String
  automationVersion Int
  mode              String                 // LIVE | DRY_RUN
  triggerKey        String
  triggerRef        String?                // opaque AuditLog/event id
  status            String                 // RUNNING | SUCCEEDED | PARTIAL | FAILED | HALTED
  counts            Json                   // AutomationRunItem["counts"] — counts only
  jobRunId          String?                // soft ref (lib/jobs/run.ts currentJobRun)
  error             String?                // redacted, ≤300
  startedAt         DateTime @default(now())
  completedAt       DateTime?

  @@index([automationId, startedAt])
  @@index([status, startedAt])
}
```

### 6.4 Webhook events (Phase C)

```prisma
model CommsProviderEvent {
  id                String   @id @default(cuid())
  provider          String                 // "resend"
  providerEventId   String   @unique       // svix-id — replay protection
  providerMessageId String
  type              String                 // delivered | bounced | complained | delivery_delayed
  occurredAt        DateTime
  receivedAt        DateTime @default(now())
  deliveryId        String?                // resolved CommsDelivery
  @@index([providerMessageId])
}
```

- The endpoint verifies the svix signature with a new secret (env **name** `RESEND_WEBHOOK_SECRET`, PROPOSED). Unverified bodies are rejected and never stored.
- The endpoint is listed in the write-origin machine-route census (`lib/security/write-origin.test.ts:172`).

### 6.5 Retention (PROPOSED, OWNER DECISION O-9)

| Table | Retention | Mechanism |
|---|---|---|
| `CommsDelivery` | 180 days from `createdAt` (TEST rows: 30 days) | add to `jobs/data-retention.ts` (it already covers `jobRun` at 90 days, `:60`) |
| `CommsDeliveryDaily` | 25 months | same |
| `AutomationRun` | 90 days (parity with JobRun) | same |
| `CommsProviderEvent` | 30 days (parity with `plaidWebhookEvent`, `:66`) | same |
| `AutomationDefinition` | kept; DISABLED rows kept for audit | — |

- Account purge (`lib/account-deletion/purge.ts`) nulls `recipientUserId` and `recipientHash` on the user's `CommsDelivery` rows in the purge transaction. The counts stay.

---

## 7. Phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **A**: registry + delivery metadata + read APIs | `lib/comms/catalog` (code) covering every existing message; `CommsDelivery` + rollup migration; `sendEmail` context argument + ledger write; `createNotification` records preference skips; the environment guard (O-4); `GET /catalog`, `/catalog/[key]`, `/catalog/[key]/preview`, `/triggers`, `/delivery`, `/preferences`, `/in-app`, `/banners`, `customers/[userId]/deliveries`; the grep test "every sendEmail names a key" | Every production send lands one ledger row; zero bodies or addresses in the ledger (test); Session 2 can render the whole catalog |
| **B**: automations, dry run, test send, subscriptions | `AutomationDefinition` / `AutomationRun`; the orchestrator (§5) on the dispatcher; BUILD emitters (Plaid webhook reauth/revoked, wallet failure, registration, platform grant); dry-run; test-send; breakers; Resend idempotency header; staff **subscriptions** = `PLATFORM_AREA_STAFF` resolver opt-outs for OPERATOR-class non-critical messages (confirmed by Session 2, C8: staff may opt out of OPERATOR-class **non-critical** messages delivered through the `PLATFORM_AREA_STAFF` resolver; `critical` severity and every SECURITY_CRITICAL message stay locked on) | The four BUILD messages live behind ACTIVE automations; dry-run counts equal live counts on replay |
| **C**: webhooks, reconciliation, remaining paths | Resend webhook + `CommsProviderEvent`; `DELIVERED`/`BOUNCED`/`COMPLAINED`; reconciliation of `ACCEPTED`-without-event older than 72 h (flag, never auto-resend); migrate `notification-retry` onto `CommsDelivery` and freeze `NotificationDelivery`; fold the Space-invite duplicate (O-6), the anomaly fan-out (D-4) and the `emailStatus` copies (AUDIT D-5) | One ledger and one retry path; Platform Ops email health reads `CommsDelivery` |

---

## 8. Enabled vs proposed

### 8.1 ENABLED (existing; catalogued as-is)

**Registry WIRED, 21 items** (`lib/notifications/registry.ts`):
- **Account security (`protected`, SECURITY_CRITICAL):** `PASSWORD_CHANGED`, `PASSWORD_RESET`, `EMAIL_CHANGE_REQUESTED`, `EMAIL_CHANGE_COMPLETED`, `TWO_FACTOR_ENABLED`, `TWO_FACTOR_DISABLED`, `SESSION_REVOKED`, `ACCOUNT_DEACTIVATED`, `ACCOUNT_REACTIVATED`, `ACCOUNT_DELETION_REQUESTED`, `ACCOUNT_DELETION_CANCELLED`, `DATA_EXPORTED`.
- **Spaces (AWARENESS):** `SPACE_INVITE_RECEIVED`, `SPACE_INVITE_ACCEPTED`, `MEMBER_REMOVED`, `MEMBER_ROLE_CHANGED`.
- **Financial:** `SYNC_FAILED` (SERVICE, O-7), `SYNC_COMPLETED`, `IMPORT_COMPLETED`, `IMPORT_COMPLETED_WITH_ERRORS`.
- **Operator:** `SECURITY_ANOMALY_DETECTED` (reclassify to OPERATOR, O-8).

**Direct sends** (AUDIT §1.5, §1.7; new catalog keys, PROPOSED names):
- **Ceremony (`protected`):** `PASSWORD_RESET_LINK_SENT`, `EMAIL_VERIFICATION_SENT`, `EMAIL_CHANGE_CONFIRMATION_SENT`.
- **Security-alert email legs:** these are attached as the EMAIL channel of the matching registry key above, plus `TWO_FACTOR_RESET_BY_ADMIN`, `ACCOUNT_DELETED` and `SIGN_IN_ANOMALY_OWNER`.
- **Space invite email:** the EMAIL leg of `SPACE_INVITE_RECEIVED`, currently duplicated (O-6).
- **Beta:** `BETA_INVITATION_ISSUED` (request and direct origins; owner surface Growth).
- **Operator:** `BETA_REQUEST_RECEIVED`, `PLATFORM_ALERT`, `SECURITY_ANOMALY_INBOX`.
- **Banners, read-only, owner surface Platform Ops:** `MAINTENANCE_NOTICE`, `TWO_FACTOR_REMINDER`, `CONNECT_INVITATION`.

### 8.2 BUILD (newly approved by the owner)

| Key (PROPOSED) | Trigger | Audience / channels | Consent class |
|---|---|---|---|
| `PLAID_ITEM_REAUTH_REQUIRED` | `plaid.item.webhook_needs_reauth` | account holder · IN_APP + EMAIL | SERVICE (O-7); shares the `SYNC_FAILED:item:{plaidItemId}:open` condition so the cron and the webhook never double-notify |
| `PLAID_ITEM_REVOKED` | `plaid.item.webhook_revoked` | account holder · IN_APP + EMAIL | SERVICE; honours the `removedByUser` suppression (PR #164) |
| `WALLET_SYNC_FAILED` | `wallet.sync.failed` | account holder · IN_APP (+ EMAIL per O-7) | SERVICE; suppress-while-open per financial account |
| `ACCOUNT_WELCOME` | `account.registered` | account holder · EMAIL | AWARENESS or CEREMONY (O-5) |
| `PLATFORM_ACCESS_GRANTED` | `platform.grant.created`, `.reinstated` | the grantee · IN_APP + EMAIL | SECURITY_CRITICAL (a privilege change); `protected` |

### 8.3 BUILD_OFF

- `DIGEST_SENT` (`registry.ts:636-650`) is built behind state `DISABLED`, pending an owner proposal on frequency, content and opt-in (O-14).

### 8.4 NONE_BY_DESIGN

- **Beta denial** (`BETA_REQUEST_DENIED`). It is a catalog item with no channels, `status: NONE_BY_DESIGN` (`growth-revenue/requests/[id]/deny/route.ts:4`). It cannot be targeted by an automation.

### 8.5 PROPOSED (not active, never send)

- `BETA_INVITATION_EXPIRING` (invitation nearing expiry).
- `BETA_PROGRAM_STATUS_CHANGED` (beta paused or ended; would be CONTROL, many recipients).
- `WALLET_IMPORT_COMPLETED` (crypto import completed).
- `MAINTENANCE_SCHEDULED` (exists as VOCABULARY; broadcast is CONTROL, O-2).
- `PROVIDER_INCIDENT_NOTICE` (provider incident; many recipients, CONTROL, O-2).

Remaining registry VOCABULARY entries stay `VOCABULARY`:
- `EMAIL_VERIFIED`, `TWO_FACTOR_RESET`, `RECOVERY_CODE_USED`, `RECOVERY_CODES_REGENERATED`;
- `SPACE_OWNERSHIP_TRANSFERRED`, `DUPLICATE_DETECTED`;
- `DAILY_BRIEF_READY`, `OPPORTUNITY_FOUND`, `UNUSUAL_SPENDING`, `DEBT_ALERT`;
- `FEATURE_RELEASED`, `POLICY_UPDATED`.

---

## 9. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| O-1 | Gate for **activating** (or re-activating) an automation | CONTROL (it increases reach). Pause and disable stay WRITE |
| O-2 | Whether any **broadcast** (in-app or email to many) exists in v1 | No broadcast in v1. If later approved, CONTROL plus the global breaker |
| O-3 | **Test-send recipients:** own address only, or also an allowlist; where the allowlist lives | Own verified address only in v1. If an allowlist is needed, use a deployment env name (as `EMAIL_PREVIEW_ALLOWED_TO`, `lib/email/preview.ts:89-97`), never committed and never in the DB |
| O-4 | **Preview real email** | Outside Production, send only to allowlisted recipients and capture everything else (`ENVIRONMENT_GUARD`) |
| O-5 | **Welcome email:** consent class, invited vs uninvited signups, and whether it replaces nothing (verification remains for uninvited) | AWARENESS, both paths, sent once (idempotency on `userId`) |
| O-6 | **Space invite double email:** which leg survives | Keep the registry EMAIL leg (preference-gated, awareness per F12) rendered with the `space-invite` template; remove the direct send at `invite/route.ts:165` |
| O-7 | **SERVICE class** (reauth, revoked, sync failed, wallet failed): may users turn the email off, and should IN_APP-off still drop the email (`create.ts:323-326`)? | EMAIL suppressible on its own channel only; decouple it from IN_APP |
| O-8 | Reclassify `SECURITY_ANOMALY_DETECTED` from the unlocked PLATFORM category to a locked OPERATOR class, and stop storing raw identifiers and IPs in `metadata` and `dedupeKey` (AUDIT R-3) | Yes to both. Hash the key (`sha256`) for dedupe; the raw value stays on the AuditLog row only |
| O-9 | **Retention:** `CommsDelivery` 180 d / rollup 25 mo / runs 90 d; whether `recipientHash` is stored at all; the small-cell threshold (5) for aggregates | As proposed |
| O-10 | **Global storm breaker** threshold N per 10 min, and the Resend plan quota it should sit under | Needs the plan quota (UNVERIFIED). Start at 200 per 10 min for automations only |
| O-11 | **Operator-authored copy:** templates and variants code-only in v1 (no free-text bodies in the DB) | Code-only |
| O-12 | **MARKETING class:** none in v1; any future one needs opt-in, an unsubscribe token and `List-Unsubscribe` | Confirm none in v1 |
| O-13 | **Opens and clicks:** never measured (no pixels, no link rewriting) | Never |
| O-14 | **Digest proposal** (frequency, content, opt-in default) before `DIGEST_SENT` leaves BUILD_OFF | Owner to commission |
| O-15 | Approve the **Resend webhook endpoint** (Phase C): a public machine route with svix verification and the new secret env name | Approve for Phase C |
| O-16 | **Messaging operation in the billable gate** (Session 2): add a METERED `comms_automation` operation, or have the per-recipient lifecycle wrapper read the resolver restriction directly (§5.6.1) | Session 2's choice; the §5.6.1 mapping is fixed either way |
