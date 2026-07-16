/**
 * lib/email/senders.ts  (OPS-1 S0)
 *
 * The sender identity map — the single source of truth for the From/Reply-To
 * a given transactional purpose sends as. Producers never hard-code a From;
 * they name a purpose and the chokepoint resolves it here.
 *
 * These identities match the verified Google Workspace / Resend sending
 * conventions for fourthmeridian.com. SPF/DKIM/DMARC are already authenticated
 * on the domain and the `send` subdomain, so these From addresses are
 * deliverable once a real caller is wired in a later slice.
 *
 * The full purpose set is declared now for review stability; OPS-1 S1 only
 * exercises `smoke`. No purpose here implies a shipped email flow — wiring is
 * the job of later slices (reset = Slice 2, verification = Slice 3, etc.).
 */

import type { SenderPurpose } from "@/lib/email/types";

/** A resolved sender identity: the header values a message ships with. */
export interface SenderIdentity {
  /** Fully-formed From header, e.g. `Fourth Meridian <support@fourthmeridian.com>`. */
  from: string;
  /** Optional Reply-To header. */
  replyTo?: string;
}

/**
 * purpose -> identity. Kept as a plain const record (like lib/providers/plaid's
 * thin adapter object) rather than a class or factory — no logic to hide.
 */
export const SENDER_IDENTITIES: Record<SenderPurpose, SenderIdentity> = {
  // Generic smoke/self-test sender (OPS-1 S1). Uses support@ — the operational
  // catch-all identity — but carries no product meaning.
  "smoke":                { from: "Fourth Meridian <support@fourthmeridian.com>" },

  // Security & account lifecycle → support@ (Slices 2/3, not wired yet).
  "password-reset":       { from: "Fourth Meridian <support@fourthmeridian.com>" },
  "email-verification":   { from: "Fourth Meridian <support@fourthmeridian.com>" },
  "space-invite":         { from: "Fourth Meridian <support@fourthmeridian.com>" },
  "security-alert":       { from: "Fourth Meridian <support@fourthmeridian.com>" },

  // Product notifications (Daily Brief etc.) → notifications@.
  "product-notification": { from: "Fourth Meridian <notifications@fourthmeridian.com>" },

  // Beta program → beta@.
  "beta-invite":          { from: "Fourth Meridian Beta <beta@fourthmeridian.com>" },

  // Platform Operations alerts (OPS-5 S5) → support@, the operational catch-all
  // (same identity smoke/self-test uses). Operator-facing, not account-holder.
  "platform-ops":         { from: "Fourth Meridian <support@fourthmeridian.com>" },
};

/** Resolve the sender identity for a purpose. */
export function resolveSender(purpose: SenderPurpose): SenderIdentity {
  return SENDER_IDENTITIES[purpose];
}
