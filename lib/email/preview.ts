/**
 * lib/email/preview.ts
 *
 * The logic behind scripts/email-preview.ts: render every design-system email
 * template with SYNTHETIC data to .html + .txt files, and — only on an explicit
 * `--send --to <addr>` whose address EXACTLY equals the local-only env var
 * EMAIL_PREVIEW_ALLOWED_TO — send them through the real sendEmail().
 *
 * Coverage: EVERY template in the registry that a real caller sends has at
 * least one case here (catalog.test.ts enforces it), and security alerts and
 * notifications are built with the SAME builders the call sites use
 * (lib/email/security-alerts.ts, the notification registry +
 * channels/email-data.ts), so a preview is exactly the shipped email.
 *
 * Safety:
 *   - Every token link carries the literal token `preview-not-redeemable`. It
 *     is not hex, is never hashed or stored, so no token row can ever match it.
 *   - Every person-shaped address is under the reserved `example.invalid` domain.
 *   - Every preview subject starts with "[PREVIEW]".
 *   - The recipient allowlist is an env var that is never committed; with it
 *     unset, or with any other address, a send is refused before anything is
 *     rendered or sent. This repo is public: no real address lives in it.
 *   - Nothing here touches the database. Rendering touches no network.
 *
 * I/O (file writes, the send) is injected so the refusal is unit-testable.
 */

import type { EmailResult, EmailTemplateName } from "@/lib/email/types";
import { getTemplate } from "@/lib/email/templates";
import { buildBetaInviteUrl } from "@/lib/email/beta-invite-url";
import { buildResetUrl } from "@/lib/email/reset-url";
import { buildVerifyUrl } from "@/lib/email/verify-url";
import { buildEmailChangeUrl } from "@/lib/email/email-change-url";
import { buildInviteUrl } from "@/lib/email/invite-url";
import * as alerts from "@/lib/email/security-alerts";
import { getNotificationDefinition } from "@/lib/notifications/registry";
import { buildNotificationEmailData } from "@/lib/notifications/channels/email-data";
import { CONNECTION_STATES } from "@/lib/notifications/connection-attention";

/** The token every preview link carries. Deliberately not a 64-char hex token. */
export const PREVIEW_TOKEN = "preview-not-redeemable";

/** Preview links use the Production app origin shape with the non-redeemable token. */
export const PREVIEW_APP_BASE = "https://app.fourthmeridian.com";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed synthetic issue time, so preview output is deterministic. */
const PREVIEW_ISSUED_AT = new Date("2026-10-31T15:04:00.000Z");

export interface PreviewCase {
  /** File stem, e.g. "beta-invite--request--named--14d". */
  slug: string;
  template: EmailTemplateName;
  /** The template data, exactly as a caller passes it to sendEmail (plus preview: true). */
  data: Record<string, unknown>;
}

function pc(slug: string, template: EmailTemplateName, data: object): PreviewCase {
  return { slug, template, data: { ...data, preview: true } };
}

/** A notification email built the way createNotification → channels/email.ts builds it. */
function notificationCase(slug: string, type: string, renderData: Record<string, unknown>): PreviewCase {
  const def = getNotificationDefinition(type);
  if (!def) throw new Error(`email-preview: unknown notification type ${type}`);
  const r = def.render(renderData);
  return pc(slug, "notification", buildNotificationEmailData(
    { title: r.title, body: r.body, href: r.href, actionLabel: r.actionLabel, category: def.category },
    PREVIEW_APP_BASE,
  ));
}

