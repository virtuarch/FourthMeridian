/**
 * components/space/widgets/shared/CalendarHeatmapGrid.test.ts
 *
 * Fixture tests for the metric-agnostic calendar primitive's pure helpers
 * (extracted from CashFlowCalendar). Day-cell tinting, tooltip placement, and
 * full/mini sizing — all independent of any domain axis. Pure, DB-free.
 *
 *   npx tsx --test components/space/widgets/shared/CalendarHeatmapGrid.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  cellBg,
  cellText,
  tooltipPlacement,
  heatmapSize,
  heatmapGridCls,
} from "./CalendarHeatmapGrid";

test("cellBg: zero / no-scale days are the neutral inset (never a colored zero)", () => {
  assert.equal(cellBg(0, 100), "var(--surface-inset)");
  assert.equal(cellBg(50, 0), "var(--surface-inset)");   // max <= 0
  assert.equal(cellBg(0, 0), "var(--surface-inset)");
});

test("cellBg: positive green / negative red, alpha scaled and clamped to the period max", () => {
  // alpha = 0.14 + 0.5 * min(1, |net|/max)
  assert.equal(cellBg(50, 100), "rgba(34,197,94,0.390)");    // 0.14 + 0.5*0.5
  assert.equal(cellBg(-50, 100), "rgba(239,68,68,0.390)");
  assert.equal(cellBg(200, 100), "rgba(34,197,94,0.640)");   // ratio clamped at 1 → 0.64
  assert.equal(cellBg(100, 100), "rgba(34,197,94,0.640)");
});

test("cellText: muted for zero / weak cells, brightened hue-matched for strong cells", () => {
  assert.equal(cellText(0, 100), "var(--text-muted)");
  assert.equal(cellText(50, 0), "var(--text-muted)");        // max <= 0
  assert.equal(cellText(30, 100), "var(--text-muted)");      // intensity 0.3 < 0.4
  assert.equal(cellText(50, 100), "rgb(134,239,172)");       // intensity 0.5, positive → green-300
  assert.equal(cellText(-50, 100), "rgb(252,165,165)");      // negative → red-300
});

test("tooltipPlacement: flips below on the top row, anchors to the outer columns", () => {
  assert.equal(tooltipPlacement(0, 0), "top-full mt-1 left-0");
  assert.equal(tooltipPlacement(3, 0), "top-full mt-1 left-1/2 -translate-x-1/2");
  assert.equal(tooltipPlacement(6, 1), "bottom-full mb-1 right-0");
  assert.equal(tooltipPlacement(1, 2), "bottom-full mb-1 left-0");
  assert.equal(tooltipPlacement(5, 3), "bottom-full mb-1 right-0");
});

test("heatmapSize: one month is full, multi-month is mini", () => {
  assert.equal(heatmapSize(1), "full");
  assert.equal(heatmapSize(0), "full");
  assert.equal(heatmapSize(2), "mini");
  assert.equal(heatmapSize(12), "mini");
});

test("heatmapGridCls: responsive column count keyed to the visible month count", () => {
  assert.equal(heatmapGridCls(1), "grid-cols-1");
  assert.equal(heatmapGridCls(3), "grid-cols-1 sm:grid-cols-3");
  assert.equal(heatmapGridCls(4), "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4");
  assert.equal(heatmapGridCls(12), "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4");
});
