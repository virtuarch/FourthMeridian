/**
 * lib/email/design/blocks.ts
 *
 * The reusable building blocks of every branded transactional email. Each block
 * has TWO renderers — one for the HTML part, one for the plain-text part — so
 * renderEmail() (render.ts) can produce both parts from the SAME block list and
 * they never drift.
 *
 * Email-client rules followed throughout:
 *   - table layout with role="presentation", inline styles on every element;
 *   - colours are also given as `bgcolor` attributes for clients that drop CSS;
 *   - the `fm-*` classes exist only so the dark-mode <style> block can override
 *     the inline light colours (with !important) in clients that honour
 *     prefers-color-scheme;
 *   - text always sits on an opaque background, so an auto-inverting client
 *     never ends up with light text on a transparent field.
 *
 * Every interpolated value goes through escapeHtml(); every URL through
 * safeHttpUrl(). Pure: no I/O.
 */

import { escapeHtml, safeHttpUrl } from "@/lib/email/design/escape";
import { FONT_STACK, LIGHT } from "@/lib/email/design/tokens";
import { LEGAL_LINKS, LOGO_PATH, type EmailBrandConfig } from "@/lib/email/design/config";

/** The brand name — always real text, never only an image. */
export const WORDMARK = "Fourth Meridian";

// ── Block model ──────────────────────────────────────────────────────────────

export type EmailBlock =
  | { kind: "hero"; heading: string; greeting?: string }
  | { kind: "paragraph"; text: string }
  | { kind: "cta"; label: string; url: string }
  | { kind: "info"; title?: string; items: string[]; ordered?: boolean }
  | { kind: "expiry"; headline: string; detail?: string }
  | { kind: "security"; text: string }
  | { kind: "divider" };

export interface FooterInput {
  /** One sentence: why this recipient got this email. Supplied by each template. */
  reason: string;
}

const P_STYLE = `margin:0 0 16px 0;font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${LIGHT.text};`;

// ── HTML blocks ──────────────────────────────────────────────────────────────

/** Hidden preview text shown by inbox lists, padded so body copy does not bleed in. */
export function preheaderHtml(preheader: string): string {
  const pad = "&#8199;&#847;".repeat(60);
  return (
    `<div class="fm-preheader" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;` +
    `opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}${pad}</div>`
  );
}

/** Logo (small, hosted) + the wordmark as real text, then the thin brass rule. */
export function headerHtml(brand: EmailBrandConfig): string {
  const logoUrl = safeHttpUrl(`${brand.siteOrigin}${LOGO_PATH}`);
  return (
    `<tr><td class="fm-card fm-pad" bgcolor="${LIGHT.card}" style="background-color:${LIGHT.card};padding:28px 40px 20px 40px;border-radius:12px 12px 0 0;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="padding:0 12px 0 0;">` +
    `<img src="${escapeHtml(logoUrl)}" width="32" height="32" alt="${escapeHtml(WORDMARK)}" ` +
    `style="display:block;width:32px;height:32px;border:0;border-radius:7px;" /></td>` +
    `<td valign="middle" class="fm-heading" style="font-family:${FONT_STACK};font-size:18px;line-height:24px;font-weight:600;letter-spacing:0.2px;color:${LIGHT.heading};">` +
    `${escapeHtml(WORDMARK)}</td>` +
    `</tr></table></td></tr>` +
    // The single brass accent: a 2 px rule. Purely decorative, carries no text.
    `<tr><td class="fm-card fm-pad" bgcolor="${LIGHT.card}" style="background-color:${LIGHT.card};padding:0 40px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="fm-accent" height="2" bgcolor="${LIGHT.accent}" style="height:2px;line-height:2px;font-size:0;background-color:${LIGHT.accent};">&nbsp;</td>` +
    `</tr></table></td></tr>`
  );
}

export function heroHtml(b: Extract<EmailBlock, { kind: "hero" }>): string {
  return (
    `<h1 class="fm-heading" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:24px;line-height:32px;font-weight:700;color:${LIGHT.heading};">` +
    `${escapeHtml(b.heading)}</h1>` +
    (b.greeting ? `<p class="fm-text" style="${P_STYLE}">${escapeHtml(b.greeting)}</p>` : "")
  );
}

export function paragraphHtml(b: Extract<EmailBlock, { kind: "paragraph" }>): string {
  return `<p class="fm-text" style="${P_STYLE}">${escapeHtml(b.text)}</p>`;
}

/**
 * Bulletproof button: a table cell carries the fill (so Outlook paints it from
 * `bgcolor`), the link carries the padding, and the URL is ALSO printed below
 * as text so the email works even when the button does not render.
 */
export function ctaHtml(b: Extract<EmailBlock, { kind: "cta" }>): string {
  const href = escapeHtml(safeHttpUrl(b.url));
  const label = escapeHtml(b.label);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="fm-cta" style="margin:8px 0 16px 0;"><tr>` +
    `<td align="center" bgcolor="${LIGHT.ctaBg}" style="border-radius:8px;background-color:${LIGHT.ctaBg};">` +
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-family:${FONT_STACK};` +
    `font-size:16px;line-height:20px;font-weight:600;color:${LIGHT.ctaText};text-decoration:none;border-radius:8px;` +
    `border:1px solid ${LIGHT.ctaBg};background-color:${LIGHT.ctaBg};">${label}</a>` +
    `</td></tr></table>` +
    `<p class="fm-muted" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${LIGHT.muted};">` +
    `If the button doesn't work, copy and paste this link into your browser:<br />` +
    `<a href="${href}" target="_blank" rel="noopener" class="fm-link" style="color:${LIGHT.link};text-decoration:underline;word-break:break-all;">${href}</a></p>`
  );
}

