/**
 * lib/assets/property-links.ts   (Mortgage F9 — server side)
 *
 * Reads and writes a manual property's value basis and its links to the debts
 * it secures (ManualAssetProfile.valueBasis / .securedDebtAccountIds). The pure
 * policy — which debts qualify, who may link them, what equity is, when to raise
 * the double-count prompt — is lib/assets/property-equity.ts.
 *
 * Every function takes the CALLER'S tenant transaction (RLS), and both the read
 * and the write are OWNER-ONLY: the property must be the caller's own manual
 * asset (the PATCH /api/accounts/manual/[id] gate). Each debt id is re-checked on
 * every read AND write by checkSecuredDebtLink (same-Space ACTIVE link, owner or
 * FULL, type debt, not deleted, secured kind), so a stale id is ignored, never
 * subtracted.
 *
 * Nothing here changes a balance, a valuation or net worth. A link or a basis is
 * written only on the user's explicit action; nothing is auto-linked.
 */

import { AccountType, ShareStatus } from "@prisma/client";
import type { TenantClient } from "@/lib/db/tenant-context";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import {
  canCarrySecuredDebt, checkSecuredDebtLink, computePropertyEquity, securedDebtKind, suggestSecuredDebt,
  type LinkCandidateDebt, type PropertyEquity, type PropertyLinkAction, type PropertyValueBasis, type SecuredDebtKind,
} from "./property-equity";

export interface PropertyEquityView {
  accountId:   string;
  assetKind:   string | null;
  canLinkSecuredDebt: boolean;
  equity:      PropertyEquity;
  /** Same-Space secured debts the owner may link (not yet linked). */
  candidates:  { id: string; name: string; kind: SecuredDebtKind; amountOwed: number; currency: string }[];
  /** Exactly-one-candidate suggestion; requires the user's confirmation. */
  suggestedDebtId: string | null;
}

type Owned =
  | { kind: "ok"; fa: { id: string; balance: number; currency: string }; spaceIds: string[];
      profile: { assetKind: string | null; valueBasis: PropertyValueBasis; securedDebtAccountIds: string[] } | null }
  | { kind: "notFound" };

async function loadOwnedProperty(tx: TenantClient, propertyId: string, userId: string): Promise<Owned> {
  const fa = await tx.financialAccount.findUnique({
    where:  { id: propertyId },
    select: {
      id: true, ownerUserId: true, syncStatus: true, type: true, deletedAt: true, balance: true, currency: true,
      spaceAccountLinks:  { where: { status: ShareStatus.ACTIVE }, select: { spaceId: true } },
      manualAssetProfile: { select: { assetKind: true, valueBasis: true, securedDebtAccountIds: true } },
    },
  });
  if (!fa || fa.deletedAt || fa.ownerUserId !== userId || fa.syncStatus !== "manual" || fa.type !== AccountType.other) {
    return { kind: "notFound" };
  }
  const p = fa.manualAssetProfile;
  return {
    kind: "ok",
    fa: { id: fa.id, balance: fa.balance, currency: fa.currency },
    spaceIds: fa.spaceAccountLinks.map((l) => l.spaceId),
    profile: p ? { assetKind: p.assetKind, valueBasis: p.valueBasis, securedDebtAccountIds: p.securedDebtAccountIds ?? [] } : null,
  };
}

/** Debts ACTIVE in any of the property's Spaces (RLS scopes to the caller), plus the given ids. */
async function loadDebts(tx: TenantClient, spaceIds: string[], extraIds: string[]) {
  if (spaceIds.length === 0) return [];
  const rows = await tx.financialAccount.findMany({
    where: {
      type: AccountType.debt,
      deletedAt: null,
      OR: [
        { spaceAccountLinks: { some: { status: ShareStatus.ACTIVE, spaceId: { in: spaceIds } } } },
        ...(extraIds.length > 0 ? [{ id: { in: extraIds } }] : []),
      ],
    },
    select: {
      id: true, ...ACCOUNT_NAME_SELECT, ownerUserId: true, type: true, deletedAt: true, balance: true, currency: true,
      debtSubtype: true, providerSubtype: true, creditLimit: true,
      spaceAccountLinks: { where: { status: ShareStatus.ACTIVE, spaceId: { in: spaceIds } }, select: { spaceId: true, visibilityLevel: true } },
    },
  });
  return rows.map((r) => ({
    row: r,
    candidate: {
      id: r.id, ownerUserId: r.ownerUserId, deletedAt: r.deletedAt, type: r.type,
      debtSubtype: r.debtSubtype, providerSubtype: r.providerSubtype, creditLimit: r.creditLimit,
      links: r.spaceAccountLinks.map((l) => ({ spaceId: l.spaceId, visibilityLevel: l.visibilityLevel })),
    } satisfies LinkCandidateDebt,
  }));
}