/** Every template built on the design system, in the variants real callers produce. */
export function previewCases(): PreviewCase[] {
  const cases: PreviewCase[] = [];
  const at = PREVIEW_ISSUED_AT;

  // Beta invite: both origins × validity × named/unnamed (unchanged from PR #157).
  const inviteUrl = buildBetaInviteUrl(PREVIEW_APP_BASE, PREVIEW_TOKEN);
  for (const origin of ["request", "direct"] as const) {
    for (const days of [1, 7, 14, 30]) {
      for (const named of [false, true]) {
        cases.push(pc(`beta-invite--${origin}--${named ? "named" : "unnamed"}--${days}d`, "beta-invite", {
          origin,
          recipientName: named ? "Alex Example" : null,
          inviteUrl,
          issuedAt: at,
          expiresAt: new Date(at.getTime() + days * DAY_MS),
        }));
      }
    }
  }

  // Token ceremonies.
  cases.push(pc("password-reset", "password-reset", { resetUrl: buildResetUrl(PREVIEW_APP_BASE, PREVIEW_TOKEN) }));
  cases.push(pc("email-verification", "email-verification", { verifyUrl: buildVerifyUrl(PREVIEW_APP_BASE, PREVIEW_TOKEN) }));
  cases.push(pc("email-change--confirm-new-address", "email-change", { confirmUrl: buildEmailChangeUrl(PREVIEW_APP_BASE, PREVIEW_TOKEN) }));

  // Security alerts — the call sites' own builders.
  const sec: [string, object][] = [
    ["data-exported",               alerts.dataExportedAlert(at, PREVIEW_APP_BASE)],
    ["password-reset-completed",    alerts.passwordResetCompletedAlert(at)],
    ["password-changed",            alerts.passwordChangedAlert(at)],
    ["email-change-old-address",    alerts.emailChangeRequestedAlert("new-address@example.invalid", at)],
    ["two-factor-reset",            alerts.twoFactorResetAlert(at)],
    ["account-deactivated",         alerts.accountDeactivatedAlert(at)],
    ["account-reactivated",         alerts.accountReactivatedAlert(at)],
    ["account-deletion-scheduled",  alerts.accountDeletionScheduledAlert(new Date(at.getTime() + 7 * DAY_MS))],
    ["account-deletion-cancelled",  alerts.accountDeletionCancelledAlert(at)],
    ["account-deleted",             alerts.accountDeletedAlert()],
    ["owner-sign-in-anomaly",       alerts.ownerSignInAnomalyAlert(PREVIEW_APP_BASE)],
    ["security-ops-anomaly",        alerts.securityOpsAnomalyAlert({
      key: "identifier:preview-user@example.invalid",
      title: "Repeated failed sign-in attempts",
      message: "We noticed 8 failed sign-in attempts on this account in the last 15 minutes.",
      count: 8, windowMinutes: 15, threshold: 5,
    })],
  ];
  for (const [slug, data] of sec) cases.push(pc(`security-alert--${slug}`, "security-alert", data));

  // Space member invitation (no token: identity-gated in-app acceptance).
  cases.push(pc("space-invite", "space-invite", {
    spaceName: "Example Household", inviterName: "Alex Example", role: "MEMBER", inviteUrl: buildInviteUrl(PREVIEW_APP_BASE),
  }));

  // Generic notification email: one case per real connection state plus a
  // pre-state legacy row. (SPACE_INVITE_RECEIVED has no email since 2026-10-31
  // — the invite's one email is the dedicated space-invite case above.)
  for (const state of CONNECTION_STATES) {
    cases.push(notificationCase(`notification--connection-${state}`, "SYNC_FAILED", {
      plaidItemId: "preview-item", institutionName: "Example Bank", connectionState: state,
    }));
  }
  cases.push(notificationCase("notification--connection-legacy-no-state", "SYNC_FAILED", {
    plaidItemId: "preview-item", institutionName: "Example Bank",
  }));

  // Operator / internal.
  const queueUrl = `${PREVIEW_APP_BASE}/dashboard/platform/GROWTH_REVENUE`;
  cases.push(pc("beta-request--with-note", "beta-request", {
    applicantEmail: "applicant@example.invalid", note: "I track a household budget across three banks.", queueUrl,
  }));
  cases.push(pc("beta-request--no-note", "beta-request", { applicantEmail: "applicant@example.invalid", note: null, queueUrl }));
  cases.push(pc("platform-alert", "platform-alert", {
    evaluatedAtISO: at.toISOString(),
    alerts: [
      { title: "job-health:sync-banks", severity: "critical", summary: "sync-banks has not completed in 26 hours" },
      { title: "connection-health", severity: "warning", summary: "3 connections need attention" },
    ],
  }));
  cases.push(pc("smoke", "smoke", { note: "preview" }));

  return cases;
}

