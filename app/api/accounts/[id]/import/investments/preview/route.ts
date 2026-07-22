/**
 * app/api/accounts/[id]/import/investments/preview/route.ts
 *
 * A7-4/A7-6 — investment import PREVIEW (zero writes). Authz is the canonical
 * import rule via the shared resolveImportableFinancialAccount guard (owner OR
 * FULL non-owner + role), identical to the confirm route. A7-6 runs
 * the shared safety gate (buildImportPreview): source detection, connection
 * compatibility, file assessment, and dedupe classification, returning a
 * structured verdict (canCommit + reasons) — a wrong file yields an EXPLAINED
 * preview, never a bare error. Behind INVESTMENT_IMPORTS_ENABLED.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { withApiHandler } from "@/lib/api";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
import { buildImportPreview } from "@/lib/investments/investment-import-preview";
import { guardImportUpload } from "@/lib/investments/import-upload-guard";
import { maskAccountLabel } from "@/lib/imports/investments/import-validation";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const [user, err] = await requireFreshUser();
  if (err) return err;
  if (!investmentImportsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Canonical import rule (P1 closeout convergence) via the shared guard —
  // owner/creator OR non-owner with FULL visibility + permitted role. The
  // redundant inlined FULL check (which gated the owner too) was removed.
  const { spaceId } = await getSpaceContext();
  const access = await resolveImportableFinancialAccount(user.id, spaceId, id);
  if (!access.ok) return access.response;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file." }, { status: 400 });
  const guard = guardImportUpload(file);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const profileKey = (form?.get("profileKey") as string) || "csv:generic";
  const rowKindOverride = (form?.get("rowKind") as string) === "positions" ? "POSITION" as const : undefined;

  const acct = await db.financialAccount.findUnique({ where: { id }, select: { institution: true, mask: true } });
  const text = await file.text();
  const preview = await buildImportPreview({
    csvText: text, profileKey, rowKindOverride,
    financialAccountId: id, connectionInstitution: acct?.institution ?? "", targetMask: acct?.mask ?? null,
  });

  return NextResponse.json({
    target: { id, label: maskAccountLabel(acct?.mask ?? null), institution: acct?.institution ?? null },
    ...preview,
  });
}, "POST /api/accounts/[id]/import/investments/preview");
