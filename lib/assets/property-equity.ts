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

/**
 * THE ONE allowlist of manual-asset kinds (S2 D2): the create route
 * (app/api/accounts/manual/route.ts) and the property endpoint both validate
 * against it; anything else is a 400.
 */
export const MANUAL_ASSET_KINDS = ["real_estate", "vehicle", "equipment", "other"] as const;
export type ManualAssetKind = (typeof MANUAL_ASSET_KINDS)[number];

export function isManualAssetKind(v: unknown): v is ManualAssetKind {
  return typeof v === "string" && (MANUAL_ASSET_KINDS as readonly string[]).includes(v);
}

/** Validate a submitted kind against MANUAL_ASSET_KINDS. */
export function parseManualAssetKind(v: unknown): { ok: true; kind: ManualAssetKind } | { ok: false; error: string } {
  return isManualAssetKind(v)
    ? { ok: true, kind: v }
    : { ok: false, error: `Invalid assetKind. Use: ${MANUAL_ASSET_KINDS.join(", ")}` };
}

/**
 * May a secured debt be linked to an asset of this STORED kind? Real estate, or
 * never recorded (null, every pre-F9 asset). A stored kind outside the allowlist
 * is rejected by the endpoint (400) before this is asked.
 */
export function canCarrySecuredDebt(assetKind: string | null | undefined): boolean {
  return assetKind == null || assetKind === MANUAL_ASSET_KINDS[0];
}

/**
 * ManualAssetProfile.securedDebtAccountIds is NULLABLE at the DB level (a
 * Postgres array column without NOT NULL). NULL — or anything that is not an
 * array of non-empty strings — reads as NO links. Every reader goes through this.
 */
export function normalizeSecuredDebtIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))];
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
  /** The linked debts the viewer can see at a balance-disclosing visibility. */
  linkedDebts: LinkedDebtInput[];
  /**
   * S2 R2 — true when ANY linked id is not visible to this viewer at a
   * visibility that includes its balance. Equity is then NOT SHOWN at all: no
   * figure, no partial total, no debt list, no count and no names — only
   * `equityUnavailableReason: "LINKED_DEBT_NOT_VISIBLE"`.
   */
  someLinkedDebtHidden?: boolean;
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
  /** Null when a linked debt is hidden from this viewer (S2 R2). */
  securedDebtTotal: number | null;
  /** value − securedDebtTotal; null when it would be wrong to state one. */
  equity: number | null;
  equityUnavailableReason: EquityUnavailableReason | null;
  /** The double-count prompt, or null. Never acted on automatically. */
  doubleCount: { reason: DoubleCountReason; possibleUnderstatement: number } | null;
  /** Constant by construction: F9 never changes what net worth counts. */
  netWorthTreatment: "PROPERTY_AT_VALUE_DEBT_AS_LIABILITY";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The viewer-facing words when a linked loan is hidden (no count, no names). */
export const EQUITY_HIDDEN_MESSAGE = "Equity not shown — a linked loan isn't visible to you";

