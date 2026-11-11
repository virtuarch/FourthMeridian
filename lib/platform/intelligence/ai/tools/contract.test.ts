/**
 * lib/platform/intelligence/ai/tools/contract.test.ts  (Platform AI P1b — the typed tool contract)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/contract.test.ts
 *
 * 1. TYPE level (checked by `tsc --noEmit`, the @ts-expect-error lines): no wildcard / empty
 *    areas, no plain-string argument kind, RECORD needs customerLinkable, customerLinkable
 *    needs an AuditSpec, AGGREGATE cannot be customer-linkable, level is READ only.
 * 2. RUNTIME: contractProblems catches the same mistakes in a declaration that escaped the
 *    types (an `as` cast, a JS caller); parseClosedArgs is strict.
 */

import type { PlatformAiToolContract } from "./contract";
import {
  GUARDED_TEXT_ALLOWLIST, HANDLE_KEY_PATTERN, TOOL_RESULT_STATUSES, contractProblems, parseClosedArgs, toolCallCost,
  type ClosedSchema, type ToolAreas,
} from "./contract";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const run = async () => null;
const base = {
  name: "sample_tool", pack: "metrics", description: "A sample.", args: { properties: {} },
  requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, scope: "AGGREGATE", customerLinkable: false,
  pii: 0, cost: { toolCalls: 1 }, run,
} as const satisfies PlatformAiToolContract<unknown>;

// ── 1. TYPE-LEVEL — never called; `tsc --noEmit` fails if any @ts-expect-error stops erroring ──
export function typeLevelPins(): void {
  // @ts-expect-error — no wildcard area value exists
  const wildcard: ToolAreas = ["ALL"];
  // @ts-expect-error — the areas tuple is non-empty
  const empty: ToolAreas = [];
  // @ts-expect-error — a plain string argument kind does not exist
  const plain: ClosedSchema = { properties: { q: { kind: "string", maxLength: 10 } } };
  // @ts-expect-error — RECORD requires customerLinkable to be declared
  const recordNoLink: PlatformAiToolContract<unknown> = { ...base, scope: "RECORD", customerLinkable: undefined };
  // @ts-expect-error — a customer-linkable tool requires an AuditSpec
  const linkNoAudit: PlatformAiToolContract<unknown> = { ...base, scope: "RECORD", customerLinkable: true };
  // @ts-expect-error — an AGGREGATE tool cannot be customer-linkable
  const aggLinked: PlatformAiToolContract<unknown> = { ...base, scope: "AGGREGATE", customerLinkable: true, audit: { action: "CUSTOMER_PROFILE_VIEWED", detail: { surface: "platform-ai", recordKind: "customer" } } };
  // @ts-expect-error — Platform AI is read-only: no WRITE level
  const write: PlatformAiToolContract<unknown> = { ...base, requires: { areas: ["PLATFORM_OPS"], level: "WRITE", tier: "OPS" } };
  const ok: PlatformAiToolContract<unknown> = { ...base, scope: "RECORD", customerLinkable: true, audit: { action: "CUSTOMER_PROFILE_VIEWED", detail: { surface: "platform-ai", recordKind: "customer" } } };
  void [wildcard, empty, plain, recordNoLink, linkNoAudit, aggLinked, write, ok];
}

console.log("1. the result status enum and handle key shape");
check("result statuses are exactly CONFIRMED|CALCULATED|ESTIMATED|PARTIAL|MISSING|UNAVAILABLE|STALE",
  TOOL_RESULT_STATUSES.join() === "CONFIRMED,CALCULATED,ESTIMATED,PARTIAL,MISSING,UNAVAILABLE,STALE");
check("handle key = h_ + 16 base64url chars", HANDLE_KEY_PATTERN.test("h_AbCdEfGh_-012345") && !HANDLE_KEY_PATTERN.test("h_short") && !HANDLE_KEY_PATTERN.test("h_AbCdEfGh_-0123456") && !HANDLE_KEY_PATTERN.test("x_AbCdEfGh_-012345"));
check("guardedText is allowed only for the two pre-existing arguments", GUARDED_TEXT_ALLOWLIST.join() === "find_page.query,propose_memory.note");

