/**
 * lib/notifications/content/legs.ts  (Comms Center B1 — which legs are editable, and with what)
 *
 * Contract v1.1 §2.1 (the editable rule), §2.3 (the closed placeholder
 * allowlist per template) and §5.3 (the code default). Pure config over the
 * catalog and the registry — no I/O.
 *
 * THE RULE (§2.1), computed here and pinned by content.test.ts. A leg
 * (definition, channel) is content-editable when ALL of:
 *   1. the definition is not `protected` (no SECURITY_CRITICAL / CEREMONY /
 *      OPERATOR message, no read-only-only definition)              → else PROTECTED
 *   2. consentClass ∈ {SERVICE, AWARENESS}                          → else NOT_EDITABLE
 *   3. status ∈ {ENABLED, BUILD}                                    → else NOT_EDITABLE
 *   4. channel ∈ {EMAIL, IN_APP}, a REGISTRY leg of a registry type
 *      (the registry render is the renderer; no read-only surface)  → else NOT_EDITABLE
 *   5. an EMAIL leg renders through the generic `notification`
 *      template. A definition whose EMAIL is a DIRECT send on its own
 *      template (the ceremony templates, `space-invite`, `welcome`,
 *      `digest`) keeps that leg locked                              → PROTECTED
 *   and the leg has a content spec below (a placeholder allowlist).
 *
 * DIVERGENCE FROM THE CONTRACT TABLE (§2.1), recorded: the contract was written
 * against develop 61ba9a5. Since then PLAID_ITEM_REAUTH_REQUIRED and
 * PLAID_ITEM_REVOKED were RETIRED (built under SYNC_FAILED), WALLET_SYNC_FAILED
 * and ACCOUNT_WELCOME became registry types, and the welcome email became a
 * direct `welcome` template. The rule above is applied to TODAY's catalog, so
 * the BUILD `operator-content` template is not needed in B1, ACCOUNT_WELCOME's
 * EMAIL leg stays locked (rule 5) and its IN_APP leg is editable. `inAppHref`
 * is offered only where the registry render has an href (it is "the registry
 * href, fixed in code"); MEMBER_REMOVED and the import notices have none.
 *
 * PLACEHOLDER VALUES come only from the trigger payload (the notification's
 * render data) or a trusted app link — never from a request, never from an
 * operator (§2.3). RECIPIENT sources are not needed by any editable leg in B1.
 */

import { getCatalogDefinition, CATALOG_KEYS, COMMS_CATALOG } from "@/lib/notifications/catalog/definitions";
import { NOTIFICATION_REGISTRY, type NotificationTypeId } from "@/lib/notifications/registry";
import type { CommsDefinition, ConsentClass, DefinitionStatus } from "@/lib/notifications/catalog/types";
import type { RenderedNotification } from "@/lib/notifications/types";
import { CONNECTION_STATES } from "@/lib/notifications/connection-attention";
import { WALLET_ATTENTION_STATES, parseWalletAttentionState } from "@/lib/notifications/wallet-attention";
import { DEFAULT_NOTIFICATION_ACTION_LABEL } from "@/lib/email/templates/notification";
import { EDITABLE_CHANNELS, type ContentBlock, type ContentBody, type EditableChannel, type PlaceholderLocation, type PlaceholderView } from "./types";

// ── Placeholder specs (§2.3) ────────────────────────────────────────────────

export interface PlaceholderSpec {
  name: string;
  kind: "TEXT" | "LINK";
  /** Where the value comes from at send time. Never from a request, never operator-supplied. */
  source: { from: "PAYLOAD"; field: string } | { from: "APP_LINK"; path: string } | { from: "IN_APP_HREF" };
  allowedIn: ReadonlyArray<PlaceholderLocation>;
  /** TEXT: the value is cleanText()-ed and capped to this. */
  maxLength: number;
  /** Used when the value is missing; never empty. */
  fallback: string;
  /** Synthetic value for preview / render (fictional). */
  sample: string;
  /** True for names: such values never reach a ledger, an audit row or the AI. */
  pii: boolean;
  /** TEXT placeholders a template requires in a field (§2.3 "required placeholders"). */
  requiredIn?: ReadonlyArray<"subject">;
}

