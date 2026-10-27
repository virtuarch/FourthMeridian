/**
 * lib/platform/incidents/account-label.ts  (SEC-PLAT-3 — owner ruling P-4, 2026-10-27)
 *
 * PURE — how an operator surface names a customer's financial account.
 *
 *   LISTS (Platform Ops attention, Customer Success sync-issue preview, any
 *   multi-customer view): MINIMIZED — institution · account type · masked last
 *   digits, e.g. "Chase · Checking ••1234". The customer-chosen account NAME is
 *   never read for these surfaces (the reader does not select it).
 *
 *   AUTHORIZED, AUDITED DETAIL (the Customer Success customer profile, whose
 *   every open is recorded as CUSTOMER_PROFILE_VIEWED): the full label may add
 *   the account name.
 *
 * No balance, amount or account number beyond the provider's last-4 mask is
 * ever part of a label.
 */

export interface MinimizedAccountFacts {
  institution: string | null;
  /** Prisma AccountType: checking | savings | investment | crypto | debt | other. */
  type: string | null;
  /** The provider's last-4 mask (Plaid `mask`), or null. */
  mask: string | null;
}

const TYPE_WORD: Record<string, string> = {
  checking: "Checking", savings: "Savings", investment: "Investment",
  crypto: "Crypto", debt: "Debt", other: "Account",
};

/** "••1234" — only ever the last 4 characters of the mask, digits only. */
export function maskedDigits(mask: string | null): string | null {
  if (!mask) return null;
  const digits = mask.replace(/\D/g, "").slice(-4);
  return digits ? `••${digits}` : null;
}

/** The account half of a minimized label: "Checking ••1234". */
export function minimizedAccountPart(a: Pick<MinimizedAccountFacts, "type" | "mask">): string {
  const word = (a.type && TYPE_WORD[a.type]) || "Account";
  const m = maskedDigits(a.mask);
  return m ? `${word} ${m}` : word;
}

/** The full minimized label: "Chase · Checking ••1234". */
export function minimizedAccountLabel(a: MinimizedAccountFacts): string {
  const inst = a.institution?.trim();
  return inst ? `${inst} · ${minimizedAccountPart(a)}` : minimizedAccountPart(a);
}

/** AUDITED DETAIL ONLY — the minimized label plus the customer's own account name. */
export function detailAccountLabel(a: MinimizedAccountFacts & { name: string | null }): string {
  const base = minimizedAccountLabel(a);
  const name = a.name?.trim();
  return name ? `${name} (${base})` : base;
}
