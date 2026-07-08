/**
 * app/merchant-ops/page.tsx  (MI2 S2 — merge review surface)
 *
 * The smallest host-agnostic review surface: a standalone server page — NOT part
 * of the admin panel, NOT a generic operational Space, NOT built from reusable
 * operational widgets. It self-gates on Merchant Operations Space membership (the
 * ratified refinement) and renders the pending candidates. It carries ZERO
 * merchant logic — Merchant Intelligence (getPendingMergeCandidates) owns
 * behaviour; this page only reads and hands the list to a small client component
 * that POSTs verdicts to /api/merchant-ops/decide.
 */

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireMerchantOpsMember } from "@/lib/merchant-ops-access";
import { getPendingMergeCandidates } from "@/lib/transactions/merchant-merge-review";
import { MergeReviewList } from "./MergeReviewList";

export const dynamic = "force-dynamic";

export default async function MerchantOpsReviewPage() {
  const [, err] = await requireMerchantOpsMember();
  if (err) redirect("/dashboard"); // not a Merchant Operations member → out

  const candidates = await getPendingMergeCandidates(db);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-lg font-semibold">Merchant Merge Review</h1>
      <p className="mt-1 text-sm text-gray-500">
        {candidates.length === 0
          ? "No pending merge candidates."
          : `${candidates.length} pending candidate${candidates.length === 1 ? "" : "s"} — every merge is a human decision.`}
      </p>
      <div className="mt-4">
        <MergeReviewList candidates={candidates} />
      </div>
    </main>
  );
}
