/**
 * app/api/accounts/[id]/import/investments/preview/route.ts
 *
 * A7-4 — investment import PREVIEW (zero writes). Mirrors the banking preview
 * route's authz (shared resolveImportableFinancialAccount) but over the pure
 * investment pipeline + read-only classification. Behind INVESTMENT_IMPORTS_ENABLED.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus, VisibilityLevel } from "@prisma/client";
import { withApiHandler } from "@/lib/api";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
import { previewInvestmentImport } from "@/lib/investments/investment-import-commit";
import { runInvestmentImportPipelineFromCsv } from "@/lib/imports/investments/pipeline";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const [user, err] = await requireFreshUser();
  if (err) return err;
  if (!investmentImportsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { spaceId } = await getSpaceContext();
  const access = await resolveImportableFinancialAccount(user.id, spaceId, id);
  if (!access.ok) return access.response;
  const link = await db.spaceAccountLink.findFirst({ where: { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE }, select: { visibilityLevel: true } });
  if (link?.visibilityLevel !== VisibilityLevel.FULL) return NextResponse.json({ error: "Full account visibility is required to import." }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file." }, { status: 400 });
  const profileKey = (form?.get("profileKey") as string) || "csv:generic";
  const rowKindOverride = (form?.get("rowKind") as string) === "positions" ? "POSITION" as const : undefined;

  const text = await file.text();
  const pipeline = runInvestmentImportPipelineFromCsv(text, { profileKey, rowKindOverride });
  if (pipeline.error) return NextResponse.json({ error: pipeline.error, rawHeaders: pipeline.rawHeaders ?? null }, { status: 400 });

  const preview = await previewInvestmentImport({ financialAccountId: id, profileKey, rows: pipeline.rows });
  return NextResponse.json({
    resolvedColumnMapping: pipeline.resolvedColumnMapping,
    counts: preview.counts,
    rows: preview.rows,
  });
}, "POST /api/accounts/[id]/import/investments/preview");
