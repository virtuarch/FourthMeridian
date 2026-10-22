/**
 * lib/imports/zip-bounds.ts  (IDEMP-001 d · SEC-007)
 *
 * An .xlsx is a zip. ExcelJS inflates every part into memory before a single
 * row is read, so the 10 MB upload cap bounds the COMPRESSED size only: a
 * 10 MB zip can claim gigabytes once inflated (a "zip bomb"), and a cron-sized
 * lambda would die on it. This reads the zip's own table of contents — the
 * End Of Central Directory record and the central directory entries, which
 * carry each part's uncompressed size — WITHOUT inflating anything, and
 * refuses a workbook whose declared inflated size or part count exceeds the
 * cap. The declared sizes are what the inflater will honour, so lying in the
 * directory does not help an attacker: an under-declared entry still inflates
 * to its true size, which is why the cap is enforced on the DECLARED total
 * AND the loader is only reached by files that pass it.
 *
 * ZIP64 (sizes 0xFFFFFFFF, "needs the zip64 record") is refused outright: no
 * legitimate bank statement needs a 4 GB part.
 *
 * Pure, dependency-free, testable with hand-built bytes.
 */

/** Inflated-size cap for an XLSX upload. 64 MB is ~10× any statement that fits the row cap. */
export const IMPORT_MAX_XLSX_INFLATED_BYTES = 64 * 1024 * 1024;
/** Part-count cap — a bank export has a dozen parts; thousands is an attack. */
export const IMPORT_MAX_XLSX_PARTS = 512;

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const EOCD_MIN = 22;
const ZIP64_MARK = 0xffffffff;

export interface ZipBounds {
  parts: number;
  inflatedBytes: number;
}

export type ZipBoundsResult =
  | { ok: true; bounds: ZipBounds }
  | { ok: false; reason: "not-a-zip" | "truncated" | "zip64" | "too-many-parts" | "too-large"; bounds?: ZipBounds };

/** Read the central directory and total the declared uncompressed sizes. */
export function readZipBounds(
  bytes: Uint8Array,
  caps: { maxInflatedBytes?: number; maxParts?: number } = {},
): ZipBoundsResult {
  const maxInflated = caps.maxInflatedBytes ?? IMPORT_MAX_XLSX_INFLATED_BYTES;
  const maxParts = caps.maxParts ?? IMPORT_MAX_XLSX_PARTS;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < EOCD_MIN) return { ok: false, reason: "not-a-zip" };

  // The EOCD record is at the end, followed only by its (≤ 65535-byte) comment.
  const searchFloor = Math.max(0, bytes.length - EOCD_MIN - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - EOCD_MIN; i >= searchFloor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, reason: "not-a-zip" };

  const entriesTotal = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entriesTotal === 0xffff || cdSize === ZIP64_MARK || cdOffset === ZIP64_MARK) return { ok: false, reason: "zip64" };
  if (entriesTotal > maxParts) return { ok: false, reason: "too-many-parts", bounds: { parts: entriesTotal, inflatedBytes: 0 } };
  if (cdOffset + cdSize > bytes.length) return { ok: false, reason: "truncated" };

  let p = cdOffset;
  let inflated = 0;
  for (let n = 0; n < entriesTotal; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CDH_SIG) return { ok: false, reason: "truncated" };
    const uncompressed = view.getUint32(p + 24, true);
    if (uncompressed === ZIP64_MARK) return { ok: false, reason: "zip64" };
    inflated += uncompressed;
    if (inflated > maxInflated) return { ok: false, reason: "too-large", bounds: { parts: n + 1, inflatedBytes: inflated } };
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, bounds: { parts: entriesTotal, inflatedBytes: inflated } };
}
