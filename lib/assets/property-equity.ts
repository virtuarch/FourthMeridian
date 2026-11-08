/**
 * lib/assets/property-equity.ts
 *
 * Mortgage F9 — owner decision 2026-11-08 (HOME VALUATION):
 *
 *   "Store property market value and outstanding mortgage balance separately.
 *    Calculate equity as market value minus associated secured debt. Prevent
 *    double counting, including when a user previously entered an equity figure
 *    instead of market value. Handle existing records conservatively without
 *    silently rewriting them." + "Preserve … collateral relationships where
 *    known. Mortgage-specific equity … must not be applied to unrelated loans."
 *
 * The ONE answer to "what is this property's equity, and might its value be
 * double counting its mortgage?". Pure: no DB, no server-only imports (the
 * property panel and the AI assembler both import it).
 *
 * ── Net worth is NOT computed here and NOT changed by F9 ─────────────────────
 * The property counts in net worth at its recorded value and each debt counts as
 * a liability — exactly as before. Equity is a DERIVED DISPLAY: value − Σ linked
 * secured debt. It is never added on top of net worth (that would count the same
 * home twice), and nothing here ever excludes or restates a balance.
 *
 * ── Which debts can reduce equity ────────────────────────────────────────────
 * Only a debt the USER linked to this property AND whose debtType (PR #485) is
 * mortgage or HELOC. An auto, student, personal or card balance never reduces
 * equity, linked or not.
 *
 * ── Double-count guard: a PROMPT, never a rewrite ────────────────────────────
 *   · EQUITY_ENTERED + a linked secured debt ⇒ the value is already net of the
 *     mortgage while the mortgage also counts as a liability: net worth may be
 *     understated by up to the linked debt. Flagged; equity is withheld (value −
 *     debt would subtract the mortgage a second time).
 *   · UNKNOWN basis (every pre-F9 record) + a linked secured debt + a value below
 *     UNKNOWN_BASIS_PROMPT_RATIO × the linked debt ⇒ the same prompt (heuristic:
 *     an equity figure is usually smaller than the mortgage it nets out; an
 *     underwater home also trips it, which only costs one confirmation).
 *   · MARKET_VALUE ⇒ the user said so; never flagged.
 * In every case the user answers with "this is market value / this is equity";
 * the app excludes nothing automatically.
 */

import { debtType, DEBT_TYPE_LABEL, type DebtType, type LiabilityKindInput } from "@/lib/debt/liability-kind";

export const PROPERTY_VALUE_BASES = ["MARKET_VALUE", "EQUITY_ENTERED", "UNKNOWN"] as const;
export type PropertyValueBasis = (typeof PROPERTY_VALUE_BASES)[number];

export function isPropertyValueBasis(v: unknown): v is PropertyValueBasis {
  return typeof v === "string" && (PROPERTY_VALUE_BASES as readonly string[]).includes(v);
}

/** The asset kinds the manual-asset route accepts (app/api/accounts/manual/route.ts). */
export const MANUAL_ASSET_KINDS = ["real_estate", "vehicle", "equipment", "other"] as const;
export type ManualAssetKind = (typeof MANUAL_ASSET_KINDS)[number];

/** A secured debt can be linked to an asset whose kind is real estate or was never recorded. */
export function canCarrySecuredDebt(assetKind: string | null | undefined): boolean {
  return assetKind == null || assetKind === "real_estate";
}

/** UNKNOWN basis: prompt when value < this × linked secured debt. */
export const UNKNOWN_BASIS_PROMPT_RATIO = 1.1;

// ─────────────────────────────────────────────────────────────────────────────
// Secured-by-property debt kinds
// ─────────────────────────────────────────────────────────────────────────────

export type SecuredDebtKind = Extract<DebtType, "mortgage" | "heloc">;

/** The debt types secured by a property (PR #485's classifier output). */
export const PROPERTY_SECURED_DEBT_TYPES: ReadonlySet<DebtType> = new Set<DebtType>(["mortgage", "heloc"]);

export type SecuredDebtEvidence = LiabilityKindInput;

/**
 * The property-secured kind of a liability, or null when it is not secured by a
 * property. Decided ONLY by the one debt classifier (lib/debt/liability-kind.ts
 * `debtType`, PR #485): mortgage or HELOC. Everything else — auto, student,
 * personal, card, line of credit, overdraft, a closed-end home-equity loan
 * (`other_installment` per #485: no mortgage behaviour), unknown — is null, so
 * it can neither be linked nor reduce equity. An explicit FM debtSubtype wins
 * over the provider's subtype (debtType's evidence order).
 */
export function securedDebtKind(a: SecuredDebtEvidence): SecuredDebtKind | null {
  const t = debtType(a);
  return PROPERTY_SECURED_DEBT_TYPES.has(t) ? (t as SecuredDebtKind) : null;
}

