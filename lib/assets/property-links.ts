/**
 * lib/assets/property-links.ts   (Mortgage F9 — server side)
 *
 * Reads and writes a manual property's value basis and its links to the debts
 * it secures (ManualAssetProfile.valueBasis / .securedDebtAccountIds). The pure
 * policy — which debts qualify, who may link them, what equity is, when to raise
 * the double-count prompt — is lib/assets/property-equity.ts.
 *
 * Every function takes the CALLER'S tenant transaction (RLS). WRITES are
 * OWNER-ONLY (the PATCH /api/accounts/manual/[id] gate) and each one writes its
 * AuditLog row in the SAME transaction (S2 R1; ids and enum values only). The
 * READ serves the owner or a viewer holding an ACTIVE FULL link to the property
 * (the valuations rule); equity is shown to a viewer only when EVERY linked debt
 * is visible to them at a balance-disclosing tier (S2 R2) — otherwise no figure,
 * no partial list, no count and no names. Linking re-checks the debt with
 * checkSecuredDebtLink (same-Space ACTIVE link, owner or FULL, type debt, not
 * deleted, mortgage/HELOC).
 *
 * Nothing here changes a balance, a valuation or net worth. A link or a basis is
 * written only on the user's explicit action; nothing is auto-linked.
 */

import { AccountType, ShareStatus } from "@prisma/client";
import type { TenantClient } from "@/lib/db/tenant-context";
import { AuditAction } from "@/lib/audit-actions";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import {
  canCarrySecuredDebt, checkSecuredDebtLink, isManualAssetKind, normalizeSecuredDebtIds, securedDebtKind,
  suggestSecuredDebt, viewerPropertyEquity, MANUAL_ASSET_KINDS,
  type LinkCandidateDebt, type PropertyEquity, type PropertyLinkAction, type PropertyValueBasis, type SecuredDebtKind,
} from "./property-equity";

export interface PropertyEquityView {
  accountId:   string;
  assetKind:   string | null;
  /** The caller owns the property (only the owner links, unlinks or confirms a basis). */
  canEdit:     boolean;
  canLinkSecuredDebt: boolean;
  equity:      PropertyEquity;
  /** Same-Space secured debts the owner may link (not yet linked). Owner only. */
  candidates:  { id: string; name: string; kind: SecuredDebtKind; amountOwed: number; currency: string }[];
  /** Exactly-one-candidate suggestion; requires the user's confirmation. */
  suggestedDebtId: string | null;
}

interface PropertyRow {
  fa: { id: string; balance: number; currency: string };
  isOwner: boolean;
  spaceIds: string[];
  profile: { assetKind: string | null; valueBasis: PropertyValueBasis; securedDebtAccountIds: string[] } | null;
}

/** The property, if the viewer owns it or holds an ACTIVE FULL link to it. */
async function loadProperty(tx: TenantClient, propertyId: string, viewerUserId: string): Promise<PropertyRow | null> {
  const fa = await tx.financialAccount.findUnique({
    where:  { id: propertyId },
    select: {
      id: true, ownerUserId: true, syncStatus: true, type: true, deletedAt: true, balance: true, currency: true,
      spaceAccountLinks:  { where: { status: ShareStatus.ACTIVE }, select: { spaceId: true, visibilityLevel: true } },
      manualAssetProfile: { select: { assetKind: true, valueBasis: true, securedDebtAccountIds: true } },
    },
  });
  if (!fa || fa.deletedAt || fa.syncStatus !== "manual" || fa.type !== AccountType.other) return null;
  const isOwner = fa.ownerUserId === viewerUserId;
  if (!isOwner && !fa.spaceAccountLinks.some((l) => l.visibilityLevel === "FULL")) return null;
  const p = fa.manualAssetProfile;
  return {
    fa: { id: fa.id, balance: fa.balance, currency: fa.currency },
    isOwner,
    spaceIds: fa.spaceAccountLinks.map((l) => l.spaceId),
    // NULL-safe: the array column is nullable at the DB level.
    profile: p ? { assetKind: p.assetKind, valueBasis: p.valueBasis, securedDebtAccountIds: normalizeSecuredDebtIds(p.securedDebtAccountIds) } : null,
  };
}

