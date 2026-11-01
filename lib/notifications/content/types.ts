/**
 * lib/notifications/content/types.ts  (Comms Center B1 — client-safe vocabulary)
 *
 * The editable-content shapes of docs/plans/COMMS-CENTER-API-CONTRACT-v1.1-DELTA-
 * 2026-10-31.md (§1, §1.1, §2.2–§2.6, §3.2–§3.8, §4.3), transcribed. Pure types
 * plus closed value lists. No I/O, no server import: the UI may import this file.
 */

import type { OperatorReasonCode } from "@/lib/audit";
import type { PreviewResponse, ListEnvelope } from "@/lib/notifications/catalog/types";

/** §1 — channels whose content an operator may edit. BANNER and OPERATOR_EMAIL never are. */
export type EditableChannel = "EMAIL" | "IN_APP";
export const EDITABLE_CHANNELS = ["EMAIL", "IN_APP"] as const satisfies readonly EditableChannel[];

/** §1 — one content stream per (definition, channel, variant). */
export interface ContentStreamRef { definitionKey: string; channel: EditableChannel; variant: string }

export type VersionState = "DRAFT" | "PUBLISHED" | "SUPERSEDED";

/**
 * v1.1.1 — the sentinel version id for "the code default" (never a row): the
 * `[id]` segment of `POST …/versions/code-default/rollback`. Exported here so
 * the UI does not hard-code it; the server (store.ts) uses this same constant.
 */
export const CODE_DEFAULT_VERSION_ID = "code-default" as const;
export type VersionCreatedByKind = "OPERATOR" | "AI_ASSISTED" | "ROLLBACK";

export type AiSuggestMode = "POLISH" | "CHECK";
export const AI_SUGGEST_MODES = ["POLISH", "CHECK"] as const satisfies readonly AiSuggestMode[];
export type AiTone = "NEUTRAL" | "WARM" | "CONCISE";
export const AI_TONES = ["NEUTRAL", "WARM", "CONCISE"] as const satisfies readonly AiTone[];
/** §4.5 — Session 2 shape 4. */
export type AiUnavailableReason = "KILL_SWITCH" | "COST_FREEZE" | "ALLOWANCE" | "PROVIDER";

// ── §2.2 Content body and blocks ─────────────────────────────────────────────

export type ContentBlock =
  | { kind: "hero"; heading: string; greeting?: string }
  | { kind: "paragraph"; text: string }
  /** `link` = the NAME of a LINK placeholder (§2.3), never a URL. */
  | { kind: "cta"; label: string; link: string }
  | { kind: "info"; title?: string; items: string[]; ordered?: boolean }
  | { kind: "divider" };
export type ContentBlockKind = ContentBlock["kind"];
export const CONTENT_BLOCK_KINDS = ["hero", "paragraph", "cta", "info", "divider"] as const satisfies readonly ContentBlockKind[];

export interface ContentBody {
  /** EMAIL: the subject line. IN_APP: the notification title. */
  subject: string;
  /** EMAIL only (required, non-empty). IN_APP: must be null. */
  preheader: string | null;
  blocks: ContentBlock[];
}

// ── §2.3 Placeholders ────────────────────────────────────────────────────────

export type PlaceholderLocation = "subject" | "preheader" | "body" | "cta";

/** The client view of a placeholder (§3.2 `placeholders`): no `source`, no pii value. */
export interface PlaceholderView {
  name: string;
  kind: "TEXT" | "LINK";
  allowedIn: ReadonlyArray<PlaceholderLocation>;
  maxLength: number;
  fallback: string;
  sample: string;
}

// ── §2.5 Validation issues ───────────────────────────────────────────────────

export type ContentLocation =
  | { field: "subject" }
  | { field: "preheader" }
  | { field: "block"; blockIndex: number; prop: "heading" | "greeting" | "text" | "label" | "link" | "title" | "items"; itemIndex?: number };

