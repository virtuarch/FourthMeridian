/**
 * lib/platform/intelligence/ai/authz/handles.test.ts  (Platform AI P2 — per-turn handles, I-6 / D-6)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/handles.test.ts
 *
 * 96-bit node:crypto keys in the contract's shape; every bound field (kind, area, tier,
 * operator, correlation) must match to resolve; another table (turn / operator /
 * correlation) never resolves; the table is never serialised; no module state.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { HANDLE_KEY_PATTERN } from "../tools/contract";
import { createHandleTable, newHandleKey, type HandleExpectation } from "./handles";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const OP = "cop0000000000000000000001", OTHER = "cop0000000000000000000002";
const RID = "crecordsecret00000000001";
const expect = (over: Partial<HandleExpectation> = {}): HandleExpectation =>
  ({ kind: "INCIDENT", areas: ["PLATFORM_OPS"], tier: "OPS", operatorId: OP, correlationId: "turn-1", ...over });

console.log("1. keys");
{
  const keys = Array.from({ length: 2000 }, newHandleKey);
  check("every key matches the contract's HANDLE_KEY_PATTERN (h_ + 16 base64url = 96 bits)", keys.every((k) => HANDLE_KEY_PATTERN.test(k)));
  check("2000 keys, no collision", new Set(keys).size === keys.length);
  const s = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/authz/handles.ts"), "utf8");
  check("crypto randomness: randomBytes(12) from node:crypto, base64url; no Math.random", /import \{ randomBytes \} from "node:crypto";/.test(s) && /randomBytes\(12\)\.toString\("base64url"\)/.test(s) && !/Math\.random/.test(s));
  check("no module-level table (every Map is created inside createHandleTable)", !/^(?:const|let|var) \w+ = new (?:Map|Set)/m.test(s));
}

console.log("\n2. bound resolution");
{
  const t = createHandleTable({ operatorId: OP, correlationId: "turn-1" });
  const h = t.mint({ kind: "INCIDENT", area: "PLATFORM_OPS", tier: "OPS", recordId: RID });
  check("the same record minted twice in a turn ⇒ the same key", t.mint({ kind: "INCIDENT", area: "PLATFORM_OPS", tier: "OPS", recordId: RID }) === h && t.size === 1);
  check("all bound fields match ⇒ the record id", t.resolve(h, expect()) === RID);
  for (const [why, over] of [
    ["another record kind", { kind: "CUSTOMER" }],
    ["an area the call may not read", { areas: ["CUSTOMER_SUCCESS"] }],
    ["another operator", { operatorId: OTHER }],
    ["another correlation id (another turn)", { correlationId: "turn-2" }],
  ] as const) check(`${why} ⇒ null`, t.resolve(h, expect(over as Partial<HandleExpectation>)) === null);
  const cs = t.mint({ kind: "INCIDENT", area: "PLATFORM_OPS", tier: "CUSTOMER_SUCCESS", recordId: "r-cs" });
  check("a CS-tier record resolves only for a CS-tier call", t.resolve(cs, expect()) === null && t.resolve(cs, expect({ tier: "CUSTOMER_SUCCESS" })) === "r-cs");
  check("a guessed / malformed key ⇒ null", t.resolve("h_AAAAAAAAAAAAAAAA", expect()) === null && t.resolve("h_short", expect()) === null && t.resolve(RID, expect()) === null);
  const turn2 = createHandleTable({ operatorId: OP, correlationId: "turn-2" });
  const otherOp = createHandleTable({ operatorId: OTHER, correlationId: "turn-1" });
  check("another turn's table does not know the key (even with matching expectations)", turn2.resolve(h, expect({ correlationId: "turn-2" })) === null && turn2.resolve(h, expect()) === null);
  check("another operator's table does not know the key", otherOp.resolve(h, expect({ operatorId: OTHER })) === null);
  check("owns(): only keys this table minted", t.owns(h) && !turn2.owns(h));
  check("a table needs an operator and a correlation id", (() => { try { createHandleTable({ operatorId: "", correlationId: "x" }); return false; } catch { return true; } })());
}

console.log("\n3. never serialised or logged");
{
  const t = createHandleTable({ operatorId: OP, correlationId: "turn-1" });
  const h = t.mint({ kind: "INCIDENT", area: "PLATFORM_OPS", tier: "OPS", recordId: RID });
  const out = [JSON.stringify(t), JSON.stringify({ t }), inspect(t, { depth: 10, showHidden: true }), String(Object.keys(t))].join(" ");
  check("JSON.stringify / util.inspect show a fixed marker: no key, no record id, no operator", !out.includes(h) && !out.includes(RID) && !out.includes(OP) && out.includes("[platform-ai handle table]"), out);
  check("the table is frozen (no field can be replaced)", Object.isFrozen(t));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
