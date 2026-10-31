/**
 * lib/email/design/render.ts
 *
 * renderEmail(): ONE block list in, `{ subject, html, text }` out. The HTML and
 * the plain-text parts are both generated from the same blocks (blocks.ts), so
 * the copy, the CTA URL and the expiry can never say different things in the
 * two parts.
 *
 * The layout shell:
 *   - <meta name="color-scheme" content="light dark"> + supported-color-schemes;
 *   - a hidden preheader;
 *   - a centred single column, max-width 600 (a fixed 600 px ghost table for
 *     Outlook desktop, which ignores max-width), full width on small screens;
 *   - header (logo + text wordmark + brass rule) and body in one opaque card;
 *   - footer (reason, support contact, legal links) on the canvas;
 *   - a `prefers-color-scheme: dark` block (plus Outlook.com's [data-ogsc]
 *     hooks) that swaps every surface and text colour to the dark palette.
 *
 * Pure: no I/O. The brand config (site origin, support address) is injected;
 * real sends use defaultEmailBrandConfig().
 */

import {
  blockHtml,
  blockText,
  footerHtml,
  footerText,
  headerHtml,
  preheaderHtml,
  WORDMARK,
  type EmailBlock,
  type FooterInput,
} from "@/lib/email/design/blocks";
import { defaultEmailBrandConfig, type EmailBrandConfig } from "@/lib/email/design/config";
import { escapeHtml } from "@/lib/email/design/escape";
import { DARK, FONT_STACK, LIGHT } from "@/lib/email/design/tokens";

export interface RenderEmailInput {
  subject: string;
  /** Inbox preview text (hidden in the body). */
  preheader: string;
  blocks: EmailBlock[];
  footer: FooterInput;
  /**
   * "security": an account-security notice. It must carry a `security` block and
   * may carry only hero / paragraph / security / cta / divider blocks — no info
   * panels or anything promotional.
   */
  variant?: "standard" | "security";
  /** Defaults to defaultEmailBrandConfig() (env-derived site origin + support). */
  brand?: EmailBrandConfig;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const SECURITY_ALLOWED = new Set<EmailBlock["kind"]>(["hero", "paragraph", "security", "cta", "divider"]);

function darkModeCss(): string {
  // Each rule overrides an inline light colour, hence !important.
  const rules = (prefix: string) =>
    [
      `${prefix}.fm-canvas{background-color:${DARK.canvas} !important;}`,
      `${prefix}.fm-card{background-color:${DARK.card} !important;}`,
      `${prefix}.fm-heading{color:${DARK.heading} !important;}`,
      `${prefix}.fm-text{color:${DARK.text} !important;}`,
      `${prefix}.fm-muted{color:${DARK.muted} !important;}`,
      `${prefix}.fm-link{color:${DARK.link} !important;}`,
      `${prefix}.fm-panel{background-color:${DARK.panel} !important;}`,
      `${prefix}.fm-edge{border-left-color:${DARK.border} !important;}`,
      `${prefix}.fm-edge-muted{border-left-color:${DARK.muted} !important;}`,
      `${prefix}.fm-accent-edge{border-left-color:${DARK.accent} !important;}`,
      `${prefix}.fm-accent{background-color:${DARK.accent} !important;}`,
      `${prefix}.fm-rule{background-color:${DARK.border} !important;}`,
    ].join("\n");
  return (
    `@media (prefers-color-scheme: dark) {\n${rules("")}\n}\n` +
    // Outlook.com marks its dark-mode render with data-ogsc / data-ogsb.
    `${rules("[data-ogsc] ")}\n`
  );
}

function shell(subject: string, preheader: string, card: string, footer: string, header: string): string {
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">\n` +
    `<head>\n` +
    `<meta charset="utf-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge" />\n` +
    `<meta name="x-apple-disable-message-reformatting" />\n` +
    `<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no" />\n` +
    `<meta name="color-scheme" content="light dark" />\n` +
    `<meta name="supported-color-schemes" content="light dark" />\n` +
    `<title>${escapeHtml(subject)}</title>\n` +
    `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->\n` +
    `<style>\n` +
    `:root{color-scheme:light dark;supported-color-schemes:light dark;}\n` +
    `body{margin:0 !important;padding:0 !important;width:100% !important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}\n` +
    `table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}\n` +
    `img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}\n` +
    `@media only screen and (max-width:620px){\n` +
    `.fm-container{width:100% !important;}\n` +
    `.fm-pad{padding-left:24px !important;padding-right:24px !important;}\n` +
    `}\n` +
    darkModeCss() +
    `</style>\n` +
    `</head>\n` +
    `<body class="fm-canvas" style="margin:0;padding:0;background-color:${LIGHT.canvas};font-family:${FONT_STACK};">\n` +
    preheaderHtml(preheader) +
    `\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fm-canvas" bgcolor="${LIGHT.canvas}" style="background-color:${LIGHT.canvas};">` +
    `<tr><td align="center" style="padding:24px 12px;">\n` +
    `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->\n` +
    `<table role="presentation" class="fm-container" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">\n` +
    header +
    `\n<tr><td class="fm-card fm-pad" bgcolor="${LIGHT.card}" style="background-color:${LIGHT.card};padding:28px 40px 16px 40px;border-radius:0 0 12px 12px;">\n` +
    card +
    `\n</td></tr>\n` +
    footer +
    `\n</table>\n` +
    `<!--[if mso]></td></tr></table><![endif]-->\n` +
    `</td></tr></table>\n` +
    `</body>\n</html>\n`
  );
}

/** Render one email's HTML and plain-text parts from a single block list. */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const brand = input.brand ?? defaultEmailBrandConfig();
  const variant = input.variant ?? "standard";

  if (variant === "security") {
    const stray = input.blocks.find((b) => !SECURITY_ALLOWED.has(b.kind));
    if (stray) throw new Error(`email: a security email may not carry a "${stray.kind}" block`);
    if (!input.blocks.some((b) => b.kind === "security")) {
      throw new Error("email: a security email must carry a security notice block");
    }
  }

  const html = shell(
    input.subject,
    input.preheader,
    input.blocks.map(blockHtml).join("\n"),
    footerHtml(input.footer, brand),
    headerHtml(brand),
  );

  const text =
    [WORDMARK, ...input.blocks.map(blockText), footerText(input.footer, brand)].join("\n\n") + "\n";

  return { subject: input.subject, html, text };
}

export interface SecurityEmailInput {
  subject: string;
  preheader: string;
  heading: string;
  greeting?: string;
  /** The security notice itself. */
  notice: string;
  /** Optional single action (e.g. "Reset your password"). */
  action?: { label: string; url: string };
  reason: string;
  brand?: EmailBrandConfig;
}

/** The security-email variant: heading, the notice, an optional action. Nothing else. */
export function renderSecurityEmail(input: SecurityEmailInput): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: "hero", heading: input.heading, ...(input.greeting ? { greeting: input.greeting } : {}) },
    { kind: "security", text: input.notice },
    ...(input.action ? [{ kind: "cta" as const, label: input.action.label, url: input.action.url }] : []),
  ];
  return renderEmail({
    subject: input.subject,
    preheader: input.preheader,
    blocks,
    footer: { reason: input.reason },
    variant: "security",
    ...(input.brand ? { brand: input.brand } : {}),
  });
}
