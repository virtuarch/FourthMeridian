/**
 * lib/investments/import-upload-guard.ts
 *
 * A7-6 — cheap, pre-parse upload guards shared by the preview and commit routes:
 * a size ceiling and an extension guard, so obviously-wrong uploads (a PDF, an
 * image, a huge file) are rejected before we spend effort parsing. Content-based
 * rejection (wrong provider, non-investment, malformed) is the safety core's job
 * (import-validation); this only catches the coarse cases with a clear message.
 */

/** 15 MB — comfortably above a multi-thousand-row brokerage CSV, below abuse. */
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

export type UploadGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

const CSV_LIKE = [".csv", ".txt", ".tsv"];
const SPREADSHEET = [".xlsx", ".xls"];

/** Guard a File by size and extension. Never reads content. */
export function guardImportUpload(file: File): UploadGuardResult {
  if (file.size === 0) return { ok: false, status: 400, error: "This file is empty." };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, status: 413, error: "This file is too large to import (limit 15 MB)." };

  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";

  if (SPREADSHEET.includes(ext)) {
    return { ok: false, status: 415, error: "Excel import for investments isn't supported yet — export your history as CSV and try again." };
  }
  if (ext && !CSV_LIKE.includes(ext)) {
    return { ok: false, status: 415, error: `Unsupported file type "${ext}". Upload a CSV export of your investment history.` };
  }
  return { ok: true };
}
