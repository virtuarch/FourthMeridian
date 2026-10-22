/**
 * lib/imports/zip-bounds.test.ts  (IDEMP-001 d · SEC-007)
 *
 * The XLSX inflated-size gate, over hand-built zip bytes and one real
 * workbook. Standalone tsx (house pattern):
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/imports/zip-bounds.test.ts
 */

import ExcelJS from "exceljs";
import { readZipBounds, IMPORT_MAX_XLSX_INFLATED_BYTES, IMPORT_MAX_XLSX_PARTS } from "@/lib/imports/zip-bounds";
import { parseExcelFile } from "@/lib/imports/excel";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Build a minimal zip whose central directory DECLARES the given per-entry uncompressed sizes. */
function fakeZip(entries: Array<{ name: string; uncompressed: number }>, opts: { zip64?: boolean; lieAboutCount?: number } = {}): Uint8Array {
  const cd: number[] = [];
  const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  for (const e of entries) {
    const name = [...Buffer.from(e.name)];
    cd.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(8), ...le16(0), ...le16(0), ...le32(0),
      ...le32(10), ...le32(opts.zip64 ? 0xffffffff : e.uncompressed), ...le16(name.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...name);
  }
  const count = opts.lieAboutCount ?? entries.length;
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(count), ...le16(count), ...le32(cd.length), ...le32(0), ...le16(0)];
  return new Uint8Array([...cd, ...eocd]);
}

async function main() {
  console.log("hand-built zips");
  {
    const small = readZipBounds(fakeZip([{ name: "xl/workbook.xml", uncompressed: 1000 }, { name: "xl/worksheets/sheet1.xml", uncompressed: 5000 }]));
    check("a small workbook passes with its declared totals", small.ok && small.bounds.parts === 2 && small.bounds.inflatedBytes === 6000);
    const bomb = readZipBounds(fakeZip([{ name: "a", uncompressed: 0x7fffffff }, { name: "b", uncompressed: 0x7fffffff }]));
    check("a zip bomb (two 2 GB parts in a few hundred bytes) is refused as too-large", !bomb.ok && bomb.reason === "too-large");
    const justOver = readZipBounds(fakeZip([{ name: "a", uncompressed: IMPORT_MAX_XLSX_INFLATED_BYTES + 1 }]));
    check("one byte over the cap is refused", !justOver.ok && justOver.reason === "too-large");
    const atCap = readZipBounds(fakeZip([{ name: "a", uncompressed: IMPORT_MAX_XLSX_INFLATED_BYTES }]));
    check("exactly the cap passes", atCap.ok);
    const many = readZipBounds(fakeZip([{ name: "a", uncompressed: 1 }], { lieAboutCount: IMPORT_MAX_XLSX_PARTS + 1 }));
    check("too many declared parts is refused before any entry is read", !many.ok && many.reason === "too-many-parts");
    const z64 = readZipBounds(fakeZip([{ name: "a", uncompressed: 1 }], { zip64: true }));
    check("a ZIP64 size marker is refused", !z64.ok && z64.reason === "zip64");
    check("random bytes are not a zip", !readZipBounds(new Uint8Array(100)).ok);
    check("a truncated directory is refused", !readZipBounds(fakeZip([{ name: "a", uncompressed: 1 }], { lieAboutCount: 3 }).slice(0)).ok);
    const custom = readZipBounds(fakeZip([{ name: "a", uncompressed: 10 }]), { maxInflatedBytes: 5 });
    check("caps are injectable", !custom.ok && custom.reason === "too-large");
  }

  console.log("\na real workbook");
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Date", "Description", "Amount"]);
    ws.addRow(["2026-10-01", "Coffee", -4.5]);
    ws.addRow(["2026-10-02", "Salary", 1000]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = readZipBounds(buf);
    check("ExcelJS output is recognised with a plausible inflated size", r.ok && r.bounds.parts >= 5 && r.bounds.inflatedBytes > buf.length / 4);
    const parsed = await parseExcelFile(buf, "creditPositive");
    check("the real parser still imports it (the gate sits before the loader)", !("error" in parsed) && parsed.rows.length === 2, "error" in parsed ? parsed.error : "");
    const bombParsed = await parseExcelFile(Buffer.from(fakeZip([{ name: "a", uncompressed: 0x7fffffff }])), "creditPositive");
    check("the real parser refuses a bomb with a size message, never reaching ExcelJS", "error" in bombParsed && /too large/.test(bombParsed.error));
  }

  if (failures > 0) { console.error(`\n❌ zip bounds: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ zip bounds: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
