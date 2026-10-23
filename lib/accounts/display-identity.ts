/**
 * lib/accounts/display-identity.ts   (v2.6-TRUTH-10)
 *
 * THE single answer to "what should this account be called?"
 *
 * Pure: no DB, no React, no clock, zero imports. It formats nothing beyond
 * choosing among names the account already carries.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * One Chase card rendered as "CREDIT CARD" on Cash Flow and "Ultimate Rewards®"
 * on the Credit page. Both were truthful — they are different columns on the
 * same row — and a user had no way to know they were one account.
 *
 *     name          "CREDIT CARD"        the provider's raw label
 *     plaidName     "CREDIT CARD"        captured once at import
 *     officialName  "Ultimate Rewards®"  the institution's own name for it
 *     displayName   null                 the user's override, unset here
 *
 * The resolution order was documented in `schema.prisma` and implemented FOUR
 * separate times inline — `lib/data/accounts.ts`, `lib/connections/space-data.ts`,
 * `lib/investments/space-data.ts`, `lib/data/transactions.ts` — plus a fifth,
 * DIVERGENT copy in the admin drawer that omitted `plaidName` entirely. And the
 * loader feeding the most surfaces, `loadSpaceAccounts`, never selected the
 * columns at all, so it could only ever emit the raw `name`.
 *
 * Five implementations and one omission is not an authority. This is.
 *
 * ── The four facts, kept separate ───────────────────────────────────────────
 *
 * Only `displayName` is the account's IDENTITY. The others are context a surface
 * may add — and must never substitute:
 *
 *   displayName      what to call the account            ← the identity
 *   institutionName  who holds it ("Chase")              context
 *   nickname         the user's override, when set       provenance
 *   mask             last 4 ("••0202")                   disambiguation
 *   type             checking | savings | debt | …       classification
 *
 * ⚠️ An institution is not an account. "Chase" names a bank that may hold five
 * accounts; substituting it as identity is the same error class as naming a
 * creditor from a payment descriptor (v2.6-TRUTH-9).
 */

/** The name-bearing columns an account carries. All optional but `name`. */
export interface AccountNameEvidence {
  /** The user's own override. Null until they rename the account. */
  displayName?: string | null;
  /** The institution's official name for the product. */
  officialName?: string | null;
  /** The provider's raw name, captured once at import and never resynced. */
  plaidName?: string | null;
  /** The stored fallback — covers manual and legacy accounts. */
  name: string;
}

export interface AccountDisplayIdentity {
  /** THE canonical identity. Every surface renders this and only this. */
  displayName: string;
  /** True when the user set the name themselves. */
  isUserNamed: boolean;
  /**
   * WHICH column answered. Recorded so a surface can never be wrong about where
   * its label came from, and so a probe can assert coverage.
   */
  basis: "USER_OVERRIDE" | "OFFICIAL_NAME" | "PROVIDER_NAME" | "STORED_NAME";
}

/**
 * Resolve an account's canonical display identity.
 *
 * Order: the user's override, then the institution's official name, then the
 * provider's raw name, then whatever is stored. Blank strings are treated as
 * absent — a user who clears a rename gets the next-best name, not an empty
 * label.
 */
export function resolveAccountIdentity(e: AccountNameEvidence): AccountDisplayIdentity {
  const pick = (v: string | null | undefined) => {
    const t = v?.trim();
    return t ? t : null;
  };
  const override = pick(e.displayName);
  if (override) return { displayName: override, isUserNamed: true, basis: "USER_OVERRIDE" };
  const official = pick(e.officialName);
  if (official) return { displayName: official, isUserNamed: false, basis: "OFFICIAL_NAME" };
  const provider = pick(e.plaidName);
  if (provider) return { displayName: provider, isUserNamed: false, basis: "PROVIDER_NAME" };
  return { displayName: pick(e.name) ?? "Account", isUserNamed: false, basis: "STORED_NAME" };
}

/**
 * The canonical display name — the one call almost every surface wants.
 *
 * ⚠️ THE ONLY sanctioned way to turn an account into a label. A surface that
 * needs the institution, the mask or the type reads those fields beside this
 * one; it never blends them into the identity itself.
 */
export function accountDisplayName(e: AccountNameEvidence): string {
  return resolveAccountIdentity(e).displayName;
}

/** The Prisma `select` every account read needs so it CAN resolve. Exported so a
 *  read cannot silently omit a column and quietly fall back to `name`. */
export const ACCOUNT_NAME_SELECT = {
  name: true, displayName: true, officialName: true, plaidName: true,
} as const;

/**
 * A mask, formatted for display beside a name. Never part of the identity.
 * Returns null when there is nothing to show, so a caller renders nothing rather
 * than an empty bullet run.
 */
export function formatAccountMask(mask: string | null | undefined): string | null {
  const t = mask?.trim();
  return t ? `••••${t}` : null;
}

/**
 * Order two accounts by the name a user actually SEES.
 *
 * ⚠️ The database cannot do this. `displayName` is resolved across four columns,
 * so `orderBy: { name: "asc" }` sorts on the STORED label — and an account whose
 * identity comes from `officialName` lands under the wrong letter. Live example:
 * a card stored as "CREDIT CARD" displays "Ultimate Rewards®" and sat fourth in
 * a seven-account list, between "Beacon Mortgage" and "Example CU Credit Card".
 *
 * Locale-aware, and tie-broken on `id` so the order is deterministic when two
 * accounts share a display name.
 *
 * ⚠️ SORTING ONLY. It must never be used to sum, and never on a paginated read:
 * re-ordering one page of a larger set produces a page that is sorted and a list
 * that is not. Every reader applying it loads its full set.
 */
export function compareAccountsByDisplayName(
  a: AccountNameEvidence & { id: string },
  b: AccountNameEvidence & { id: string },
): number {
  const byName = accountDisplayName(a).localeCompare(accountDisplayName(b), undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}