/** Debts ACTIVE in any of the property's Spaces (RLS scopes to the caller), plus the given ids. */
async function loadDebts(tx: TenantClient, spaceIds: string[], extraIds: string[]) {
  if (spaceIds.length === 0 && extraIds.length === 0) return [];
  const rows = await tx.financialAccount.findMany({
    where: {
      type: AccountType.debt,
      OR: [
        ...(spaceIds.length > 0 ? [{ deletedAt: null, spaceAccountLinks: { some: { status: ShareStatus.ACTIVE, spaceId: { in: spaceIds } } } }] : []),
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
  const prop = await loadProperty(tx, args.propertyId, args.viewerUserId);
  if (!prop) return { kind: "notFound" };
  const linkedIds = prop.profile?.securedDebtAccountIds ?? [];
  const debts = await loadDebts(tx, prop.spaceIds, linkedIds);
  // S2 R2 — every linked id must be balance-visible to THIS viewer, or no equity.
  const equity = viewerPropertyEquity({
    viewerUserId: args.viewerUserId, propertySpaceIds: prop.spaceIds,
    value: prop.fa.balance, currency: prop.fa.currency, valueBasis: prop.profile?.valueBasis ?? "UNKNOWN",
    linkedIds,
    debts: debts.map((d) => ({ ...d.candidate, name: accountDisplayName(d.row), balance: d.row.balance, currency: d.row.currency })),
  });

  const linkedSet = new Set(linkedIds);
  const canLink = prop.isOwner && canCarrySecuredDebt(prop.profile?.assetKind);
  const candidates = !canLink ? [] : debts
    .filter((d) => !linkedSet.has(d.row.id)
      && checkSecuredDebtLink({ viewerUserId: args.viewerUserId, propertySpaceIds: prop.spaceIds, debt: d.candidate }).ok)
    .map((d) => ({
      id: d.row.id, name: accountDisplayName(d.row), kind: securedDebtKind(d.candidate)!,
      amountOwed: Math.max(d.row.balance, 0), currency: d.row.currency,
    }));

  return {
    kind: "ok",
    view: {
      accountId: prop.fa.id,
      assetKind: prop.profile?.assetKind ?? null,
      canEdit: prop.isOwner,
      canLinkSecuredDebt: canLink,
      equity,
      candidates,
      suggestedDebtId: canLink ? suggestSecuredDebt({ candidateIds: candidates.map((c) => c.id), linkedIds }) : null,
    },
  };
}

/**
 * The AuditLog row for one applied owner action (S2 R1). ids and enum values
 * only — never a balance, a value or a name. Pure, so the shape is pinned by test.
 */
export function propertyAuditRow(args: {
  userId: string; propertyId: string; action: PropertyLinkAction; fromBasis: PropertyValueBasis; ipAddress?: string | null;
}): { userId: string; action: string; metadata: Record<string, string>; ipAddress?: string } {
  const a = args.action;
  const base = { userId: args.userId, ...(args.ipAddress ? { ipAddress: args.ipAddress } : {}) };
  if (a.op === "setBasis") {
    return { ...base, action: AuditAction.MANUAL_ASSET_VALUE_BASIS_CHANGED,
      metadata: { propertyId: args.propertyId, from: args.fromBasis, to: a.valueBasis } };
  }
  return { ...base,
    action: a.op === "link" ? AuditAction.MANUAL_ASSET_SECURED_DEBT_LINKED : AuditAction.MANUAL_ASSET_SECURED_DEBT_UNLINKED,
    metadata: { propertyId: args.propertyId, debtAccountId: a.debtAccountId } };
}

/**
 * One OWNER action, its profile write and its AuditLog row in the caller's ONE
 * tenant transaction. Upserts the profile (a pre-RWA-2 asset may have none). A
 * no-op (linking an already-linked debt, unlinking an absent one, re-stating the
 * same basis) writes nothing and audits nothing.
 */
export async function applyPropertyLinkAction(tx: TenantClient, args: {
  propertyId: string; viewerUserId: string; action: PropertyLinkAction; ipAddress?: string | null;
}): Promise<{ kind: "ok" } | { kind: "notFound" } | { kind: "invalid"; status: 400 | 404; error: string }> {
  const prop = await loadProperty(tx, args.propertyId, args.viewerUserId);
  if (!prop || !prop.isOwner) return { kind: "notFound" };
  const current = prop.profile?.securedDebtAccountIds ?? [];
  const fromBasis: PropertyValueBasis = prop.profile?.valueBasis ?? "UNKNOWN";
  const a = args.action;

  let data: { valueBasis?: PropertyValueBasis; securedDebtAccountIds?: string[] };
  if (a.op === "setBasis") {
    if (a.valueBasis === fromBasis && prop.profile) return { kind: "ok" };
    data = { valueBasis: a.valueBasis };
  } else if (a.op === "unlink") {
    // Unlinking needs no debt check: it only removes the caller's own fact.
    if (!current.includes(a.debtAccountId)) return { kind: "ok" };
    data = { securedDebtAccountIds: current.filter((id) => id !== a.debtAccountId) };
  } else {
    // S2 D2 — the stored kind is validated against the ONE allowlist.
    const storedKind = prop.profile?.assetKind ?? null;
    if (storedKind !== null && !isManualAssetKind(storedKind)) {
      return { kind: "invalid", status: 400, error: `Invalid assetKind. Use: ${MANUAL_ASSET_KINDS.join(", ")}` };
    }
    if (!canCarrySecuredDebt(storedKind)) {
      return { kind: "invalid", status: 400, error: "Only a property can be linked to a mortgage or HELOC." };
    }
    const [debt] = (await loadDebts(tx, prop.spaceIds, [a.debtAccountId])).filter((d) => d.row.id === a.debtAccountId);
    const check = checkSecuredDebtLink({ viewerUserId: args.viewerUserId, propertySpaceIds: prop.spaceIds, debt: debt?.candidate ?? null });
    if (!check.ok) return { kind: "invalid", status: check.status, error: check.error };
    if (current.includes(a.debtAccountId)) return { kind: "ok" };
    data = { securedDebtAccountIds: [...current, a.debtAccountId] };
  }

  // The FK appears only in `where` and the create arm, for the property just
  // authorized; the update arm names the two F9 columns and nothing else
  // (so audit-account-reparenting sees no re-parenting-capable payload).
  await tx.manualAssetProfile.upsert({
    where:  { financialAccountId: prop.fa.id },
    create: { financialAccountId: prop.fa.id, valueBasis: data.valueBasis, securedDebtAccountIds: data.securedDebtAccountIds },
    update: { valueBasis: data.valueBasis, securedDebtAccountIds: data.securedDebtAccountIds },
  });
  // S2 R1 — the audit row commits (or rolls back) WITH the write.
  await tx.auditLog.create({
    data: propertyAuditRow({ userId: args.viewerUserId, propertyId: prop.fa.id, action: a, fromBasis, ipAddress: args.ipAddress }),
  });
  return { kind: "ok" };
}

/** Bulk read for the AI accounts assembler: F9 facts of many manual assets (NULL-safe). */
export async function loadPropertyProfilesFor(tx: TenantClient, ids: string[]): Promise<Map<string, {
  assetKind: string | null; valueBasis: PropertyValueBasis; securedDebtAccountIds: string[];
}>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.manualAssetProfile.findMany({
    where:  { financialAccountId: { in: ids } },
    select: { financialAccountId: true, assetKind: true, valueBasis: true, securedDebtAccountIds: true },
  });
  return new Map(rows.map((r) => [r.financialAccountId, {
    assetKind: r.assetKind, valueBasis: r.valueBasis, securedDebtAccountIds: normalizeSecuredDebtIds(r.securedDebtAccountIds),
  }]));
}