export function isPropertySecuredDebt(a: SecuredDebtEvidence): boolean {
  return securedDebtKind(a) !== null;
}

export const SECURED_DEBT_KIND_LABEL: Record<SecuredDebtKind, string> = {
  mortgage: DEBT_TYPE_LABEL.mortgage,
  heloc:    DEBT_TYPE_LABEL.heloc,
};

// ─────────────────────────────────────────────────────────────────────────────
// Link authorization (pure — the route and the AI assembler share it)
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkCandidateDebt extends SecuredDebtEvidence {
  id:          string;
  ownerUserId: string | null;
  deletedAt:   Date | string | null;
  /** The debt's ACTIVE SpaceAccountLinks the caller can see. */
  links:       { spaceId: string; visibilityLevel: string }[];
}

export type LinkCheck =
  | { ok: true; kind: SecuredDebtKind }
  | { ok: false; status: 400 | 404; error: string };

const NOT_FOUND: LinkCheck = { ok: false, status: 404, error: "Debt account not found." };

/**
 * May `viewerUserId` treat `debt` as secured by a property whose ACTIVE Spaces
 * are `propertySpaceIds`? Space/owner scoping identical to the asset: the debt
 * must be ACTIVE in a Space the property is ACTIVE in, and the caller must own
 * the debt or see it through a FULL link in one of those shared Spaces. A debt
 * from another Space or another user's private account is indistinguishable
 * from a missing one (404). The caller has already proven they own the property.
 */
export function checkSecuredDebtLink(args: {
  viewerUserId:     string;
  propertySpaceIds: readonly string[];
  debt:             LinkCandidateDebt | null;
}): LinkCheck {
  const d = args.debt;
  if (!d || d.deletedAt != null || d.type !== "debt") return NOT_FOUND;
  const shared = d.links.filter((l) => args.propertySpaceIds.includes(l.spaceId));
  if (shared.length === 0) return NOT_FOUND;
  if (d.ownerUserId !== args.viewerUserId && !shared.some((l) => l.visibilityLevel === "FULL")) return NOT_FOUND;
  const kind = securedDebtKind(d);
  if (kind === null) {
    return { ok: false, status: 400, error: "Only a mortgage or HELOC can be linked to a property." };
  }
  return { ok: true, kind };
}

// ─────────────────────────────────────────────────────────────────────────────
// Equity
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkedDebtInput extends SecuredDebtEvidence {
  id:       string;
  name:     string;
  /** Raw signed liability balance (positive = owed). */
  balance:  number;
  currency: string;
}

export interface PropertyEquityInput {
  /** The property's recorded value (FinancialAccount.balance). */
  value:      number;
  currency:   string;
  valueBasis: PropertyValueBasis;
  /** The linked debts the caller can see (already authorized). */
  linkedDebts: LinkedDebtInput[];
  /** Linked ids the caller can no longer see (deleted / unshared / not FULL). */
  unavailableLinkedCount?: number;
}

export type DoubleCountReason = "EQUITY_ENTERED_WITH_LINKED_DEBT" | "VALUE_BELOW_LINKED_DEBT";
export type EquityUnavailableReason = "EQUITY_ENTERED_WITH_LINKED_DEBT" | "CURRENCY_MISMATCH" | "LINKED_DEBT_NOT_VISIBLE";

