/**
 * app/api/accounts/[id]/import/investments/route.ts
 *
 * A7-4 — investment import CONFIRM. Runs the pure pipeline then the commit path
 * (ImportBatch kind INVESTMENT_HISTORY, sequential writes, dedupe, supersession,
 * bounded repair). Behind INVESTMENT_IMPORTS_ENABLED. Authz identical to preview.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus, VisibilityLevel, ImportSource } from "@prisma/client";
import { withApiHandler } from "@/lib/api";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
import { commitInvestmentImport, type UserDecisions } from "@/lib/investments/investment-import-commit";
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
  let userDecisions: UserDecisions = {};
  const decisionsRaw = form?.get("userDecisions");
  if (typeof decisionsRaw === "string" && decisionsRaw) {
    try { userDecisions = JSON.parse(decisionsRaw); } catch { return NextResponse.json({ error: "userDecisions must be valid JSON." }, { status: 400 }); }
  }

  const text = await file.text();
  const pipeline = runInvestmentImportPipelineFromCsv(text, { profileKey, rowKindOverride });
  if (pipeline.error) return NextResponse.json({ error: pipeline.error, rawHeaders: pipeline.rawHeaders ?? null }, { status: 400 });

  const result = await commitInvestmentImport({
    financialAccountId: id, userId: user.id,
    profileKey, profileVersion: pipeline.resolvedColumnMapping.profileVersion,
    source: ImportSource.CSV,
    originalFilename: file.name,
    resolvedColumnMapping: pipeline.resolvedColumnMapping as unknown as import("@prisma/client").Prisma.InputJsonValue,
    rows: pipeline.rows,
    userDecisions,
  });

  if (result.status === "disabled") return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    importBatchId: result.batchId,
    counts: result.counts,
    supersededAssertions: result.supersededAssertions ?? 0,
    repair: result.repair ?? null,
  });
}, "POST /api/accounts/[id]/import/investments");
