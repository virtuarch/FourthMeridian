/**
 * lib/export/zip.ts  (OPS-2 S6)
 *
 * Server-only. Bundles an assembled ExportData into a single ZIP:
 *   manifest.json, data.json, transactions.csv, accounts.csv, holdings.csv,
 *   snapshots.csv
 * (approved decision D1). Uses jszip; generation is synchronous at beta scale
 * (no background job — approved).
 */

import "server-only";
import JSZip from "jszip";
import type { ExportData } from "@/lib/export/types";
import {
  toAccountsCsv,
  toHoldingsCsv,
  toSnapshotsCsv,
  toTransactionsCsv,
} from "@/lib/export/csv";

/** Build the export ZIP as a Node Buffer ready to stream in a Response. */
export async function buildExportZip(data: ExportData): Promise<Buffer> {
  const zip = new JSZip();

  // manifest.json + data.json are always present; each tabular CSV is written
  // only when assemble.ts listed it in manifest.files (i.e. it has rows), so no
  // empty CSV ever ships. data.json still carries every section for stability.
  const include = (name: string) => data.manifest.files.includes(name);

  zip.file("manifest.json", JSON.stringify(data.manifest, null, 2));
  zip.file("data.json", JSON.stringify(data, null, 2));
  if (include("transactions.csv")) zip.file("transactions.csv", toTransactionsCsv(data.transactions));
  if (include("accounts.csv"))     zip.file("accounts.csv", toAccountsCsv(data.accounts));
  if (include("holdings.csv"))     zip.file("holdings.csv", toHoldingsCsv(data.holdings));
  if (include("snapshots.csv"))    zip.file("snapshots.csv", toSnapshotsCsv(data.snapshots));

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
