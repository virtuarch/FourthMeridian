/**
 * app/merchant-ops/page.tsx  (MI2 S2 — merge review surface)
 *
 * The smallest host-agnostic review surface: a standalone server page — NOT part
 * of the admin panel, NOT a generic operational Space, NOT built from reusable
 * operational widgets. It self-gates on the MERCHANT_OPS platform grant (READ to
 * view; the Merge / Dismiss buttons need WRITE, which the decide route re-checks
 * fresh) and renders the pending candidates. It carries ZERO
 * merchant logic — Merchant Intelligence (getPendingMergeCandidates) owns
 * behaviour; this page only reads and hands the list to a small client component
 * that POSTs verdicts to /api/merchant-ops/decide.
 */

import { redirect } from "next/navigation";
// RLS-C-S6 — fm_system, because this review surface is DEPLOYMENT-WIDE by
// construction: MerchantMergeDecision is revoked from the tenant role, and the
// candidate facts it joins are per-merchant transaction counts across every
// tenant. Under fm_app those counts would silently narrow to the reviewing
// operator's own transactions — a wrong answer, not a refusal. The gate is the
// MERCHANT_OPS platform grant (requirePlatformAccess), which is where the
// authorization for that reach lives. Space membership confers nothing here.
import { systemDb as db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { LEVEL_RANK } from "@/lib/platform/policy";
import { getPendingMergeCandidates } from "@/lib/transactions/merchant-merge-review";
import { MergeReviewList } from "./MergeReviewList";

export const dynamic = "force-dynamic";

export default async function MerchantOpsReviewPage() {
  const [auth, err] = await requirePlatformAccess("MERCHANT_OPS", "READ");
  if (err) redirect("/dashboard"); // no MERCHANT_OPS grant → out
  // SYSTEM_ADMIN break-glass carries no grant row; it may decide.
  const canDecide = auth.grant === null || LEVEL_RANK[auth.grant.level] >= LEVEL_RANK.WRITE;

  const candidates = await getPendingMergeCandidates(db);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-lg font-semibold">Merchant Merge Review</h1>
      <p className="mt-1 text-sm text-gray-500">
        {candidates.length === 0
          ? "No pending merge candidates."
          : `${candidates.length} pending candidate${candidates.length === 1 ? "" : "s"} — every merge is a human decision.`}
      </p>
      {!canDecide && (
        <p className="mt-1 text-xs text-gray-500">
          Read-only: merging or dismissing requires a Merchant Operations WRITE grant.
        </p>
      )}
      <div className="mt-4">
        <MergeReviewList candidates={candidates} canDecide={canDecide} />
      </div>
    </main>
  );
}