export const CONTENT_ISSUE_CODES = [
  "UNKNOWN_PLACEHOLDER", "MALFORMED_PLACEHOLDER", "PLACEHOLDER_KIND_MISMATCH", "PLACEHOLDER_NOT_ALLOWED_HERE",
  "REQUIRED_PLACEHOLDER_MISSING", "PLACEHOLDERS_DROPPED", "PLACEHOLDERS_ADDED",
  "BLOCK_KIND_NOT_ALLOWED", "BLOCK_ORDER", "TOO_MANY_BLOCKS", "TOO_MANY_ITEMS", "EMPTY_CONTENT",
  "EMPTY_FIELD", "FIELD_TOO_LONG", "CONTROL_CHARACTERS",
  "STRUCTURE_CHANGED",
  "LINK_NOT_ALLOWED", "PII_LIKE_CONTENT", "FINANCIAL_CLAIM", "ADVICE_LANGUAGE",
] as const;
export type ContentIssueCode = (typeof CONTENT_ISSUE_CODES)[number];

export interface ContentIssue {
  code: ContentIssueCode;
  severity: "error" | "warning";
  /** null = template-level (e.g. REQUIRED_PLACEHOLDER_MISSING). */
  location: ContentLocation | null;
  placeholder?: string;
  /** Operator-facing; never echoes content beyond the placeholder name. */
  message: string;
}

// ── §2.6 The version DTO (Session 2 shape 1) ─────────────────────────────────

export interface TemplateVersionDTO {
  id: string;
  version: number;
  state: VersionState;
  subject: string;
  preheader: string | null;
  blocks: ContentBlock[];
  placeholdersUsed: string[];
  createdBy: { kind: VersionCreatedByKind; actorKind: "PLATFORM_OPERATOR" | "SYSTEM_ADMIN" };
  createdAt: string;
  publishedAt: string | null;
  auditLogId: string;
  revision: number;
  stream: ContentStreamRef;
  publishAuditLogId: string | null;
  parentVersionId: string | null;
  basePublishedVersionId: string | null;
  restoredFromVersionId: string | null;
  sourceSuggestionId: string | null;
  aiEditedAfterAccept: boolean | null;
  issues: ContentIssue[];
}

// ── §1.1 The viewer block (D2, D6a) ──────────────────────────────────────────

export type RollbackUnavailableReason = "NO_PERMISSION" | "NOTHING_TO_RESTORE";

export interface Viewer {
  canEditContent: boolean;
  canPublish: boolean;
  canRollback: boolean;
  /**
   * v1.1.1 — why canRollback is false; absent when it is true.
   * NO_PERMISSION: the operator lacks CS CONTROL, or the leg is not content-editable (see `locked`).
   * NOTHING_TO_RESTORE: permitted, but the stream has never had a published version.
   */
  rollbackUnavailableReason?: RollbackUnavailableReason;
  canAiSuggest: boolean;
  canTestSend: boolean;
  canEditAutomation: boolean;
  canDryRun: boolean;
  canActivate: boolean;
  /** Comms Center B2 — why canActivate is false regardless of grants (the activation hard gate); null when open. */
  activationDisabledReason?: "ACTIVATION_DISABLED_PENDING_HARDENING" | null;
  canApproveAsOwner: boolean;
  canPauseDisable: boolean;
  testSendEligible: boolean;
  testSendIneligibleReason: "SELF_UNVERIFIED" | "NONPROD_ALLOWLIST" | null;
}

// ── §3.2 The versions list + the ai availability block (D4) ──────────────────

export interface AiAvailability {
  available: boolean;
  reason?: Exclude<AiUnavailableReason, "PROVIDER">;
  detail?: string;
  remainingCallsToday?: number;
  remainingUsdToday?: number | null;
  checkedAt: string;
}

/**
 * §3.2 `limits` — the same numbers validateContent enforces (legs.ts LIMITS).
 * v1.1.1 adds the per-block limits; null = the block kind is not allowed on this
 * channel (IN_APP has no hero or info block), like `preheader`.
 * Breaking one is FIELD_TOO_LONG (heading / greeting / title / items[itemIndex])
 * or TOO_MANY_ITEMS (items), located on the block.
 * The per-block fields are optional in the TYPE only (additive for existing
 * consumers); the server always sends them.
 */
