/**
 * lib/charts/chart-palette.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). Unlike the source-scan
 * guards elsewhere, this module is PURE — so these are real behavioural
 * assertions, which is the only way to prove the property that matters:
 *
 *   colour depends on the SET of IDs, never on their order or position.
 *
 * The regression these lock down is concrete: value-descending sorts plus
 * zero-value filtering meant an index-assigned palette named a RANK, not a
 * thing — so a portfolio without crypto drew "Real assets" in crypto's amber,
 * disagreeing with the treemap/strip modes that pin class colours.
 *
 *   npx tsx lib/charts/chart-palette.test.ts
 */

import {
  CHART_PALETTE,
  WEALTH_CLASS_COLOR,
  assignStableColors,
  preferredSlot,
} from "./chart-palette";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  console.log("palette shape");
  check("eight distinct hues", new Set(CHART_PALETTE).size === 8);
  check("every entry is a hex colour", CHART_PALETTE.every((c) => /^#[0-9a-f]{6}$/i.test(c)));

  console.log("order independence — the core property");
  const ids = ["chase", "vanguard", "ally", "fidelity", "schwab"];
  const forward = assignStableColors(ids);
  const reversed = assignStableColors([...ids].reverse());
  check(
    "reversing input order does not change any item's colour",
    ids.every((id, i) => forward[i] === reversed[reversed.length - 1 - i]),
  );

  const shuffled = ["schwab", "chase", "fidelity", "ally", "vanguard"];
  const shuffledColors = assignStableColors(shuffled);
  check(
    "arbitrary reordering does not change any item's colour",
    shuffled.every((id, i) => shuffledColors[i] === forward[ids.indexOf(id)]),
  );

  console.log("set stability — and its documented bound");
  // The bound: stability holds for ids that do not share a preferred slot. Two
  // colliding ids DO trade colours when one leaves (the survivor reclaims its
  // preference). Still strictly better than index assignment, where removing the
  // FIRST item recoloured EVERY item after it.
  const nonContending = ["chase", "ally", "vanguard"];
  check(
    "fixture ids genuinely do not contend",
    new Set(nonContending.map(preferredSlot)).size === nonContending.length,
  );
  const beforeDrop = assignStableColors(nonContending);
  const afterDrop = assignStableColors(["chase", "vanguard"]);
  check(
    "a survivor keeps its colour when a non-contending sibling leaves",
    afterDrop[1] === beforeDrop[2] && afterDrop[0] === beforeDrop[0],
  );
  // Prove the limit is real rather than pretending it away: find a colliding
  // pair and assert the documented behaviour explicitly.
  const probe = Array.from({ length: 200 }, (_, i) => `probe-${i}`);
  const bySlot = new Map<number, string[]>();
  for (const id of probe) {
    const s = preferredSlot(id);
    bySlot.set(s, [...(bySlot.get(s) ?? []), id]);
  }
  const colliding = [...bySlot.values()].find((g) => g.length >= 2);
  check("a colliding pair exists to test against", colliding != null);
  if (colliding) {
    const [a, b] = colliding;
    const together = assignStableColors([a, b]);
    const bAlone = assignStableColors([b])[0];
    const loser = together[0] === CHART_PALETTE[preferredSlot(a)] ? 1 : 0;
    check(
      "a displaced id reclaims its preferred colour once the contender leaves (documented limit)",
      loser === 1 ? bAlone !== together[1] : bAlone === together[1],
      `together=${together.join()} bAlone=${bAlone}`,
    );
  }

  console.log("distinctness");
  check(
    "≤ 8 distinct ids all receive distinct colours",
    new Set(assignStableColors(["a", "b", "c", "d", "e", "f", "g", "h"])).size === 8,
  );
  const many = Array.from({ length: 24 }, (_, i) => `id-${i}`);
  const manyColors = assignStableColors(many);
  const counts = new Map<string, number>();
  for (const c of manyColors) counts.set(c, (counts.get(c) ?? 0) + 1);
  check(
    "> 8 ids reuse slots EVENLY rather than cycling (24 ids ⇒ 3 each)",
    [...counts.values()].every((n) => n === 3),
    `got ${JSON.stringify([...counts.values()])}`,
  );

  console.log("duplicates and edges");
  const dup = assignStableColors(["x", "x", "y"]);
  check("duplicate ids collapse to one colour", dup[0] === dup[1]);
  check("distinct id still differs", dup[2] !== dup[0]);
  check("empty input returns empty", assignStableColors([]).length === 0);
  check("single id is valid", assignStableColors(["solo"]).length === 1);

  console.log("determinism");
  check(
    "repeated calls agree",
    assignStableColors(ids).join() === assignStableColors(ids).join(),
  );
  check(
    "hash slot is in range for varied keys",
    ["", "a", "Chase Bank", "アカウント", "id-with-dashes-123"].every((k) => {
      const s = preferredSlot(k);
      return Number.isInteger(s) && s >= 0 && s < CHART_PALETTE.length;
    }),
  );

  console.log("wealth class identity — visual language preserved");
  // These four MUST equal the colours the donut already rendered for a complete
  // set (palette slots 0–3 in declaration order), or a full portfolio would
  // visibly change colour.
  check("cash is palette[0]",        WEALTH_CLASS_COLOR.cash        === CHART_PALETTE[0]);
  check("investments is palette[1]", WEALTH_CLASS_COLOR.investments === CHART_PALETTE[1]);
  check("crypto is palette[2]",      WEALTH_CLASS_COLOR.crypto      === CHART_PALETTE[2]);
  check("real is palette[3]",        WEALTH_CLASS_COLOR.real        === CHART_PALETTE[3]);
  check("all four class colours are distinct", new Set(Object.values(WEALTH_CLASS_COLOR)).size === 4);

  // WHY these are pinned rather than hashed. Two independent reasons, both real:
  //   1. 'investments' and 'real' both prefer slot 5 — they contend, so hashing
  //      would expose the four classes to the very instability we are removing.
  //   2. Hashed output bears no relation to the shipped colours (cash → amber),
  //      so the identity regime is also what preserves the visual language.
  const classIds = ["cash", "investments", "crypto", "real"];
  check(
    "wealth-class ids DO contend under hashing — justifying the identity regime",
    new Set(classIds.map(preferredSlot)).size < classIds.length,
  );
  check(
    "hashing them would change the shipped colours — identity regime preserves them",
    assignStableColors(classIds).join() !== classIds.map((id) => WEALTH_CLASS_COLOR[id]).join(),
  );

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