const TEXT_IN: ReadonlyArray<PlaceholderLocation> = ["subject", "preheader", "body", "cta"];
const text = (name: string, field: string, fallback: string, sample: string, opts: { pii?: boolean; maxLength?: number; requiredInSubject?: boolean } = {}): PlaceholderSpec => ({
  name, kind: "TEXT", source: { from: "PAYLOAD", field }, allowedIn: TEXT_IN,
  maxLength: opts.maxLength ?? 80, fallback, sample, pii: opts.pii ?? false,
  ...(opts.requiredInSubject ? { requiredIn: ["subject"] as const } : {}),
});

/** The TEXT placeholders of each editable key, with today's registry fallbacks. */
const TEXT_PLACEHOLDERS: Partial<Record<NotificationTypeId, readonly PlaceholderSpec[]>> = {
  SPACE_INVITE_RECEIVED: [text("spaceName", "spaceName", "a Space", "Example Household"), text("inviterName", "inviterName", "A member", "Alex Example", { pii: true, maxLength: 60 })],
  SPACE_INVITE_ACCEPTED: [text("memberName", "memberName", "Your invitee", "Sam Example", { pii: true, maxLength: 60 }), text("spaceName", "spaceName", "your Space", "Example Household")],
  MEMBER_REMOVED: [text("spaceName", "spaceName", "a Space", "Example Household")],
  MEMBER_ROLE_CHANGED: [text("spaceName", "spaceName", "a Space", "Example Household"), text("oldRole", "oldRole", "Previous role", "MEMBER", { maxLength: 40 }), text("newRole", "newRole", "new role", "ADMIN", { maxLength: 40 })],
  SYNC_FAILED: [text("institutionName", "institutionName", "your institution", "Example Bank", { requiredInSubject: true })],
  SYNC_COMPLETED: [text("institutionName", "institutionName", "A connection", "Example Bank")],
  WALLET_SYNC_FAILED: [text("walletName", "walletName", "Your wallet", "Example BTC Wallet", { pii: true, maxLength: 60 }), text("networkName", "network", "its network", "Bitcoin", { maxLength: 40 })],
  IMPORT_COMPLETED: [text("rowCount", "rowCount", "some", "42", { maxLength: 12 })],
  IMPORT_COMPLETED_WITH_ERRORS: [text("errorCount", "errorCount", "some", "3", { maxLength: 12 })],
  ACCOUNT_WELCOME: [],
};

/** The content-editable registry types (the keys of TEXT_PLACEHOLDERS). */
export const CONTENT_SPEC_KEYS = Object.keys(TEXT_PLACEHOLDERS) as NotificationTypeId[];

// ── Variants ─────────────────────────────────────────────────────────────────

export const DEFAULT_VARIANT = "default";
export const SYNC_FAILED_LEGACY_VARIANT = "legacy-no-state";

/** The content variants of a key (the same names as the preview fixtures). */
export function contentVariants(key: string): string[] {
  if (key === "SYNC_FAILED") return [...CONNECTION_STATES, SYNC_FAILED_LEGACY_VARIANT];
  if (key === "WALLET_SYNC_FAILED") return [...WALLET_ATTENTION_STATES];
  return [DEFAULT_VARIANT];
}

/** The variant a send uses, from its render data (untrusted). Mirrors the registry render's own narrowing. */
export function variantFor(key: string, data: Readonly<Record<string, unknown>>): string {
  if (key === "SYNC_FAILED") {
    const s = data.connectionState;
    return typeof s === "string" && (CONNECTION_STATES as readonly string[]).includes(s) ? s : SYNC_FAILED_LEGACY_VARIANT;
  }
  if (key === "WALLET_SYNC_FAILED") return parseWalletAttentionState(data.walletState);
  return DEFAULT_VARIANT;
}