/** An opaque tinted panel with a 3 px left edge in `edge` colour. */
function panel(inner: string, edge: string, edgeClass: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr>` +
    `<td class="fm-panel ${edgeClass}" bgcolor="${LIGHT.panel}" style="background-color:${LIGHT.panel};border-left:3px solid ${edge};` +
    `border-radius:6px;padding:14px 16px;">${inner}</td></tr></table>`
  );
}

export function infoHtml(b: Extract<EmailBlock, { kind: "info" }>): string {
  const title = b.title
    ? `<p class="fm-heading" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;font-weight:600;color:${LIGHT.heading};">${escapeHtml(b.title)}</p>`
    : "";
  const rows = b.items
    .map(
      (item, i) =>
        `<tr><td valign="top" class="fm-text" style="padding:0 8px 6px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${LIGHT.text};">` +
        `${b.ordered ? `${i + 1}.` : "&bull;"}</td>` +
        `<td valign="top" class="fm-text" style="padding:0 0 6px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${LIGHT.text};">${escapeHtml(item)}</td></tr>`,
    )
    .join("");
  return panel(`${title}<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>`, LIGHT.border, "fm-edge");
}

export function expiryHtml(b: Extract<EmailBlock, { kind: "expiry" }>): string {
  const inner =
    `<p class="fm-heading" style="margin:0;font-family:${FONT_STACK};font-size:15px;line-height:22px;font-weight:600;color:${LIGHT.heading};">${escapeHtml(b.headline)}</p>` +
    (b.detail
      ? `<p class="fm-text" style="margin:4px 0 0 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${LIGHT.text};">${escapeHtml(b.detail)}</p>`
      : "");
  return panel(inner, LIGHT.accent, "fm-accent-edge");
}

export function securityHtml(b: Extract<EmailBlock, { kind: "security" }>): string {
  const inner = `<p class="fm-text" style="margin:0;font-family:${FONT_STACK};font-size:14px;line-height:21px;color:${LIGHT.text};">${escapeHtml(b.text)}</p>`;
  return panel(inner, LIGHT.muted, "fm-edge-muted");
}

export function dividerHtml(): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr>` +
    `<td class="fm-rule" height="1" bgcolor="${LIGHT.border}" style="height:1px;line-height:1px;font-size:0;background-color:${LIGHT.border};">&nbsp;</td>` +
    `</tr></table>`
  );
}

export function blockHtml(b: EmailBlock): string {
  switch (b.kind) {
    case "hero":      return heroHtml(b);
    case "paragraph": return paragraphHtml(b);
    case "cta":       return ctaHtml(b);
    case "info":      return infoHtml(b);
    case "expiry":    return expiryHtml(b);
    case "security":  return securityHtml(b);
    case "divider":   return dividerHtml();
  }
}

/** Footer: the template's reason line, the support contact (if any), legal links. */
export function footerHtml(footer: FooterInput, brand: EmailBrandConfig): string {
  const small = `font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${LIGHT.muted};`;
  const links = LEGAL_LINKS.map((l) => {
    const href = escapeHtml(safeHttpUrl(`${brand.siteOrigin}${l.path}`));
    return `<a href="${href}" target="_blank" rel="noopener" class="fm-muted" style="color:${LIGHT.muted};text-decoration:underline;">${escapeHtml(l.label)}</a>`;
  }).join(`<span class="fm-muted" style="color:${LIGHT.muted};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`);
  const support = brand.supportEmail
    ? `<p class="fm-muted" style="margin:0 0 8px 0;${small}">Questions? Contact ` +
      `<a href="mailto:${escapeHtml(brand.supportEmail)}" class="fm-muted" style="color:${LIGHT.muted};text-decoration:underline;">${escapeHtml(brand.supportEmail)}</a>.</p>`
    : "";
  return (
    `<tr><td class="fm-canvas fm-pad" bgcolor="${LIGHT.canvas}" style="background-color:${LIGHT.canvas};padding:24px 40px 8px 40px;">` +
    `<p class="fm-muted" style="margin:0 0 8px 0;${small}">${escapeHtml(footer.reason)}</p>` +
    support +
    `<p class="fm-muted" style="margin:0 0 8px 0;${small}">${links}</p>` +
    `<p class="fm-muted" style="margin:0;${small}">&copy; ${escapeHtml(WORDMARK)}</p>` +
    `</td></tr>`
  );
}

// ── Plain-text blocks ────────────────────────────────────────────────────────

export function blockText(b: EmailBlock): string {
  switch (b.kind) {
    case "hero":      return b.greeting ? `${b.heading}\n\n${b.greeting}` : b.heading;
    case "paragraph": return b.text;
    case "cta":       return `${b.label}:\n${safeHttpUrl(b.url)}`;
    case "info": {
      const items = b.items.map((item, i) => `${b.ordered ? `${i + 1}.` : "-"} ${item}`).join("\n");
      return b.title ? `${b.title}\n${items}` : items;
    }
    case "expiry":    return b.detail ? `${b.headline}\n${b.detail}` : b.headline;
    case "security":  return b.text;
    case "divider":   return "----";
  }
}

export function footerText(footer: FooterInput, brand: EmailBrandConfig): string {
  const lines = [footer.reason];
  if (brand.supportEmail) lines.push(`Questions? Contact ${brand.supportEmail}.`);
  for (const l of LEGAL_LINKS) lines.push(`${l.label}: ${safeHttpUrl(`${brand.siteOrigin}${l.path}`)}`);
  return `--\n${lines.join("\n")}`;
}
