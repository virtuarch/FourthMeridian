/**
 * lib/crypto/btc-discovery-core.test.ts
 *
 * Wallet Provider v4 — resumable, bounded xpub discovery (pure core), including a
 * BEHEMOTH wallet (hundreds of used addresses) proven to progress across many
 * runs without duplicating identities.
 *   npx tsx lib/crypto/btc-discovery-core.test.ts
 */

import {
  readDiscoveryCursor,
  planXpubStep,
  applyXpubStep,
  type DiscoveryCursor,
} from "@/lib/crypto/btc-discovery-core";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// Deterministic "derivation": address = `${branch}:${index}`.
const deriveAt = (b: number, i: number) => `${b}:${i}`;

// ── cursor parsing ─────────────────────────────────────────────────────────────
check("readDiscoveryCursor: null → fresh", JSON.stringify(readDiscoveryCursor(null)) === JSON.stringify({ r: 0, c: 0, ur: 0, uc: 0, rDone: false, cDone: false, used: 0 }));
check("readDiscoveryCursor: invalid → fresh", readDiscoveryCursor("not json").r === 0);
check("readDiscoveryCursor: round-trips a real checkpoint",
  readDiscoveryCursor(JSON.stringify({ r: 50, c: 20, ur: 3, uc: 20, rDone: false, cDone: true })).c === 20);

// ── bounded plan ────────────────────────────────────────────────────────────────
const plan0 = planXpubStep(deriveAt, readDiscoveryCursor(null), 50);
check("planXpubStep: ≤ step per branch (bounded)", plan0.filter((p) => p.branch === 0).length === 50 && plan0.length === 100);
const planDone = planXpubStep(deriveAt, { r: 0, c: 0, ur: 0, uc: 0, rDone: true, cDone: false, used: 0 }, 50);
check("planXpubStep: skips a done branch", planDone.every((p) => p.branch === 1) && planDone.length === 50);

// ── gap rule ────────────────────────────────────────────────────────────────────
const emptyRun = applyXpubStep(readDiscoveryCursor(null), planXpubStep(deriveAt, readDiscoveryCursor(null), 50), () => false, 20);
check("applyXpubStep: all-unused branch completes at the gap", emptyRun.complete && emptyRun.cursor.rDone && emptyRun.cursor.cDone);
check("applyXpubStep: empty wallet persists nothing", emptyRun.toPersist.length === 0);
check("applyXpubStep: valid-but-empty key → complete with used=0 (drives wrong-type guidance)",
  emptyRun.complete && emptyRun.cursor.used === 0);

// ── BEHEMOTH: receive used at indices 0..299 (change empty) ────────────────────
const USED = new Set<string>();
for (let i = 0; i < 300; i++) USED.add(`0:${i}`); // 300 used receive addresses
const isUsed = (a: string) => USED.has(a);
const GAP = 20, STEP = 50;

let cursor: DiscoveryCursor = readDiscoveryCursor(null);
const persisted = new Set<string>();
const perRunReceiveScan: number[] = [];
let runs = 0, complete = false;
while (!complete && runs < 100) {
  runs += 1;
  const beforeR = cursor.r;
  const plan = planXpubStep(deriveAt, cursor, STEP);
  const res = applyXpubStep(cursor, plan, isUsed, GAP);
  for (const p of res.toPersist) persisted.add(p.address);
  perRunReceiveScan.push(res.cursor.r - beforeR);
  cursor = res.cursor;
  complete = res.complete;
}

check("behemoth: completes across MULTIPLE runs (staged, not one-shot)", complete && runs > 1, `runs=${runs}`);
check("behemoth: bounded — each run advances receive by ≤ step", perRunReceiveScan.every((d) => d <= STEP));
check("behemoth: all 300 used receive addresses discovered",
  Array.from({ length: 300 }, (_, i) => persisted.has(`0:${i}`)).every(Boolean));
check("behemoth: NO duplicate identities (unique persisted = used count)", persisted.size === 300);
check("behemoth: cumulative used-count tracked across runs (=300)", cursor.used === 300);
check("behemoth: change branch (unused) completed", cursor.cDone);

// Idempotent resume: a completed checkpoint yields no new work.
const afterPlan = planXpubStep(deriveAt, cursor, STEP);
const afterRes = applyXpubStep(cursor, afterPlan, isUsed, GAP);
check("behemoth: completed checkpoint → no new addresses (resumable + idempotent)",
  afterPlan.length === 0 && afterRes.toPersist.length === 0 && afterRes.complete);

console.log(`\nbtc-discovery-core: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