/** The render data that selects a variant in the registry render (fixture shape). */
function variantData(key: string, variant: string): Record<string, unknown> {
  if (key === "SYNC_FAILED") return variant === SYNC_FAILED_LEGACY_VARIANT ? {} : { connectionState: variant };
  if (key === "WALLET_SYNC_FAILED") return { walletState: variant };
  return {};
}

// ── The editable rule (§2.1) ────────────────────────────────────────────────

export type Editability = { editable: true } | { editable: false; reason: "PROTECTED" | "NOT_EDITABLE" };

const EDITABLE_CLASSES: ReadonlySet<ConsentClass> = new Set(["SERVICE", "AWARENESS"]);
const EDITABLE_STATUS: ReadonlySet<DefinitionStatus> = new Set(["ENABLED", "BUILD"]);

/** §2.1 — may an operator edit this leg's content? */
export function legEditability(def: CommsDefinition, channel: string): Editability {
  if (def.protected) return { editable: false, reason: "PROTECTED" };
  if (!(EDITABLE_CHANNELS as readonly string[]).includes(channel)) return { editable: false, reason: "NOT_EDITABLE" };
  const legs = def.channels.filter((c) => c.channel === channel);
  const registryLeg = legs.find((c) => c.path === "REGISTRY" && (channel === "IN_APP" || c.email?.template === "notification"));
  // Rule 5: an EMAIL delivered only by a direct send on its own template stays locked.
  if (channel === "EMAIL" && !registryLeg && legs.some((c) => c.path === "DIRECT")) return { editable: false, reason: "PROTECTED" };
  if (!EDITABLE_CLASSES.has(def.consentClass)) return { editable: false, reason: "NOT_EDITABLE" };
  if (!EDITABLE_STATUS.has(def.status)) return { editable: false, reason: "NOT_EDITABLE" };
  if (!registryLeg || def.notificationTypeId === null) return { editable: false, reason: "NOT_EDITABLE" };
  if (!(def.notificationTypeId in TEXT_PLACEHOLDERS)) return { editable: false, reason: "NOT_EDITABLE" };
  return { editable: true };
}

/** The editable channels of a definition, in EDITABLE_CHANNELS order. */
export function editableChannels(def: CommsDefinition): EditableChannel[] {
  return EDITABLE_CHANNELS.filter((c) => legEditability(def, c).editable);
}

/** Whole-definition lock: every write is refused (PROTECTED beats NOT_EDITABLE). Null when some leg is editable. */
export function definitionLock(def: CommsDefinition): { reason: "PROTECTED" | "NOT_EDITABLE" } | null {
  if (editableChannels(def).length > 0) return null;
  if (def.protected) return { reason: "PROTECTED" };
  const reasons = EDITABLE_CHANNELS.map((c) => legEditability(def, c)).filter((e): e is Extract<Editability, { editable: false }> => !e.editable);
  return { reason: reasons.some((r) => r.reason === "PROTECTED") ? "PROTECTED" : "NOT_EDITABLE" };
}

/** Every content-editable (key, channel) — the list content.test.ts pins. */
export function editableLegs(): Array<{ key: string; channel: EditableChannel }> {
  return CATALOG_KEYS.flatMap((k) => editableChannels(COMMS_CATALOG[k]).map((channel) => ({ key: k as string, channel })));
}

/** Legs whose edited copy can differ from a surface that reads the code copy directly (§2.1 known divergence). */
export function divergesFrom(key: string): "connection-attention" | undefined {
  return key === "SYNC_FAILED" ? "connection-attention" : undefined;
}

// ── The leg spec ─────────────────────────────────────────────────────────────

export interface LegSpec {
  key: NotificationTypeId;
  channel: EditableChannel;
  variants: string[];
  placeholders: PlaceholderSpec[];
  /** The registry in-app href (fixed in code), per variant; null when the type has none. */
  hrefFor(variant: string): string | null;
  /** The code default as a ContentBody (§3.2 codeDefault; what `code-default` rollback restores). */
  codeDefault(variant: string): ContentBody;
  /** EMAIL: the LINK placeholder a code-default CTA uses (required, §2.3); null when the default has no CTA. */
  requiredLink(variant: string): string | null;
}