/** Keep only cases whose slug starts with one of `prefixes` (null = all). Throws if nothing matches. */
export function filterPreviewCases(cases: PreviewCase[], prefixes: readonly string[] | null): PreviewCase[] {
  if (!prefixes) return cases;
  const kept = cases.filter((c) => prefixes.some((p) => c.slug.startsWith(p)));
  if (kept.length === 0) throw new Error("email-preview: --only matched no preview case");
  return kept;
}

export interface PreviewArgs {
  out: string | null;
  send: boolean;
  to: string | null;
  /** --only <comma-separated slug prefixes>; null = every case. */
  only: string[] | null;
}

export function parsePreviewArgs(argv: readonly string[]): PreviewArgs {
  const args: PreviewArgs = { out: null, send: false, to: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i] ?? null;
    else if (a === "--send") args.send = true;
    else if (a === "--to") args.to = argv[++i] ?? null;
    else if (a === "--only") {
      const list = (argv[++i] ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
      if (list.length === 0) throw new Error("email-preview: --only needs a comma-separated list of slug prefixes");
      args.only = list;
    }
    else throw new Error(`email-preview: unknown argument ${JSON.stringify(a)}`);
  }
  return args;
}

/**
 * Throws unless `to` is non-empty and EXACTLY equals EMAIL_PREVIEW_ALLOWED_TO.
 * The error never prints either address.
 */
export function assertPreviewSendAllowed(to: string | null, allowed: string | undefined): string {
  if (!allowed) {
    throw new Error("email-preview: refusing to send — EMAIL_PREVIEW_ALLOWED_TO is not set in this local environment.");
  }
  if (!to || to !== allowed) {
    throw new Error("email-preview: refusing to send — --to does not exactly match EMAIL_PREVIEW_ALLOWED_TO.");
  }
  return to;
}

export interface PreviewIo {
  writeFile: (path: string, contents: string) => void;
  mkdir: (path: string) => void;
  send: (template: EmailTemplateName, to: string, data: Record<string, unknown>) => Promise<EmailResult>;
  log: (line: string) => void;
}

/**
 * Run the preview. With `--send`, the allowlist is checked FIRST: a refused
 * send writes nothing and sends nothing. Returns the files written.
 */
export async function runEmailPreview(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: PreviewIo,
): Promise<{ written: string[]; sent: number }> {
  const args = parsePreviewArgs(argv);
  const to = args.send ? assertPreviewSendAllowed(args.to, env.EMAIL_PREVIEW_ALLOWED_TO) : null;
  if (!args.send && args.to) throw new Error("email-preview: --to is only meaningful with --send");
  if (!args.out) throw new Error("email-preview: --out <directory> is required");

  const out = args.out.replace(/\/+$/, "");
  io.mkdir(out);
  const written: string[] = [];
  let sent = 0;
  for (const c of filterPreviewCases(previewCases(), args.only)) {
    const rendered = getTemplate(c.template).render(c.data as never);
    if (!rendered.subject.startsWith("[PREVIEW]")) throw new Error("email-preview: preview subject must start with [PREVIEW]");
    if (!rendered.html) throw new Error(`email-preview: ${c.slug} has no HTML part (not on the design system)`);
    for (const [ext, body] of [["html", rendered.html], ["txt", rendered.text]] as const) {
      const file = `${out}/${c.slug}.${ext}`;
      io.writeFile(file, body);
      written.push(file);
    }
    if (to) {
      const res = await io.send(c.template, to, c.data);
      sent++;
      io.log(`sent ${c.slug}: ${res.status}`);
    }
  }
  io.log(`wrote ${written.length} files to ${out}`);
  return { written, sent };
}
