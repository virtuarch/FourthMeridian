/**
 * lib/email/templates/smoke.ts  (OPS-1 S1)
 *
 * The generic smoke template — the ONLY concrete template in the OPS-1 floor.
 *
 * It carries no product meaning. Its sole purpose is to prove the render →
 * sender-resolve → transport pipeline end to end without wiring any real flow
 * (password reset = Slice 2, verification = Slice 3, etc. are deliberately
 * un-built). Text-first, no HTML framework.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the smoke template renders from. */
export interface SmokeData {
  /** A short label echoed into the body — e.g. an environment or run id. */
  note?: string;
}

export const smokeTemplate: EmailTemplate<SmokeData> = {
  name: "smoke",
  sender: "smoke",
  render(data: SmokeData) {
    const note = data.note?.trim() ? ` (${data.note.trim()})` : "";
    return {
      subject: "Fourth Meridian email pipeline check",
      text:
        `This is an automated Fourth Meridian email-pipeline smoke check${note}.\n\n` +
        `If you received this, the transactional email path is working. ` +
        `No action is required.\n`,
    };
  },
};
