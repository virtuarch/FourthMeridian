"use client";

/**
 * BriefNewUser
 *
 * Shown inside the card grid when the user has no accounts/assets.
 * Glass-consistent with the other cards. No fake numbers.
 */

import Link from "next/link";
import { Globe, Link2, PlusCircle } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";

export function BriefNewUser() {
  return (
    <GlassPanel
      depth="thin"
      elevation="e2"
      radius="lg"
      glow="meridian"
      className="col-span-full p-8 md:p-10"
    >
      <div className="max-w-md mx-auto text-center">
        <div className="w-12 h-12 rounded-[var(--radius-md)] bg-[var(--meridian-500)]/10 border border-[var(--meridian-500)]/20 flex items-center justify-center mx-auto mb-5">
          <Globe className="w-6 h-6 text-[var(--meridian-400)]" />
        </div>
        <h2 className="text-lg font-bold text-[var(--text-primary)] mb-2">
          Let&apos;s build your financial picture
        </h2>
        <p className="text-sm text-[var(--text-muted)] mb-7 leading-relaxed">
          Connect accounts and add assets to see your real net worth, track trends over time, and unlock personalized insights.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/dashboard/accounts"
            className="flex items-center justify-center gap-2 py-3 px-6 text-[var(--ink-0)] text-sm font-semibold transition-all duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            style={{
              borderRadius: "var(--radius-sm)",
              background: "var(--meridian-600)",
              boxShadow: "0 6px 18px rgba(37,99,235,.35)",
            }}
          >
            <Link2 className="w-4 h-4" />
            Connect an Account
          </Link>
          <GlassPanel
            as={Link}
            href="/dashboard/accounts"
            depth="thin"
            radius="sm"
            elevation="e1"
            interactive
            className="flex items-center justify-center gap-2 py-3 px-6 text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
          >
            <PlusCircle className="w-4 h-4" />
            Add Manual Asset
          </GlassPanel>
        </div>
      </div>
    </GlassPanel>
  );
}
