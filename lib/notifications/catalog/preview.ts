/**
 * lib/notifications/catalog/preview.ts  (Comms Center Phase A-1)
 *
 * Render a catalog definition with SYNTHETIC data for
 * GET /catalog/[key]/preview (contract §4.4). Render only — this module never
 * sends: it imports no transport and not the send chokepoint, only the pure
 * template registry. catalog.test.ts replaces both transports with throwing
 * stubs and renders every (key, channel, variant), and also scans this file's
 * imports.
 *
 * Fixtures are code (no query parameter supplies data):
 *   - email and operator legs reuse lib/email/preview.ts previewCases() — the
 *     call sites' own builders, the non-redeemable token `preview-not-redeemable`,
 *     `@example.invalid` recipients and fixed dates;
 *   - a registry type's in-app rendition (and its generic notification email,
 *     when no preview case exists) uses the registry render over IN_APP_FIXTURES;
 *   - banners use the client notice copy (components/notices/notice-model.ts).
 */

import { getTemplate } from "@/lib/email/templates";
import { PREVIEW_APP_BASE, previewCases, type PreviewCase } from "@/lib/email/preview";
import { buildNotificationEmailData } from "@/lib/notifications/channels/email-data";
import { CONNECTION_STATES } from "@/lib/notifications/connection-attention";
import { WALLET_ATTENTION_STATES } from "@/lib/notifications/wallet-attention";
import { NOTIFICATION_REGISTRY, type NotificationTypeId } from "@/lib/notifications/registry";
import type { NotificationTypeDefinition } from "@/lib/notifications/types";
import {
  CONNECT_ACTION, CONNECT_HREF, CONNECT_TEXT,
  MAINTENANCE_DESCRIPTION, MAINTENANCE_TITLE,
  TWO_FACTOR_ACTION, TWO_FACTOR_HREF, TWO_FACTOR_TEXT,
} from "@/components/notices/notice-model";
import { isPreviewableLeg } from "@/lib/notifications/catalog/definitions";
import type { ChannelLeg, CommsChannel, CommsDefinition, PreviewChannel, PreviewResponse } from "@/lib/notifications/catalog/types";

// ── Synthetic in-app fixtures (one entry per registry type; compile-checked) ──

type Fixture = Readonly<Record<string, unknown>>;
const D = "default";

const syncFailedVariants: Record<string, Fixture> = Object.fromEntries([
  ...CONNECTION_STATES.map((state) => [state, { plaidItemId: "preview-item", institutionName: "Example Bank", connectionState: state }]),
  ["legacy-no-state", { plaidItemId: "preview-item", institutionName: "Example Bank" }],
]);

