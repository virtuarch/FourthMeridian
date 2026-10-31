/**
 * lib/email/preview.ts
 *
 * The logic behind scripts/email-preview.ts: render every design-system email
 * template with SYNTHETIC data to .html + .txt files, and — only on an explicit
 * `--send --to <addr>` whose address EXACTLY equals the local-only env var
 * EMAIL_PREVIEW_ALLOWED_TO — send them through the real sendEmail().
 *
 * Safety:
 *   - The invite URL carries the literal token `preview-not-redeemable`. It is
 *     not hex, is never hashed or stored, so no invite row can ever match it.
 *   - Every preview subject starts with "[PREVIEW]".
 *   - The recipient allowlist is an env var that is never committed; with it
 *     unset, or with any other address, a send is refused before anything is
 *     rendered or sent. This repo is public: no real address lives in it.
 *   - Nothing here touches the database. Rendering touches no network.
 *
 * I/O (file writes, the send) is injected so the refusal is unit-testable.
 */

import { renderBetaInvite, type BetaInviteData } from "@/lib/email/templates/beta-invite";
import { buildBetaInviteUrl } from "@/lib/email/beta-invite-url";
import type { EmailResult, EmailTemplateName } from "@/lib/email/types";

/** The token every preview link carries. Deliberately not a 64-char hex token. */
export const PREVIEW_TOKEN = "preview-not-redeemable";

/** Preview links use the Production app origin shape with the non-redeemable token. */
export const PREVIEW_APP_BASE = "https://app.fourthmeridian.com";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fixed synthetic issue time, so preview output is deterministic. */
const PREVIEW_ISSUED_AT = new Date("2026-10-31T15:04:00.000Z");

export interface PreviewCase {
  /** File stem, e.g. "beta-invite--named--14d". */
  slug: string;
  template: EmailTemplateName;
  data: BetaInviteData;
}

/** Every template built on the design system, in a few variants each (both invite origins). */
export function previewCases(): PreviewCase[] {
  const inviteUrl = buildBetaInviteUrl(PREVIEW_APP_BASE, PREVIEW_TOKEN);
  const cases: PreviewCase[] = [];
  for (const origin of ["request", "direct"] as const) {
    for (const days of [1, 7, 14, 30]) {
      for (const named of [false, true]) {
        cases.push({
          slug: `beta-invite--${origin}--${named ? "named" : "unnamed"}--${days}d`,
          template: "beta-invite",
          data: {
            origin,
            recipientName: named ? "Alex Example" : null,
            inviteUrl,
            issuedAt: PREVIEW_ISSUED_AT,
            expiresAt: new Date(PREVIEW_ISSUED_AT.getTime() + days * DAY_MS),
            preview: true,
          },
        });
      }
    }
  }
  return cases;
}

export interface PreviewArgs {
  out: string | null;
  send: boolean;
  to: string | null;
}

export function parsePreviewArgs(argv: readonly string[]): PreviewArgs {
  const args: PreviewArgs = { out: null, send: false, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i] ?? null;
    else if (a === "--send") args.send = true;
    else if (a === "--to") args.to = argv[++i] ?? null;
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
  for (const c of previewCases()) {
    const rendered = renderBetaInvite(c.data);
    if (!rendered.subject.startsWith("[PREVIEW]")) throw new Error("email-preview: preview subject must start with [PREVIEW]");
    for (const [ext, body] of [["html", rendered.html], ["txt", rendered.text]] as const) {
      const file = `${out}/${c.slug}.${ext}`;
      io.writeFile(file, body);
      written.push(file);
    }
    if (to) {
      const res = await io.send(c.template, to, c.data as unknown as Record<string, unknown>);
      sent++;
      io.log(`sent ${c.slug}: ${res.status}`);
    }
  }
  io.log(`wrote ${written.length} files to ${out}`);
  return { written, sent };
}
