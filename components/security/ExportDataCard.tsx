"use client";

/**
 * components/security/ExportDataCard.tsx  (OPS-2 polish)
 *
 * Standalone "Download my data" entry for the Security Center. A thin,
 * temporary entry point so the export (S6) isn't buried inside Delete Account;
 * the later Settings architecture refactor moves this into Data & Privacy.
 *
 * Presentation only — reuses the shared downloadDataExport() helper and the
 * existing POST /api/user/export endpoint. No export logic is duplicated.
 */

import { useState } from "react";
import { Loader2, Download } from "lucide-react";
import { downloadDataExport } from "@/components/security/downloadDataExport";

export function ExportDataCard() {
  const [exporting, setExporting] = useState(false);
  const [error,     setError]     = useState("");

  async function handleDownload() {
    if (exporting) return;
    setExporting(true);
    setError("");
    const result = await downloadDataExport();
    if (!result.ok) setError(result.error);
    setExporting(false);
  }

  return (
    <div className="space-y-3">
      {error && (
        <div
          className="rounded-xl border px-3 py-2.5 text-sm"
          style={{ background: "rgba(237,82,71,0.10)", borderColor: "rgba(237,82,71,0.30)", color: "var(--accent-negative)" }}
        >
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={handleDownload}
        disabled={exporting}
        className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl border transition-colors disabled:opacity-50"
        style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}
      >
        {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        Download my data
      </button>
    </div>
  );
}
