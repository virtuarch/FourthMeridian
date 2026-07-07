/**
 * components/security/downloadDataExport.ts  (OPS-2 polish)
 *
 * Shared client helper: triggers the S6 personal-data export
 * (POST /api/user/export) and streams the returned ZIP to a browser download.
 * Used by BOTH the standalone "Download my data" Settings entry and the
 * Delete-account "export first" button, so the export wiring lives in exactly
 * one place (no duplicated logic, no endpoint change). Callers own their own
 * loading/error UI; this returns a plain result.
 */

export type DownloadResult = { ok: true } | { ok: false; error: string };

export async function downloadDataExport(): Promise<DownloadResult> {
  try {
    const res = await fetch("/api/user/export", { method: "POST" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? "Couldn't export your data. Please try again." };
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `fourth-meridian-export-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch {
    return { ok: false, error: "Something went wrong exporting your data. Please try again." };
  }
}
