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
 *
 * Layout (owner review, 2026-10-31): Back to Merchant Operations → purpose (what a
 * candidate is, what Merge / Not the same do) → summary strip (pending count, by
 * tier, access level) → candidate cards (evidence, Keep vs Absorb) → decisions in
 * a confirm dialog with the required reason. The page sits outside the app shell,
 * so its own Back link is the exit path at every width.
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
import { OPERATOR_TOTP_ENROLMENT_PATH, isOperatorTotpRefusal, requirePlatformAccess } from "@/lib/platform/authorize";
import { LEVEL_RANK } from "@/lib/platform/policy";
import { getPendingMergeCandidates } from "@/lib/transactions/merchant-merge-review";
import { MergeReviewList } from "./MergeReviewList";
import { EmptyReview, ReviewHeader, ReviewSummaryStrip } from "./ReviewChrome";
import { summarize } from "./review-model";

export const dynamic = "force-dynamic";

export default async function MerchantOpsReviewPage() {
  const [auth, err] = await requirePlatformAccess("MERCHANT_OPS", "READ");
  if (err && isOperatorTotpRefusal(err)) redirect(OPERATOR_TOTP_ENROLMENT_PATH); // SEC-PLAT-1 — grant held, TOTP missing
  if (err) redirect("/dashboard"); // no MERCHANT_OPS grant → out
  // SYSTEM_ADMIN break-glass carries no grant row; it may decide.
  const canDecide = auth.grant === null || LEVEL_RANK[auth.grant.level] >= LEVEL_RANK.WRITE;

  const candidates = await getPendingMergeCandidates(db);
  const summary = summarize(candidates);

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-4 py-6 sm:px-6">
      <ReviewHeader />
      <ReviewSummaryStrip summary={summary} canDecide={canDecide} />
      {/* Always mounted, so the outcome line survives the refresh that empties the list. */}
      <MergeReviewList candidates={candidates} canDecide={canDecide} empty={<EmptyReview />} />
    </main>
  );
}
