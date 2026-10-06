"use client";

/**
 * components/platform/widgets/MerchantReviewWidget.tsx  (MERCHANT_OPS · merchant_review)
 *
 * The Merchant Operations workspace's one section: a doorway to the merge review
 * at /merchant-ops. It reads nothing and decides nothing — the review page gates
 * itself on the MERCHANT_OPS platform grant (READ to view, fresh WRITE to merge or
 * dismiss), and the merge engine owns all behaviour.
 */

import Link from "next/link";
import type { PlatformSection } from "../widget-kit";

export function MerchantReviewWidget({ section }: { section: PlatformSection }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{section.label}</h3>
      <p className="text-sm text-[var(--text-muted)]">
        Review candidate duplicate merchants detected across the platform. A merge
        rewrites merchant identity for every tenant and is recorded in the audit log
        with enough state to restore it by hand.
      </p>
      <Link href="/merchant-ops" className="inline-block text-sm font-medium underline">
        Open merge review
      </Link>
    </div>
  );
}
