"use client";

/**
 * BriefNewUser
 *
 * The Brief's empty state — shown when the user has no accounts/assets yet.
 * Editorial (v2.5): a solid Atlas Surface with an honest, no-fake-numbers
 * invitation to build the picture, matching the reading language of the rest
 * of the Brief. No cinematic backdrop, no glass.
 */

import Link from "next/link";
import { Globe, Link2, PlusCircle } from "lucide-react";
import { Surface } from "@/components/atlas/Surface";

export function BriefNewUser() {
  return (
    <Surface className="p-8 sm:p-10">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-[var(--radius-md)] border border-[rgba(125,168,255,.24)] bg-[rgba(125,168,255,.10)]">
          <Globe className="size-6 text-[var(--meridian-400)]" />
        </div>
        <h2 className="mb-2 text-lg font-semibold text-[var(--text-primary)]">
          Let&apos;s build your financial picture
        </h2>
        <p className="mb-7 text-sm leading-relaxed text-[var(--text-secondary)]">
          Connect accounts and add assets to see your real net worth, track trends over time, and unlock personalized insights.
        </p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/dashboard/connections"
            className="flex items-center justify-center gap-2 rounded-[var(--radius-sm)] px-6 py-3 text-sm font-semibold text-[var(--ink-0)] transition-transform duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            style={{ background: "var(--meridian-600)", boxShadow: "0 6px 18px rgba(37,99,235,.35)" }}
          >
            <Link2 className="size-4" />
            Connect an Account
          </Link>
          <Link
            href="/dashboard/connections"
            className="flex items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-6 py-3 text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
          >
            <PlusCircle className="size-4" />
            Add Manual Asset
          </Link>
        </div>
      </div>
    </Surface>
  );
}
