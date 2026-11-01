/**
 * lib/email/templates/smoke.ts  (OPS-1 S1 → email design system)
 *
 * The generic smoke template. It carries no product meaning: its sole purpose
 * is to prove the render → sender-resolve → transport pipeline end to end. No
 * production caller sends it (grep).
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { cleanText } from "@/lib/email/design/escape";

/** Data the smoke template renders from. */
export interface SmokeData {
  /** A short label echoed into the body — e.g. an environment or run id. */
  note?: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export function renderSmoke(data: SmokeData, opts: { brand?: EmailBrandConfig } = {}): RenderedEmail {
  const note = data.note?.trim() ? ` (${cleanText(data.note)})` : "";
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}Fourth Meridian email pipeline check`,
    preheader: "Automated email-pipeline smoke check. No action is required.",
    blocks: [
      { kind: "hero", heading: "Email pipeline check" },
      { kind: "paragraph", text: `This is an automated Fourth Meridian email-pipeline smoke check${note}.` },
      { kind: "paragraph", text: "If you received this, the transactional email path is working. No action is required." },
    ],
    footer: { reason: "Internal Fourth Meridian operations email: an email-pipeline smoke check." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const smokeTemplate: EmailTemplate<SmokeData> = {
  name: "smoke",
  sender: "smoke",
  render(data: SmokeData) {
    return renderSmoke(data);
  },
};
