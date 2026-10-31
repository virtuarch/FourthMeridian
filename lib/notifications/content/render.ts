/**
 * lib/notifications/content/render.ts  (Comms Center B1 — substitution and rendering, contract v1.1 §2.4, §5)
 *
 * PURE. Operator content renders inside the LOCKED FRAME: the email goes
 * through the generic `notification` template (lib/email/templates/notification.ts)
 * — the design-system shell, header/logo, footer reason, preference link,
 * support contact and legal links all stay code. Operators edit ContentBody only.
 *
 * SUBSTITUTION (§2.4), on plain strings, before rendering:
 *   1. resolve each value from its source (the render data, or the trusted app
 *      base + the registry href for a LINK — never a request);
 *   2. cleanText(value, maxLength): controls, newlines and bidi stripped, capped;
 *   3. a missing / empty value takes the fallback;
 *   4. ONE pass of {{name}} replacement: a value that itself contains "{{" is
 *      inserted literally and never re-expanded;
 *   5. LINK values pass safeHttpUrl (email) — operator text never supplies a URL.
 * The design-system renderer then escapes every string and URL (escapeHtml /
 * safeHttpUrl), so a value such as `<b>` or `"><script>` renders as text.
 */

import { cleanText, safeHttpUrl } from "@/lib/email/design/escape";
import type { EmailBlock } from "@/lib/email/design/blocks";
import { buildActionUrl } from "@/lib/notifications/channels/email-data";
import { renderNotificationEmail, type NotificationEmailContent } from "@/lib/email/templates/notification";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";
import { APP_PATHS } from "@/lib/email/app-link";
import type { NotificationCategory, RenderedNotification } from "@/lib/notifications/types";
import type { ContentBlock, ContentBody } from "./types";
import { LIMITS, type LegSpec } from "./legs";

const TOKEN = /\{\{([a-z][A-Za-z0-9]{0,31})\}\}/g;

export type Values = Readonly<Record<string, string>>;

/** One pass, no nesting: every {{name}} with a value is replaced; the replacement is never re-scanned. */
export function substitute(text: string, values: Values): string {
  return text.replace(TOKEN, (m, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m));
}

/**
 * The TEXT values for a send (from untrusted render data) or a preview ("SAMPLE").
 * Never returns an empty or "undefined" value.
 */
export function textValues(spec: LegSpec, data: Readonly<Record<string, unknown>> | "SAMPLE"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of spec.placeholders) {
    if (p.kind !== "TEXT") continue;
    if (data === "SAMPLE") { out[p.name] = cleanText(p.sample, p.maxLength) || p.fallback; continue; }
    const raw = p.source.from === "PAYLOAD" ? data[p.source.field] : undefined;
    const s = typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
    // Braces are removed from VALUES so no send can ever carry a literal "{{…}}" (review P3).
    out[p.name] = cleanText(s.replace(/[{}]/g, ""), p.maxLength) || p.fallback;
  }
  return out;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() : s);

/** The substituted subject / preheader (single line, capped again after substitution). */
function line(s: string, values: Values, max: number): string {
  return cap(cleanText(substitute(s, values), max * 2), max);
}

/** Text of a block field after substitution (paragraphs keep their line breaks). */
const sub = (s: string, values: Values) => substitute(s, values);

/**
 * The email content for the `notification` template: substituted, every CTA's
 * URL resolved from the trusted app base + the registry href. Throws when a URL
 * cannot be resolved (no app base, unsafe URL) — the caller falls back to the
 * code default (§5.2: content is optional, delivery is not).
 */
export function emailContent(spec: LegSpec, body: ContentBody, values: Values, variant: string, appBaseUrl: string | undefined): NotificationEmailContent {
  const href = spec.hrefFor(variant);
  const blocks: EmailBlock[] = body.blocks.map((b: ContentBlock): EmailBlock => {
    switch (b.kind) {
      case "hero": return { kind: "hero", heading: sub(b.heading, values), ...(b.greeting !== undefined ? { greeting: sub(b.greeting, values) } : {}) };
      case "paragraph": return { kind: "paragraph", text: sub(b.text, values) };
      case "info": return { kind: "info", items: b.items.map((i) => sub(i, values)), ...(b.title !== undefined ? { title: sub(b.title, values) } : {}), ...(b.ordered !== undefined ? { ordered: b.ordered } : {}) };
      case "divider": return { kind: "divider" };
      case "cta": {
        if (b.link !== "actionUrl" || href === null) throw new Error("content: the button names no resolvable link");
        const url = buildActionUrl(appBaseUrl, href);
        if (!url) throw new Error("content: no trusted app base for the button link");
        return { kind: "cta", label: sub(b.label, values), url: safeHttpUrl(url) };
      }
    }
  });
  return {
    subject: line(body.subject, values, LIMITS.EMAIL.subject),
    preheader: line(body.preheader ?? body.subject, values, LIMITS.EMAIL.preheader),
    blocks,
  };
}

/** Render an email from content through the locked frame (the `notification` template). */
export function renderContentEmail(args: {
  spec: LegSpec; body: ContentBody; values: Values; variant: string; appBaseUrl: string; category: NotificationCategory; preview: boolean;
}) {
  const content = emailContent(args.spec, args.body, args.values, args.variant, args.appBaseUrl);
  const preferencesUrl = buildActionUrl(args.appBaseUrl, APP_PATHS.notificationSettings);
  return renderNotificationEmail({
    title: content.subject,
    category: args.category,
    ...(preferencesUrl ? { preferencesUrl } : {}),
    ...(args.preview ? { preview: true } : {}),
    content,
  });
}

/**
 * The in-app render from content (§5.3): subject → title, the paragraph → body,
 * the cta label → actionLabel. href / icon / category / priority / dedupe stay
 * the registry's.
 */
export function inAppRender(spec: LegSpec, body: ContentBody, values: Values, variant: string): RenderedNotification {
  const href = spec.hrefFor(variant);
  const para = body.blocks.find((b): b is Extract<ContentBlock, { kind: "paragraph" }> => b.kind === "paragraph");
  const cta = body.blocks.find((b): b is Extract<ContentBlock, { kind: "cta" }> => b.kind === "cta");
  const bodyText = para ? cap(sub(para.text, values), LIMITS.IN_APP.paragraph * 2) : "";
  return {
    title: line(body.subject, values, LIMITS.IN_APP.subject),
    ...(bodyText ? { body: bodyText } : {}),
    ...(href ? { href } : {}),
    ...(cta && href ? { actionLabel: cap(cleanText(sub(cta.label, values), LIMITS.IN_APP.ctaLabel * 2), LIMITS.IN_APP.ctaLabel * 2) } : {}),
  };
}

/** The registry icon of a leg (preview DTO). */
export const iconOf = (spec: LegSpec) => NOTIFICATION_REGISTRY[spec.key].icon;
