/**
 * components/platform/widgets/cs-needs-help.test.ts  (PB-4 — "Needs help" on the Customers list)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/cs-needs-help.test.ts
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NeedsHelpChip } from "./CsCustomersWidget";
import { attentionFilterOf, CS_ATTENTION_FILTER_EVENT } from "../leads/cs-attention-link";

let failures = 0;
const check = (name: string, cond: boolean, d?: unknown) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} — ${JSON.stringify(d)}`); } };
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const REASONS = [
  { key: "reconnect" as const, label: "A connection needs reconnecting", short: "Reconnect" },
  { key: "incident" as const, label: "An active sync incident", short: "Sync incident" },
  { key: "policy" as const, label: "Assigned policy group is unknown, invalid or retired", short: "Policy group" },
  { key: "stalled" as const, label: "Stalled before first connection, 7+ days after registering", short: "Stalled" },
];

console.log("1. the chip");
{
  const html = renderToStaticMarkup(createElement(NeedsHelpChip, { keys: ["reconnect", "incident"], reasons: REASONS }));
  check("names 'Needs help' and the reasons' chip words", html.includes("Needs help") && html.includes("Reconnect, Sync incident"), html);
  check("the full reasons are its title", html.includes('title="A connection needs reconnecting · An active sync incident"'), html);
  check("no reason ⇒ nothing", renderToStaticMarkup(createElement(NeedsHelpChip, { keys: [], reasons: REASONS })) === "");
  check("an older response without the field ⇒ nothing", renderToStaticMarkup(createElement(NeedsHelpChip, { keys: undefined, reasons: undefined })) === "");
}

console.log("2. the hand-off event");
{
  const ev = (detail: unknown) => ({ detail }) as unknown as Event;
  check("carries a reason key or 'any'", attentionFilterOf(ev("policy")) === "policy" && attentionFilterOf(ev("any")) === "any");
  check("anything else is ignored", attentionFilterOf(ev("everyone")) === null && attentionFilterOf(ev({ userId: "u1" })) === null && attentionFilterOf(ev(undefined)) === null);
  check("one event name", CS_ATTENTION_FILTER_EVENT === "fm:cs-attention-filter");
}

console.log("3. the list (source pins)");
{
  const src = strip("components/platform/widgets/CsCustomersWidget.tsx");
  check("the filter asks the audited route for attention=<key|any>", /&attention=\$\{encodeURIComponent\(att\)\}/.test(src) && /\/api\/platform\/customer-success\/customers\?search=/.test(src));
  check("a 'Needs help' filter control with every server-named reason", /data-attention-filter/.test(src) && /Needs help — any reason/.test(src) && /list\?\.attentionReasons \?\? \[\]\)\.map/.test(src));
  check("the chip is on BOTH the desktop row and the phone row", (src.match(/<NeedsHelpChip keys=\{c\.attention\} reasons=\{list\.attentionReasons\} \/>/g) ?? []).length === 2);
  check("the dashboard's reason rows set the same filter (listener added and removed)",
    /window\.addEventListener\(CS_ATTENTION_FILTER_EVENT, onFilter\)/.test(src) && /window\.removeEventListener\(CS_ATTENTION_FILTER_EVENT, onFilter\)/.test(src));
  check("a refetch after an action keeps the filter", /await loadList\(search, attention\)/.test(src));
  check("an active filter is stated and can be cleared", /data-attention-active/.test(src) && /applyAttention\(null\)/.test(src));
}
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