export interface ContentLimits {
  blocks: number;
  subject: number;
  preheader: number | null;
  paragraph: number;
  ctaLabel: number;
  /** hero.heading, characters. */
  heading?: number | null;
  /** hero.greeting, characters. */
  greeting?: number | null;
  /** info.title, characters. */
  infoTitle?: number | null;
  /** info.items, count. */
  infoItems?: number | null;
  /** one info item, characters. */
  infoItem?: number | null;
}

export type LiveContent = { source: "CODE_DEFAULT" } | { source: "PUBLISHED"; versionId: string; version: number };

export interface VersionsResponse extends ListEnvelope<TemplateVersionDTO> {
  stream: ContentStreamRef;
  revision: number;
  live: LiveContent;
  codeDefault: ContentBody & { placeholdersUsed: string[] };
  placeholders: PlaceholderView[];
  limits: ContentLimits;
  contentEditable: boolean;
  locked: { reason: "PROTECTED" | "NOT_EDITABLE" } | null;
  viewer: Viewer;
  ai: AiAvailability;
}

// ── Catalog DTO additions (§1, §2.1) ─────────────────────────────────────────

export interface CatalogContentLeg {
  channel: EditableChannel;
  variants: string[];
  live: Array<{ variant: string; source: "CODE_DEFAULT" } | { variant: string; source: "PUBLISHED"; versionId: string; version: number }>;
}

export interface CatalogDetailV11Additions {
  content: CatalogContentLeg[];
  contentLocked: boolean;
  divergesFrom?: "connection-attention";
  viewer: Viewer;
}

// ── Requests (§3.3–§3.8, §4.3) ───────────────────────────────────────────────

export interface ReasonInput { code: OperatorReasonCode; note?: string }

export interface SaveDraftRequest {
  reason?: ReasonInput;
  expectedRevision: number;
  body: {
    channel: EditableChannel;
    variant?: string;
    parentVersionId: string | null;
    content: ContentBody;
    source: { kind: "MANUAL" } | { kind: "AI_SUGGESTION"; suggestionId: string };
  };
}

export interface PublishRequest { reason: ReasonInput; expectedRevision: number; body: { acknowledgeWarnings: boolean } }
export interface RollbackRequest { reason: ReasonInput; expectedRevision: number; body?: { channel?: EditableChannel; variant?: string } }
export interface AiSuggestRequest { reason?: ReasonInput; body: { mode: AiSuggestMode; tone?: AiTone } }
export interface RenderRequest { channel: EditableChannel; variant?: string; content: ContentBody }

// ── Responses ────────────────────────────────────────────────────────────────

export interface PublishResult {
  published: TemplateVersionDTO;
  superseded: { versionId: string; version: number } | { source: "CODE_DEFAULT" };
  revision: number;
}

export interface RollbackResult {
  published: TemplateVersionDTO | { source: "CODE_DEFAULT" };
  superseded: { versionId: string; version: number } | null;
  revision: number;
}

export interface AiSuggestResult {
  suggestionId: string;
  baseVersionId: string;
  mode: AiSuggestMode;
  base: ContentBody;
  suggestion: ContentBody;
  changes: Array<{ location: ContentLocation; before: string; after: string }>;
  notes: Array<{ location: ContentLocation | null; category: "GRAMMAR" | "SPELLING" | "TONE" | "CLARITY" | "CONSISTENCY"; text: string }>;
  checks: { structurePreserved: true; placeholdersPreserved: true; linksAdded: false; financialClaimsAdded: false; adviceAdded: false };
  model: string;
  expiresAt: string;
  checkedAt: string;
}

/** §3.7 / §3.8 — the preview additions. */
export type ContentPreviewResponse = PreviewResponse & {
  versionId: string | null;
  source: "CODE_DEFAULT" | "VERSION" | "UNSAVED";
  issues: ContentIssue[];
};

/** §0.3 (D5) — the stale-token body. */
export interface ConflictBody { error: string; code: "CONFLICT"; current: number }
