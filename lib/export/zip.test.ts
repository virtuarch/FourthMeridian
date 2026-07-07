/**
 * lib/export/zip.test.ts  (OPS-2 polish)
 *
 * Guards that buildExportZip omits empty tabular CSVs (it writes only the files
 * assemble.ts listed in manifest.files) while data.json + manifest.json always
 * ship. Standalone tsx script:
 *
 *     npx tsx lib/export/zip.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import JSZip from "jszip";
import { buildExportZip } from "@/lib/export/zip";
import type { ExportData } from "@/lib/export/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Minimal ExportData whose manifest.files reflects the "only non-empty sections"
// rule assemble.ts applies. buildExportZip must honour exactly that list.
function fixture(over: Partial<ExportData> & { files: string[] }): ExportData {
  const { files, ...rest } = over;
  return {
    manifest: {
      app: "fourth-meridian", kind: "personal-data-export", schemaVersion: "1.0",
      generatedAt: "2026-07-07T00:00:00.000Z", userId: "u1", files,
      counts: {}, truncated: false, notes: [],
    },
    profile: {}, settings: {},
    security: { totpEnabled: false, sessions: [], recoveryCodes: [] },
    spaces: [],
    accounts: [], connections: { accountConnections: [], plaidItems: [], connections: [] },
    transactions: [], holdings: [], snapshots: [],
    creditHistory: [], goals: [], auditHistory: [],
    imports: { batches: [], mappingProfiles: [] }, aiAdvice: [],
    ...rest,
  } as ExportData;
}

async function namesOf(data: ExportData): Promise<string[]> {
  const buf = await buildExportZip(data);
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files);
}

async function main() {
  console.log("export/zip");

  // No holdings / no snapshots — only transactions present.
  const lean = fixture({
    files: ["manifest.json", "data.json", "transactions.csv", "accounts.csv"],
    transactions: [{ id: "t1", accountId: "a1", spaceId: "s1", date: "2026-03-01", merchant: "X", description: "", category: "Dining", amount: -1, pending: false, currency: "USD" }] as unknown as ExportData["transactions"],
    accounts: [{ id: "a1", name: "Checking", type: "checking", institution: "Chase", balance: 1, currency: "USD", lastUpdated: "2026-03-01T00:00:00.000Z", spaceId: "s1", spaceName: "Personal" }] as unknown as ExportData["accounts"],
  });
  const leanNames = await namesOf(lean);
  check("always includes manifest.json + data.json", leanNames.includes("manifest.json") && leanNames.includes("data.json"));
  check("includes transactions.csv when present", leanNames.includes("transactions.csv"));
  check("OMITS holdings.csv when empty", !leanNames.includes("holdings.csv"));
  check("OMITS snapshots.csv when empty", !leanNames.includes("snapshots.csv"));

  // With holdings present, holdings.csv ships.
  const withHoldings = fixture({
    files: ["manifest.json", "data.json", "holdings.csv"],
    holdings: [{ id: "h1", accountId: "a2", symbol: "VTI", name: "Vanguard", quantity: 1, price: 1, value: 1, change24h: 0, isCash: false, currency: "USD", spaceId: "s1" }] as unknown as ExportData["holdings"],
  });
  const holdNames = await namesOf(withHoldings);
  check("includes holdings.csv when present", holdNames.includes("holdings.csv"));

  console.log(failures === 0 ? "\nAll export/zip checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
