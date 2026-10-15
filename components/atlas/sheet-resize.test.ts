import assert from "node:assert/strict";
import { nearestSheetSnap } from "./SheetHandle";

assert.equal(nearestSheetSnap(35), 45);
assert.equal(nearestSheetSnap(50), 45);
assert.equal(nearestSheetSnap(66), 70);
assert.equal(nearestSheetSnap(80), 70);
assert.equal(nearestSheetSnap(88), 92);
assert.equal(nearestSheetSnap(120), 92);
console.log("Sheet snap selection clamps extremes and chooses the nearest stable height.");