export function computePropertyEquity(input: PropertyEquityInput): PropertyEquity {
  if (input.someLinkedDebtHidden) {
    return {
      value: input.value, currency: input.currency, valueBasis: input.valueBasis,
      securedDebts: [], ignoredLinks: [], securedDebtTotal: null,
      equity: null, equityUnavailableReason: "LINKED_DEBT_NOT_VISIBLE",
      doubleCount: null,
      netWorthTreatment: "PROPERTY_AT_VALUE_DEBT_AS_LIABILITY",
    };
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// S2 R2 — viewer visibility of a linked debt (equity is all-or-nothing)
// ─────────────────────────────────────────────────────────────────────────────

/** Link tiers that include the balance (grantsBalanceDisclosure's set). */
export const BALANCE_DISCLOSING_LEVELS: ReadonlySet<string> = new Set(["FULL", "BALANCE_ONLY"]);

/**
 * Does `viewerUserId` see this linked debt's BALANCE? The viewer owns it, or
 * holds an ACTIVE FULL / BALANCE_ONLY link to it in a Space the property is
 * ACTIVE in (as visible to the viewer). A deleted or non-debt row is not a
 * visible debt. `nameVisible` = owner or FULL only (BALANCE_ONLY never names).
 */
export function linkedDebtVisibility(args: {
  viewerUserId: string; propertySpaceIds: readonly string[]; debt: LinkCandidateDebt | null | undefined;
}): { visible: false } | { visible: true; nameVisible: boolean } {
  const d = args.debt;
  if (!d || d.deletedAt != null || d.type !== "debt") return { visible: false };
  if (d.ownerUserId === args.viewerUserId) return { visible: true, nameVisible: true };
  const shared = d.links.filter((l) => args.propertySpaceIds.includes(l.spaceId) && BALANCE_DISCLOSING_LEVELS.has(l.visibilityLevel));
  if (shared.length === 0) return { visible: false };
  return { visible: true, nameVisible: shared.some((l) => l.visibilityLevel === "FULL") };
}

/**
 * S2 R3 — the property READ scope. The owner keeps every ACTIVE link of the
 * property (unchanged). A NON-owner's links are first filtered EXPLICITLY to
 * Spaces where the viewer holds an ACTIVE SpaceMember membership (not relying
 * on the RLS shape); BOTH the FULL-visibility gate AND the Space ids used to
 * load debts and compute equity come from that filtered set. null = 404.
 */
export function propertyReadScope(args: {
  isOwner: boolean;
  links: readonly { spaceId: string; visibilityLevel: string }[];
  viewerActiveSpaceIds: readonly string[];
}): { spaceIds: string[] } | null {
  if (args.isOwner) return { spaceIds: [...new Set(args.links.map((l) => l.spaceId))] };
  const member = new Set(args.viewerActiveSpaceIds);
  const mine = args.links.filter((l) => member.has(l.spaceId));
  if (!mine.some((l) => l.visibilityLevel === "FULL")) return null;
  return { spaceIds: [...new Set(mine.map((l) => l.spaceId))] };
}

/** One debt row as the property endpoint loads it (link evidence + balance). */
export interface ViewerDebtRow extends LinkCandidateDebt {
  name: string; balance: number; currency: string;
}

/**
 * S2 R2 — the equity a given VIEWER may see. Every linked id must be
 * balance-visible to the viewer (linkedDebtVisibility); otherwise the result is
 * the hidden form (no figure, list, total, count or names). A BALANCE_ONLY debt
 * is named by its kind label, never its name. The property endpoint's one rule.
 */
export function viewerPropertyEquity(args: {
  viewerUserId: string; propertySpaceIds: readonly string[];
  value: number; currency: string; valueBasis: PropertyValueBasis;
  linkedIds: unknown; debts: readonly ViewerDebtRow[];
}): PropertyEquity {
  const byId = new Map(args.debts.map((d) => [d.id, d]));
  const linked: LinkedDebtInput[] = [];
  let hidden = false;
  for (const id of normalizeSecuredDebtIds(args.linkedIds)) {
    const d = byId.get(id);
    const v = linkedDebtVisibility({ viewerUserId: args.viewerUserId, propertySpaceIds: args.propertySpaceIds, debt: d });
    if (!v.visible || !d) { hidden = true; continue; }
    const kind = securedDebtKind(d);
    linked.push({
      id: d.id, name: v.nameVisible ? d.name : (kind ? SECURED_DEBT_KIND_LABEL[kind] : "Linked loan"),
      balance: d.balance, currency: d.currency,
      type: d.type, debtSubtype: d.debtSubtype, providerSubtype: d.providerSubtype, creditLimit: d.creditLimit,
    });
  }
  return computePropertyEquity({
    value: args.value, currency: args.currency, valueBasis: args.valueBasis, linkedDebts: linked, someLinkedDebtHidden: hidden,
  });
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


// ─────────────────────────────────────────────────────────────────────────────
// The AI payload (lib/ai/assemblers/accounts.ts → AccountSummaryItem.property)
// ─────────────────────────────────────────────────────────────────────────────

/** A debt row of the Space being assembled, with the viewer's link tier. */
export interface AiSpaceDebt extends LinkedDebtInput {
  visibilityLevel: string;
}

export type AiPropertyFacts = {
  value:            number;
  valueBasis:       PropertyValueBasis;
  securedDebts:     { id: string; name: string; kind: SecuredDebtKind; amountOwed: number }[];
  securedDebtTotal: number | null;
  derivedEquity:    number | null;
  equityUnavailableReason?: EquityUnavailableReason;
  possibleDoubleCount?: { reason: DoubleCountReason; possibleUnderstatement: number; disclosure: string };
  netWorthTreatment: "PROPERTY_AT_VALUE_DEBT_AS_LIABILITY";
  meaning:           string;
};

/**
 * The `property` fact for ONE manual asset, or null when its profile states
 * nothing (no real_estate kind, no link, UNKNOWN basis — every pre-F9 asset, so
 * those contexts stay byte-identical). A linked debt counts as visible only when
 * it is in `spaceDebts` at a balance-disclosing tier; if ANY linked id is not,
 * the payload carries the flag only (S2 R2): no equity, no total, no debt list,
 * no double-count figure, no count, no names. BALANCE_ONLY debts are named by
 * their kind label, never their name.
 */
export function aiPropertyFacts(args: {
  value: number; currency: string;
  profile: { assetKind: string | null; valueBasis: PropertyValueBasis; securedDebtAccountIds: unknown } | undefined;
  spaceDebts: ReadonlyMap<string, AiSpaceDebt>;
}): AiPropertyFacts | null {
  const p = args.profile;
  if (!p) return null;
  const ids = normalizeSecuredDebtIds(p.securedDebtAccountIds);
  if (p.assetKind !== MANUAL_ASSET_KINDS[0] && ids.length === 0 && p.valueBasis === "UNKNOWN") return null;
  const linked: LinkedDebtInput[] = [];
  let hidden = false;
  for (const id of ids) {
    const d = args.spaceDebts.get(id);
    if (!d || !BALANCE_DISCLOSING_LEVELS.has(d.visibilityLevel)) { hidden = true; continue; }
    const kind = securedDebtKind(d);
    linked.push({ ...d, name: d.visibilityLevel === "FULL" ? d.name : (kind ? SECURED_DEBT_KIND_LABEL[kind] : "Linked loan") });
  }
  const eq = computePropertyEquity({
    value: args.value, currency: args.currency, valueBasis: p.valueBasis, linkedDebts: linked, someLinkedDebtHidden: hidden,
  });
  return {
    value:            eq.value,
    valueBasis:       eq.valueBasis,
    securedDebts:     eq.securedDebts.map((d) => ({ id: d.id, name: d.name, kind: d.kind, amountOwed: d.amountOwed })),
    securedDebtTotal: eq.securedDebtTotal,
    derivedEquity:    eq.equity,
    ...(eq.equityUnavailableReason ? { equityUnavailableReason: eq.equityUnavailableReason } : {}),
    ...(eq.doubleCount ? { possibleDoubleCount: { ...eq.doubleCount, disclosure: doubleCountDisclosure(eq.doubleCount) } } : {}),
    netWorthTreatment: eq.netWorthTreatment,
    meaning:           PROPERTY_EQUITY_AI_MEANING,
  };
}
