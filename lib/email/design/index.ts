/**
 * lib/email/design — the shared branded transactional-email design system.
 * Pure string renderers; no React, no email framework. See render.ts.
 */
export { renderEmail, renderSecurityEmail, type RenderEmailInput, type RenderedEmail, type SecurityEmailInput } from "@/lib/email/design/render";
export type { EmailBlock, FooterInput } from "@/lib/email/design/blocks";
export { WORDMARK } from "@/lib/email/design/blocks";
export { defaultEmailBrandConfig, resolveEmailSiteOrigin, PRODUCTION_SITE_ORIGIN, LEGAL_LINKS, LOGO_PATH, type EmailBrandConfig } from "@/lib/email/design/config";
export { escapeHtml, safeHttpUrl, cleanText } from "@/lib/email/design/escape";
export { wholeDaysBetween, daysPhrase, durationPhrase, formatUtcDateTimeLabelled } from "@/lib/email/design/datetime";