/** Cut at a word boundary to at most `max` characters (an ellipsis marks the cut). */
function capWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** §2.2 limits, per channel. */
export const LIMITS = {
  EMAIL: { blocksMin: 1, blocks: 12, subject: 120, preheader: 140, paragraph: 1200, ctaLabel: 40, heading: 120, infoItems: 8, infoItem: 200, infoTitle: 120 },
  IN_APP: { blocksMin: 0, blocks: 2, subject: 120, preheader: null, paragraph: 280, ctaLabel: 40, heading: 120, infoItems: 8, infoItem: 200, infoTitle: 120 },
} as const;

/** The leg spec of an editable leg; undefined otherwise. */
export function legSpec(key: string, channel: string): LegSpec | undefined {
  const def = getCatalogDefinition(key);
  if (!def || !legEditability(def, channel).editable) return undefined;
  const id = def.notificationTypeId as NotificationTypeId;
  const reg = NOTIFICATION_REGISTRY[id];
  const ch = channel as EditableChannel;
  const texts = TEXT_PLACEHOLDERS[id] ?? [];

  /** The registry render over placeholder TOKENS: its copy, with each value replaced by {{name}}. */
  const tokenRender = (variant: string) => {
    const data: Record<string, unknown> = { ...variantData(id, variant) };
    for (const p of texts) if (p.source.from === "PAYLOAD") data[p.source.field] = `{{${p.name}}}`;
    return (reg.render as (d: Record<string, unknown>) => RenderedNotification)(data);
  };
  const hrefFor = (variant: string) => tokenRender(variant).href ?? null;
  const anyHref = contentVariants(id).some((v) => hrefFor(v) !== null);

  const links: PlaceholderSpec[] = !anyHref ? [] : ch === "EMAIL"
    ? [{ name: "actionUrl", kind: "LINK", source: { from: "IN_APP_HREF" }, allowedIn: ["cta"], maxLength: 2048, fallback: "", sample: "https://app.example.invalid", pii: false }]
    : [{ name: "inAppHref", kind: "LINK", source: { from: "IN_APP_HREF" }, allowedIn: ["cta"], maxLength: 512, fallback: "", sample: "/dashboard", pii: false }];

  const codeDefault = (variant: string): ContentBody => {
    const r = tokenRender(variant);
    const blocks: ContentBlock[] = [];
    if (ch === "EMAIL") {
      // Exactly the `notification` template's block list (lib/email/templates/notification.ts).
      blocks.push({ kind: "hero", heading: r.title });
      if (r.body) blocks.push({ kind: "paragraph", text: r.body });
      if (r.href) blocks.push({ kind: "cta", label: r.actionLabel || DEFAULT_NOTIFICATION_ACTION_LABEL, link: "actionUrl" });
      // The template's preheader is the whole body; operator content caps it at 140, so
      // the code default's preheader is the body cut at a word boundary (the send path
      // without a published version still uses the template, byte for byte).
      return { subject: r.title, preheader: capWords(r.body ?? r.title, LIMITS.EMAIL.preheader), blocks };
    }
    if (r.body) blocks.push({ kind: "paragraph", text: r.body });
    if (r.href && r.actionLabel) blocks.push({ kind: "cta", label: r.actionLabel, link: "inAppHref" });
    return { subject: r.title, preheader: null, blocks };
  };

  return {
    key: id,
    channel: ch,
    variants: contentVariants(id),
    placeholders: [...texts, ...links],
    hrefFor,
    codeDefault,
    requiredLink: (variant) => (ch === "EMAIL" && hrefFor(variant) !== null ? "actionUrl" : null),
  };
}

/** §3.2 `placeholders` — no source, no pii value. */
export function placeholderViews(spec: LegSpec): PlaceholderView[] {
  return spec.placeholders.map((p) => ({ name: p.name, kind: p.kind, allowedIn: [...p.allowedIn], maxLength: p.maxLength, fallback: p.fallback, sample: p.sample }));
}

/** The stream id the audit target and the lock key use. */
export function streamId(key: string, channel: string, variant: string): string {
  return `${key}:${channel}:${variant}`;
}