/** Named synthetic cases per registry type. Values are fictional; nothing here identifies a person. */
export const IN_APP_FIXTURES: { readonly [K in NotificationTypeId]: Readonly<Record<string, Fixture>> } = {
  PASSWORD_CHANGED: { [D]: {} },
  PASSWORD_RESET: { [D]: {} },
  EMAIL_CHANGE_REQUESTED: { [D]: { pendingEmail: "n•••@example.invalid" } },
  EMAIL_CHANGE_COMPLETED: { [D]: {} },
  EMAIL_VERIFIED: { [D]: {} },
  TWO_FACTOR_ENABLED: { [D]: {} },
  TWO_FACTOR_DISABLED: { [D]: {} },
  TWO_FACTOR_RESET: { [D]: {} },
  RECOVERY_CODE_USED: { [D]: {} },
  RECOVERY_CODES_REGENERATED: { [D]: {} },
  SESSION_REVOKED: { [D]: { device: "Example Browser on Example OS" } },
  ACCOUNT_DEACTIVATED: { [D]: {} },
  ACCOUNT_REACTIVATED: { [D]: {} },
  ACCOUNT_DELETION_REQUESTED: { [D]: { scheduledFor: "2026-11-07" } },
  ACCOUNT_DELETION_CANCELLED: { [D]: {} },
  DATA_EXPORTED: { [D]: {} },
  PLATFORM_ACCESS_GRANTED: {
    granted: { area: "SECURITY_OPS", areaLabel: "Security Operations", level: "READ", levelLabel: "read-only", change: "granted" },
    "level-changed": { area: "SECURITY_OPS", areaLabel: "Security Operations", level: "WRITE", levelLabel: "read and write", change: "level_changed" },
  },
  PLATFORM_ACCESS_REVOKED: { [D]: { area: "SECURITY_OPS", areaLabel: "Security Operations", level: "READ", levelLabel: "read-only" } },
  SPACE_INVITE_RECEIVED: { [D]: { inviteId: "preview-invite", spaceName: "Example Household", inviterName: "Alex Example" } },
  SPACE_INVITE_ACCEPTED: { [D]: { inviteId: "preview-invite", spaceName: "Example Household", memberName: "Sam Example" } },
  MEMBER_REMOVED: { [D]: { spaceName: "Example Household" } },
  MEMBER_ROLE_CHANGED: { [D]: { spaceName: "Example Household", oldRole: "MEMBER", newRole: "ADMIN" } },
  SPACE_OWNERSHIP_TRANSFERRED: { [D]: { spaceName: "Example Household", previousOwnerName: "Alex Example" } },
  SYNC_FAILED: syncFailedVariants,
  SYNC_COMPLETED: { [D]: { plaidItemId: "preview-item", institutionName: "Example Bank" } },
  WALLET_SYNC_FAILED: Object.fromEntries(WALLET_ATTENTION_STATES.map((walletState) =>
    [walletState, { financialAccountId: "preview-account", walletName: "Example BTC Wallet", network: "Bitcoin", walletState }])),
  DUPLICATE_DETECTED: { [D]: { candidateIds: ["preview-candidate"], count: 1 } },
  IMPORT_COMPLETED: { [D]: { batchId: "preview-batch", rowCount: 42 } },
  IMPORT_COMPLETED_WITH_ERRORS: { [D]: { batchId: "preview-batch", errorCount: 3 } },
  DAILY_BRIEF_READY: { [D]: {} },
  OPPORTUNITY_FOUND: { [D]: { adviceId: "preview-advice", agentId: "preview-agent" } },
  UNUSUAL_SPENDING: { [D]: { transactionIds: ["preview-transaction"], agentId: "preview-agent" } },
  DEBT_ALERT: { [D]: { financialAccountId: "preview-account", agentId: "preview-agent" } },
  MAINTENANCE_SCHEDULED: { [D]: { window: "Sunday 02:00–03:00 UTC" } },
  FEATURE_RELEASED: { [D]: { featureName: "Example feature" } },
  POLICY_UPDATED: { [D]: { policyName: "Example policy" } },
  ACCOUNT_WELCOME: { [D]: {} },
  SECURITY_ANOMALY_DETECTED: {
    [D]: {
      // The stored form is a salted hash (Comms Center A-2b, O-8); synthetic here.
      anomalyKey: "identifier:h00000000000000000000000000000000",
      title: "Repeated failed sign-in attempts",
      summary: "8 failed sign-in attempts in the last 15 minutes (threshold 5).",
    },
  },
  DIGEST_SENT: { [D]: { notificationIds: ["preview-notification"], periodStart: "2026-10-24", periodEnd: "2026-10-31" } },
};

/** Banner copy by leg template id. */
const BANNERS: Record<string, { title: string; description: string | null; action: { label: string; href: string } | null }> = {
  "notice:maintenance": { title: MAINTENANCE_TITLE, description: MAINTENANCE_DESCRIPTION, action: null },
  "notice:two-factor": { title: TWO_FACTOR_TEXT, description: null, action: { label: TWO_FACTOR_ACTION, href: TWO_FACTOR_HREF } },
  "notice:connect": { title: CONNECT_TEXT, description: null, action: { label: CONNECT_ACTION, href: CONNECT_HREF } },
};

/** Which catalog channel each preview rendition reads. */
export const PREVIEW_CHANNEL_SOURCE: Record<PreviewChannel, CommsChannel> = {
  "email-html": "EMAIL",
  "email-text": "EMAIL",
  "in-app": "IN_APP",
  operator: "OPERATOR_EMAIL",
  banner: "BANNER",
};

let caseIndex: Map<string, PreviewCase> | null = null;
function previewCase(slug: string): PreviewCase | undefined {
  caseIndex ??= new Map(previewCases().map((c) => [c.slug, c]));
  return caseIndex.get(slug);
}

/** A named synthetic rendition of one leg. */
interface Variant { name: string; leg: ChannelLeg; render: () => Omit<PreviewResponse, "key" | "definitionVersion" | "templateVersion" | "channel" | "synthetic" | "variants" | "checkedAt"> }

const EMPTY = { subject: null, html: null, text: null, inApp: null } as const;

