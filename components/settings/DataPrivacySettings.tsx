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
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { ExportDataCard } from "@/components/security/ExportDataCard";

export function DataPrivacySettings() {
  return (
    <>
      {/* ── Download My Data ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Download size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Download My Data</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Export a copy of your personal data — profile, accounts, transactions,
          and Spaces — as a ZIP archive.
        </p>
        <ExportDataCard />
      </DataCard>

      {/* ── Archive & Trash (moved verbatim) ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Archive size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Data &amp; Archive</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Manage archived accounts and Spaces. Restore them, or remove them permanently.
        </p>

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
      </DataCard>
    </>
  );
}
