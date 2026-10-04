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
import { ImportSource } from "@prisma/client";
import { withApiHandler } from "@/lib/api";
import { resolveImportableFinancialAccount } from "@/lib/imports/authorize";
import { withTenantDb } from "@/lib/db/tenant-context";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
import { commitInvestmentImport, type UserDecisions } from "@/lib/investments/investment-import-commit";
import { runInvestmentImportPipelineFromCsv } from "@/lib/imports/investments/pipeline";
import { buildImportPreview } from "@/lib/investments/investment-import-preview";
import { guardImportUpload } from "@/lib/investments/import-upload-guard";

/** One read-only phase over a whole file; Prisma's 5 s default is sized for a single statement group. */
const PREVIEW_PHASE_TIMEOUT_MS = 30_000;

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const [user, err] = await requireFreshUser();
  if (err) return err;
  if (!investmentImportsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Canonical import rule (P1 closeout convergence): owner/creator OR non-owner
  // with FULL visibility + permitted Space role. The shared guard is the single
  // authority; the previously-inlined redundant FULL check (which gated the
  // owner too) was removed so this route cannot disagree with it.
  const { spaceId } = await getSpaceContext();
  const access = await withTenantDb(
    user.id, (tx) => resolveImportableFinancialAccount(tx, user.id, spaceId, id));
  if (!access.ok) return access.response;

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
  //
  // RLS-PREP-C — the gate's reads run on the tenant role, in one phase (pure
  // reads, no network), exactly as the preview route's do.
  const preview = await withTenantDb(user.id, async (tx) => {
    const acct = await tx.financialAccount.findUnique({ where: { id }, select: { institution: true, mask: true } });
    return buildImportPreview({
      csvText: text, profileKey, rowKindOverride,
      financialAccountId: id, connectionInstitution: acct?.institution ?? "", targetMask: acct?.mask ?? null, client: tx,
    });
  }, { timeout: PREVIEW_PHASE_TIMEOUT_MS });
  if (!preview.canCommit) {
    return NextResponse.json({ error: "This file can't be imported into this account.", blockingReasons: preview.blockingReasons, preview }, { status: 422 });
  }
  if (preview.requiresConfirmation && !acknowledged) {
    return NextResponse.json({ error: "Confirm the target before importing.", requiresConfirmation: true, preview }, { status: 409 });
  }

  const pipeline = runInvestmentImportPipelineFromCsv(text, { profileKey, rowKindOverride });

  // ⚠️ NOT CONVERTED, AND SAYING SO. The WRITE still executes as the migration
  // principal. It is passed explicitly — `commitInvestmentImport` no longer has
  // a default to fall into — so this file stays on the authority ratchet for
  // exactly this line. Why it is not a tenant phase yet is recorded on
  // `CommitInput.client`: the instrument resolver and the repair step both write
  // SyncIssue telemetry through the caller's client, and `SyncIssue` is revoked
  // from fm_app. The route is 404 unless INVESTMENT_IMPORTS_ENABLED is set, and
  // it must stay unset on any deployment claiming the RLS boundary until this
  // writer is converted (docs/operations/rls-preview-cutover.md).
  const result = await commitInvestmentImport({
    client: db,
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
