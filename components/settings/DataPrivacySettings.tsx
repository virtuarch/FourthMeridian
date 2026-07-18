"use client";

/**
 * components/settings/DataPrivacySettings.tsx  (UX-1)
 *
 * Data & Privacy page — user data ownership. Surfaces the S6 export as a
 * first-class "Download My Data" card (reusing the existing ExportDataCard —
 * staged during OPS-2 polish for exactly this move — over the unchanged
 * POST /api/user/export endpoint) and keeps the Archive & Trash entry (moved
 * verbatim from the former SettingsClient.tsx). Connections deliberately stay
 * under the existing Connections area; this page is about data & privacy.
 */

import Link from "next/link";
import { Archive, ChevronRight, Download } from "lucide-react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { ExportDataCard } from "@/components/security/ExportDataCard";

export function DataPrivacySettings() {
  return (
    <>
      {/* ── Download My Data ── */}
      <SettingsSection
        icon={Download}
        title="Download My Data"
        description="Export a copy of your personal data — profile, accounts, transactions, and Spaces — as a ZIP archive."
      >
        <ExportDataCard />
      </SettingsSection>

      {/* ── Archive & Trash (cross-link; archived-assets is a separate surface, D4) ── */}
      <SettingsSection
        icon={Archive}
        title="Data & Archive"
        description="Manage archived accounts and Spaces. Restore them, or remove them permanently."
      >
        <Link
          href="/dashboard/settings/archived-assets"
          className="flex items-center justify-between px-4 py-3 rounded-xl border hover:bg-[var(--surface-hover)] transition-colors group"
          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--surface-hover-strong)" }}>
              <Archive size={14} style={{ color: "var(--text-secondary)" }} />
            </div>
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Archive &amp; Trash</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Archived accounts, archived Spaces, and trash</p>
            </div>
          </div>
          <ChevronRight size={15} style={{ color: "var(--text-faint)" }} />
        </Link>
      </SettingsSection>
    </>
  );
}
