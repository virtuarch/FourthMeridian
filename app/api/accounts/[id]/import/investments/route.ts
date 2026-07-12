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
import { buildImportPreview } from "@/lib/investments/investment-import-preview";
import { guardImportUpload } from "@/lib/investments/import-upload-guard";

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
  const guard = guardImportUpload(file);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const profileKey = (form?.get("profileKey") as string) || "csv:generic";
  const rowKindOverride = (form?.get("rowKind") as string) === "positions" ? "POSITION" as const : undefined;
  const acknowledged = (form?.get("acknowledged") as string) === "true";
  let userDecisions: UserDecisions = {};
  const decisionsRaw = form?.get("userDecisions");
  if (typeof decisionsRaw === "string" && decisionsRaw) {
    try { userDecisions = JSON.parse(decisionsRaw); } catch { return NextResponse.json({ error: "userDecisions must be valid JSON." }, { status: 400 }); }
  }

  const text = await file.text();

  // A7-6 — defense-in-depth: re-run the same safety gate the preview showed, so a
  // wrong-provider / non-investment / wrong-account / multi-account file can NEVER
  // be committed even if a client bypasses the preview. Blocking ⇒ 422; an
  // unproven-but-plausible file (generic/unverified) requires the explicit
  // `acknowledged` flag the UI's confirm step sends ⇒ else 409.
  const acct = await db.financialAccount.findUnique({ where: { id }, select: { institution: true, mask: true } });
  const preview = await buildImportPreview({
    csvText: text, profileKey, rowKindOverride,
    financialAccountId: id, connectionInstitution: acct?.institution ?? "", targetMask: acct?.mask ?? null, client: db,
  });
  if (!preview.canCommit) {
    return NextResponse.json({ error: "This file can't be imported into this account.", blockingReasons: preview.blockingReasons, preview }, { status: 422 });
  }
  if (preview.requiresConfirmation && !acknowledged) {
    return NextResponse.json({ error: "Confirm the target before importing.", requiresConfirmation: true, preview }, { status: 409 });
  }

  const pipeline = runInvestmentImportPipelineFromCsv(text, { profileKey, rowKindOverride });

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