export interface PropertyEquity {
  value:      number;
  currency:   string;
  valueBasis: PropertyValueBasis;
  /** Linked debts that ARE secured-by-property kinds and count toward equity. */
  securedDebts: { id: string; name: string; kind: SecuredDebtKind; amountOwed: number; currency: string }[];
  /** Linked ids that do NOT reduce equity, and why. */
  ignoredLinks: { id: string; reason: "NOT_SECURED_KIND" | "CURRENCY_MISMATCH" }[];
  securedDebtTotal: number;
  /** value − securedDebtTotal; null when it would be wrong to state one. */
  equity: number | null;
  equityUnavailableReason: EquityUnavailableReason | null;
  /** The double-count prompt, or null. Never acted on automatically. */
  doubleCount: { reason: DoubleCountReason; possibleUnderstatement: number } | null;
  /** Constant by construction: F9 never changes what net worth counts. */
  netWorthTreatment: "PROPERTY_AT_VALUE_DEBT_AS_LIABILITY";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computePropertyEquity(input: PropertyEquityInput): PropertyEquity {
  const securedDebts: PropertyEquity["securedDebts"] = [];
  const ignoredLinks: PropertyEquity["ignoredLinks"] = [];
  for (const d of input.linkedDebts) {
    const kind = securedDebtKind(d);
    if (kind === null) { ignoredLinks.push({ id: d.id, reason: "NOT_SECURED_KIND" }); continue; }
    if (d.currency !== input.currency) { ignoredLinks.push({ id: d.id, reason: "CURRENCY_MISMATCH" }); continue; }
    securedDebts.push({ id: d.id, name: d.name, kind, amountOwed: Math.max(d.balance, 0), currency: d.currency });
  }
  const securedDebtTotal = round2(securedDebts.reduce((s, d) => s + d.amountOwed, 0));
  const hasLinked = securedDebts.length > 0;

  let doubleCount: PropertyEquity["doubleCount"] = null;
  if (hasLinked && input.valueBasis === "EQUITY_ENTERED") {
    doubleCount = { reason: "EQUITY_ENTERED_WITH_LINKED_DEBT", possibleUnderstatement: securedDebtTotal };
  } else if (hasLinked && input.valueBasis === "UNKNOWN" && securedDebtTotal > 0
             && input.value < securedDebtTotal * UNKNOWN_BASIS_PROMPT_RATIO) {
    doubleCount = { reason: "VALUE_BELOW_LINKED_DEBT", possibleUnderstatement: securedDebtTotal };
  }

  let equityUnavailableReason: EquityUnavailableReason | null = null;
  if (doubleCount?.reason === "EQUITY_ENTERED_WITH_LINKED_DEBT") equityUnavailableReason = "EQUITY_ENTERED_WITH_LINKED_DEBT";
  else if (ignoredLinks.some((l) => l.reason === "CURRENCY_MISMATCH")) equityUnavailableReason = "CURRENCY_MISMATCH";
  else if ((input.unavailableLinkedCount ?? 0) > 0) equityUnavailableReason = "LINKED_DEBT_NOT_VISIBLE";

  return {
    value: input.value,
    currency: input.currency,
    valueBasis: input.valueBasis,
    securedDebts,
    ignoredLinks,
    securedDebtTotal,
    equity: equityUnavailableReason ? null : round2(input.value - securedDebtTotal),
    equityUnavailableReason,
    doubleCount,
    netWorthTreatment: "PROPERTY_AT_VALUE_DEBT_AS_LIABILITY",
  };
}

/** Exactly-one-candidate auto-SUGGESTION (never an auto-link: the user confirms). */
export function suggestSecuredDebt(args: { candidateIds: readonly string[]; linkedIds: readonly string[] }): string | null {
  if (args.linkedIds.length > 0) return null;
  return args.candidateIds.length === 1 ? args.candidateIds[0] : null;
}

/** The disclosure sentence for a double-count prompt (UI + AI share the words). */
export function doubleCountDisclosure(dc: NonNullable<PropertyEquity["doubleCount"]>): string {
  return dc.reason === "EQUITY_ENTERED_WITH_LINKED_DEBT"
    ? "Possible double count: this property's value was entered as equity while its mortgage is connected. Net worth may be understated by up to the linked debt. Confirm whether the value is market value or equity."
    : "Possible double count: this property's value is below its linked mortgage balance, which can mean the value was entered as equity. Confirm whether the value is market value or equity.";
}

/** For the AI: equity is derived, never additional wealth. */
export const PROPERTY_EQUITY_AI_MEANING =
  "Equity is DERIVED (value minus linked secured debt). Net worth already counts the property at its value and the mortgage/HELOC as debt — never add equity to net worth or present it as wealth on top of it.";

// ─────────────────────────────────────────────────────────────────────────────
// The owner's actions (PATCH /api/accounts/manual/[id]/property)
// ─────────────────────────────────────────────────────────────────────────────

export type PropertyLinkAction =
  | { op: "setBasis"; valueBasis: PropertyValueBasis }
  | { op: "link"; debtAccountId: string }
  | { op: "unlink"; debtAccountId: string };

/** Parse exactly one action from the request body. */
export function parsePropertyAction(body: unknown): PropertyLinkAction | { error: string } {
  const b = (body ?? {}) as { valueBasis?: unknown; link?: unknown; unlink?: unknown };
  const given = [b.valueBasis !== undefined, b.link !== undefined, b.unlink !== undefined].filter(Boolean).length;
  if (given !== 1) return { error: "Send exactly one of valueBasis, link, unlink." };
  if (b.valueBasis !== undefined) {
    return isPropertyValueBasis(b.valueBasis)
      ? { op: "setBasis", valueBasis: b.valueBasis }
      : { error: "Invalid valueBasis. Use: MARKET_VALUE, EQUITY_ENTERED, UNKNOWN" };
  }
  const id = (b.link ?? b.unlink) as unknown;
  if (typeof id !== "string" || id.trim() === "") return { error: "A debt account id is required." };
  return b.link !== undefined ? { op: "link", debtAccountId: id } : { op: "unlink", debtAccountId: id };
}