export async function loadPropertyEquityView(tx: TenantClient, args: {
  propertyId: string; viewerUserId: string;
}): Promise<{ kind: "ok"; view: PropertyEquityView } | { kind: "notFound" }> {
  const owned = await loadOwnedProperty(tx, args.propertyId, args.viewerUserId);
  if (owned.kind !== "ok") return owned;
  const linkedIds = owned.profile?.securedDebtAccountIds ?? [];
  const debts = await loadDebts(tx, owned.spaceIds, linkedIds);

  const authorized = debts.filter((d) =>
    checkSecuredDebtLink({ viewerUserId: args.viewerUserId, propertySpaceIds: owned.spaceIds, debt: d.candidate }).ok);
  const linkedSet = new Set(linkedIds);
  const linkedVisible = authorized.filter((d) => linkedSet.has(d.row.id));

  const equity = computePropertyEquity({
    value:      owned.fa.balance,
    currency:   owned.fa.currency,
    valueBasis: owned.profile?.valueBasis ?? "UNKNOWN",
    linkedDebts: linkedVisible.map((d) => ({
      id: d.row.id, name: accountDisplayName(d.row), balance: d.row.balance, currency: d.row.currency,
      type: d.row.type, debtSubtype: d.row.debtSubtype, providerSubtype: d.row.providerSubtype, creditLimit: d.row.creditLimit,
    })),
    unavailableLinkedCount: linkedIds.length - linkedVisible.length,
  });

  const candidates = authorized
    .filter((d) => !linkedSet.has(d.row.id))
    .map((d) => ({
      id: d.row.id, name: accountDisplayName(d.row), kind: securedDebtKind(d.candidate)!,
      amountOwed: Math.max(d.row.balance, 0), currency: d.row.currency,
    }));
  const canLink = canCarrySecuredDebt(owned.profile?.assetKind);

  return {
    kind: "ok",
    view: {
      accountId: owned.fa.id,
      assetKind: owned.profile?.assetKind ?? null,
      canLinkSecuredDebt: canLink,
      equity,
      candidates: canLink ? candidates : [],
      suggestedDebtId: canLink ? suggestSecuredDebt({ candidateIds: candidates.map((c) => c.id), linkedIds: linkedVisible.map((d) => d.row.id) }) : null,
    },
  };
}

/** One owner action. Upserts the profile (a pre-RWA-2 asset may have none). */
export async function applyPropertyLinkAction(tx: TenantClient, args: {
  propertyId: string; viewerUserId: string; action: PropertyLinkAction;
}): Promise<{ kind: "ok" } | { kind: "notFound" } | { kind: "invalid"; status: 400 | 404; error: string }> {
  const owned = await loadOwnedProperty(tx, args.propertyId, args.viewerUserId);
  if (owned.kind !== "ok") return owned;
  const current = owned.profile?.securedDebtAccountIds ?? [];
  const a = args.action;

  let data: { valueBasis?: PropertyValueBasis; securedDebtAccountIds?: string[] };
  if (a.op === "setBasis") {
    data = { valueBasis: a.valueBasis };
  } else if (a.op === "unlink") {
    // Unlinking needs no debt check: it only removes the caller's own fact.
    data = { securedDebtAccountIds: current.filter((id) => id !== a.debtAccountId) };
  } else {
    if (!canCarrySecuredDebt(owned.profile?.assetKind)) {
      return { kind: "invalid", status: 400, error: "Only a property can be linked to a mortgage or HELOC." };
    }
    const [debt] = await loadDebts(tx, owned.spaceIds, [a.debtAccountId]).then((ds) => ds.filter((d) => d.row.id === a.debtAccountId));
    const check = checkSecuredDebtLink({ viewerUserId: args.viewerUserId, propertySpaceIds: owned.spaceIds, debt: debt?.candidate ?? null });
    if (!check.ok) return { kind: "invalid", status: check.status, error: check.error };
    data = { securedDebtAccountIds: current.includes(a.debtAccountId) ? current : [...current, a.debtAccountId] };
  }

  // The FK appears only in `where` and the create arm, for the property just
  // authorized; the update arm names the two F9 columns and nothing else
  // (so audit-account-reparenting sees no re-parenting-capable payload).
  await tx.manualAssetProfile.upsert({
    where:  { financialAccountId: owned.fa.id },
    create: { financialAccountId: owned.fa.id, valueBasis: data.valueBasis, securedDebtAccountIds: data.securedDebtAccountIds },
    update: { valueBasis: data.valueBasis, securedDebtAccountIds: data.securedDebtAccountIds },
  });
  return { kind: "ok" };
}

/** Bulk read for the AI accounts assembler: F9 facts of many manual assets. */
export async function loadPropertyProfilesFor(tx: TenantClient, ids: string[]): Promise<Map<string, {
  assetKind: string | null; valueBasis: PropertyValueBasis; securedDebtAccountIds: string[];
}>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.manualAssetProfile.findMany({
    where:  { financialAccountId: { in: ids } },
    select: { financialAccountId: true, assetKind: true, valueBasis: true, securedDebtAccountIds: true },
  });
  return new Map(rows.map((r) => [r.financialAccountId, {
    assetKind: r.assetKind, valueBasis: r.valueBasis, securedDebtAccountIds: r.securedDebtAccountIds ?? [],
  }]));
}