function registryDef(def: CommsDefinition): NotificationTypeDefinition | null {
  return def.notificationTypeId ? NOTIFICATION_REGISTRY[def.notificationTypeId] : null;
}

function renderEmail(template: PreviewCase["template"], data: Record<string, unknown>) {
  const r = getTemplate(template).render(data as never);
  // Every preview subject is marked; a template that ignored `preview: true` is refused.
  if (!r.subject.startsWith("[PREVIEW]")) throw new Error("catalog preview: subject is not marked [PREVIEW]");
  return { subject: r.subject, html: r.html ?? null, text: r.text };
}

function variantsFor(def: CommsDefinition, source: CommsChannel): Variant[] {
  const reg = registryDef(def);
  const fixtures = def.notificationTypeId ? IN_APP_FIXTURES[def.notificationTypeId] : {};
  const out: Variant[] = [];
  for (const leg of def.channels) {
    if (leg.channel !== source || !isPreviewableLeg(leg, reg !== null)) continue;
    if (leg.channel === "IN_APP" && reg) {
      for (const [name, data] of Object.entries(fixtures)) {
        out.push({ name, leg, render: () => {
          const r = reg.render(data);
          return { ...EMPTY, text: r.body ?? null, inApp: { title: r.title, body: r.body ?? null, href: r.href ?? null, icon: reg.icon } };
        } });
      }
    } else if (leg.channel === "BANNER" && leg.template) {
      const copy = BANNERS[leg.template.id];
      if (!copy) continue;
      out.push({ name: D, leg, render: () => ({
        ...EMPTY,
        text: [copy.title, copy.description, copy.action ? `${copy.action.label} → ${copy.action.href}` : null].filter(Boolean).join("\n"),
      }) });
    } else if (leg.previewSlugs && leg.previewSlugs.length > 0) {
      for (const slug of leg.previewSlugs) {
        out.push({ name: slug, leg, render: () => {
          const c = previewCase(slug);
          if (!c) throw new Error("catalog preview: preview case missing");
          return { ...EMPTY, ...renderEmail(c.template, c.data) };
        } });
      }
    } else if (leg.path === "REGISTRY" && leg.channel === "EMAIL" && reg) {
      // The generic notification email, built exactly as channels/email.ts builds it.
      for (const [name, data] of Object.entries(fixtures)) {
        out.push({ name: `notification--${name}`, leg, render: () => {
          const r = reg.render(data);
          const emailData = buildNotificationEmailData(
            { title: r.title, body: r.body, href: r.href, actionLabel: r.actionLabel, category: reg.category },
            PREVIEW_APP_BASE,
          );
          return { ...EMPTY, ...renderEmail("notification", { ...emailData, preview: true }) };
        } });
      }
    }
  }
  return out;
}

export type PreviewOutcome =
  | { ok: true; body: Omit<PreviewResponse, "checkedAt"> }
  | { ok: false; code: "INVALID_STATE" | "VALIDATION"; error: string };

/** The variant names a (definition, channel) pair offers; empty ⇒ the channel is not available. */
export function previewVariants(def: CommsDefinition, channel: PreviewChannel): string[] {
  return variantsFor(def, PREVIEW_CHANNEL_SOURCE[channel]).map((v) => v.name);
}

/**
 * Render one synthetic preview. Throws only on a programming error (a missing
 * fixture or an unmarked subject), which the route turns into 503 UNAVAILABLE.
 */
export function renderCatalogPreview(def: CommsDefinition, channel: PreviewChannel, variant: string | null): PreviewOutcome {
  const variants = variantsFor(def, PREVIEW_CHANNEL_SOURCE[channel]);
  if (variants.length === 0) {
    return { ok: false, code: "INVALID_STATE", error: `This definition has no ${channel} rendition.` };
  }
  const chosen = variant === null ? variants[0] : variants.find((v) => v.name === variant);
  if (!chosen) return { ok: false, code: "VALIDATION", error: "Unknown preview variant." };
  const rendered = chosen.render();
  // email-text carries no HTML; email-html keeps both (the text is the multipart alternative).
  const shaped = channel === "email-text" ? { ...rendered, html: null } : rendered;
  return {
    ok: true,
    body: {
      key: def.key,
      definitionVersion: def.definitionVersion,
      templateVersion: chosen.leg.template?.version ?? null,
      channel,
      synthetic: true,
      ...shaped,
      variants: variants.map((v) => v.name),
    },
  };
}