console.log("\n2. contractProblems — declarations that escaped the types are still refused");
{
  const probs = (c: unknown) => contractProblems(c as PlatformAiToolContract<never>);
  check("the valid sample has no problems", probs(base).length === 0, probs(base));
  check("empty areas ⇒ refused", probs({ ...base, requires: { ...base.requires, areas: [] } }).some((p) => p.startsWith("requires.areas")));
  check("a wildcard / non-registry area ⇒ refused", probs({ ...base, requires: { ...base.requires, areas: ["ALL"] } }).some((p) => /not a Platform area/.test(p))
    && probs({ ...base, requires: { ...base.requires, areas: ["*"] } }).some((p) => /not a Platform area/.test(p)));
  check("a duplicate area ⇒ refused", probs({ ...base, requires: { ...base.requires, areas: ["PLATFORM_OPS", "PLATFORM_OPS"] } }).some((p) => /duplicate/.test(p)));
  check("a non-READ level ⇒ refused", probs({ ...base, requires: { ...base.requires, level: "CONTROL" } }).some((p) => /level/.test(p)));
  check("RECORD without customerLinkable ⇒ refused", probs({ ...base, scope: "RECORD", customerLinkable: undefined }).some((p) => /customerLinkable/.test(p)));
  check("customerLinkable without an AuditSpec ⇒ refused", probs({ ...base, scope: "RECORD", customerLinkable: true }).some((p) => /^audit/.test(p)));
  check("AGGREGATE + customerLinkable ⇒ refused", probs({ ...base, customerLinkable: true, audit: { action: "X", detail: { surface: "platform-ai", recordKind: "x" } } }).some((p) => /AGGREGATE/.test(p)));
  check("a plain string argument ⇒ refused", probs({ ...base, args: { properties: { q: { kind: "string" } } } }).some((p) => /not a closed kind/.test(p)));
  check("guardedText on a tool/arg outside the allowlist ⇒ refused",
    probs({ ...base, args: { properties: { note: { kind: "guardedText", sink: "MEMORY_NOTE_GUARD", maxLength: 50 } } } }).some((p) => /allowlist/.test(p)));
  check("an unbounded int / empty enum ⇒ refused",
    probs({ ...base, args: { properties: { n: { kind: "int", min: 1, max: Infinity } } } }).some((p) => /unbounded/.test(p))
    && probs({ ...base, args: { properties: { e: { kind: "enum", values: [] } } } }).some((p) => /enum/.test(p)));
  check("pii outside 0|1|2 and a non-positive cost ⇒ refused", probs({ ...base, pii: 3 }).some((p) => /pii/.test(p)) && probs({ ...base, cost: { toolCalls: 0 } }).some((p) => /cost/.test(p)));
  check("toolCallCost: a number, a function of the args, clamped to ≥ 1",
    toolCallCost(base, {}) === 1 && toolCallCost({ cost: { toolCalls: (a) => (a.sections as unknown[]).length } }, { sections: [1, 2, 3] }) === 3 && toolCallCost({ cost: { toolCalls: () => 0 } }, {}) === 1);
}

console.log("\n3. parseClosedArgs — strict");
{
  const schema: ClosedSchema = { properties: {
    kind: { kind: "enum", values: ["A", "B"] },
    n: { kind: "int", min: 1, max: 10, optional: true },
    id: { kind: "registryId", registry: "METRIC", pattern: /^[a-z-]+@\d+$/, maxLength: 20, optional: true },
    h: { kind: "handle", optional: true },
    params: { kind: "registryParams", maxValueLength: 80, optional: true },
  } };
  const p = (raw: string) => parseClosedArgs(schema, raw, { paramKeys: ["view"] });
  check("a valid object parses", JSON.stringify(p(`{"kind":"A","n":3,"id":"x-y@1","h":"h_AbCdEfGh_-012345","params":{"view":"open"}}`)) === `{"kind":"A","n":3,"id":"x-y@1","h":"h_AbCdEfGh_-012345","params":{"view":"open"}}`);
  check("null for an optional argument = absent", JSON.stringify(p(`{"kind":"B","n":null}`)) === `{"kind":"B"}`);
  for (const [why, raw] of [
    ["missing required", `{}`], ["unknown key", `{"kind":"A","surface":"CUSTOMER_SUCCESS"}`], ["enum miss", `{"kind":"C"}`],
    ["int out of range", `{"kind":"A","n":11}`], ["non-integer", `{"kind":"A","n":1.5}`], ["registry id shape", `{"kind":"A","id":"Robert'); DROP"}`],
    ["handle shape", `{"kind":"A","h":"h_123"}`], ["param key not allowed", `{"kind":"A","params":{"rid":"x"}}`], ["param value not a string", `{"kind":"A","params":{"view":1}}`],
    ["array", `[]`], ["not JSON", `nope`], ["null", `null`], ["class instance prototype", `{"kind":"A","__proto__":{"x":1}}`],
  ] as const) check(`refused: ${why}`, p(raw) === null, raw);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
