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
import {
  attentionFilterOf, attentionFromSearch, attentionUrlUpdate, inapplicableNotice, readAttentionParam,
  CS_ATTENTION_FILTER_EVENT, CS_ATTENTION_PARAM, INAPPLICABLE_FILTER_NOTICE, NOT_ENFORCED_NOTICE, UNKNOWN_FILTER_NOTICE,
} from "../leads/cs-attention-link";
import { applySpaceUrlUpdate, SPACE_URL_PARAMS } from "@/lib/space/space-url";

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
  check("unassigned (fail-closed) is a reason key too", attentionFilterOf(ev("unassigned")) === "unassigned");
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
  check("an active filter is stated and can be cleared", /data-attention-active/.test(src) && /applyAttention\(null, search\)/.test(src));
}
console.log("4. S2 — the filter lives in the URL (?attention=, REPLACE)");
{
  const base = "workspace=customer-success&view=overview";
  const set = applySpaceUrlUpdate(base, attentionUrlUpdate("reconnect"));
  check("setting writes ?attention= and preserves every unrelated param", set === "workspace=customer-success&view=overview&attention=reconnect", set);
  check("a refresh / shared link reads it back (the same parser as the route)", attentionFromSearch(`?${set}`) === "reconnect" && attentionFromSearch("attention=any") === "any");
  check("clearing deletes the param (clean URL, no empty value)", applySpaceUrlUpdate(set, attentionUrlUpdate(null)) === base);
  check("a junk or absent value opens the unfiltered list", attentionFromSearch("attention=everyone") === null && attentionFromSearch(base) === null && attentionFromSearch("") === null);
  check("the param is a declared Space-scoped param", CS_ATTENTION_PARAM === "attention" && (SPACE_URL_PARAMS as readonly string[]).includes("attention"));
  const src = strip("components/platform/widgets/CsCustomersWidget.tsx");
  check("written through the ONE URL seam with REPLACE, never PUSH", /spaceUrl\.commit\(attentionUrlUpdate\(f\), \{ history: "replace" \}\)/.test(src)
    && !/history: "push"/.test(src) && !/window\.history|pushState|replaceState/.test(src));
  check("the first read honours ?attention= (refresh / link)", /const \{ filter, unknown \} = readAttentionParam\(spaceUrl\.getSearch\(\)\);[\s\S]*?await loadList\("", filter\)/.test(src)
    && /await openFromUrl\(\(\) => alive\)/.test(src));
  check("Back/Forward rebuilds from the URL through the seam's one listener", /spaceUrl\.subscribe\(\(\) => \{ void openFromUrl\(\); \}\)/.test(src) && !/addEventListener\("popstate"/.test(src));
  check("the dashboard event only SETS the state (through the one setter that mirrors the URL)", /const onFilter = \(e: Event\) => \{[\s\S]*?applyAttention\(f, ""\);[\s\S]*?\};/.test(src));
  check("the select and 'Show all accounts' go through the same setter", /applyAttention\(e\.target\.value === "" \? null/.test(src) && /applyAttention\(null, search\)/.test(src));
}
console.log("5. S2 — an inapplicable URL filter never renders an empty list");
{
  const ENFORCED = [{ key: "reconnect" }, { key: "incident" }, { key: "policy" }, { key: "unassigned" }, { key: "stalled" }];
  const OFF = ENFORCED.filter((r) => r.key !== "unassigned");
  check("an unknown key is flagged unknown and opens unfiltered", JSON.stringify(readAttentionParam("?workspace=x&attention=everyone")) === JSON.stringify({ filter: null, unknown: true }));
  check("absent / empty is not unknown", !readAttentionParam("workspace=x").unknown && !readAttentionParam("attention=").unknown);
  check("?attention=unassigned while NOT enforced ⇒ the enforcement notice", inapplicableNotice("unassigned", OFF) === NOT_ENFORCED_NOTICE
    && NOT_ENFORCED_NOTICE.startsWith("That filter only applies when policy assignment is enforced"));
  check("…and applies (no notice) while enforced", inapplicableNotice("unassigned", ENFORCED) === null);
  check("any other key the server did not name ⇒ the generic notice", inapplicableNotice("stalled", [{ key: "reconnect" }]) === INAPPLICABLE_FILTER_NOTICE);
  check("no filter / any / a listed reason ⇒ applies", inapplicableNotice(null, OFF) === null && inapplicableNotice("any", OFF) === null && inapplicableNotice("policy", OFF) === null);
  check("notices are one line", [UNKNOWN_FILTER_NOTICE, NOT_ENFORCED_NOTICE, INAPPLICABLE_FILTER_NOTICE].every((t) => !t.includes("\n") && t.length < 100));
  const src = strip("components/platform/widgets/CsCustomersWidget.tsx");
  check("unknown key: the param is DROPPED with REPLACE and the notice shown",
    /if \(unknown\) spaceUrl\.commit\(attentionUrlUpdate\(null\), \{ history: "replace" \}\);/.test(src) && /setUrlNotice\(unknown \? UNKNOWN_FILTER_NOTICE : null\)/.test(src));
  check("inapplicable (e.g. unassigned while not enforced): dropped with REPLACE, notice shown, the FULL list re-read",
    /const notice = inapplicableNotice\(filter, loaded\.attentionReasons \?\? \[\]\);[\s\S]*?spaceUrl\.commit\(attentionUrlUpdate\(null\), \{ history: "replace" \}\);\s*setUrlNotice\(notice\); setAttention\(null\);\s*await loadList\("", null\);/.test(src));
  check("the notice is one status line", /\{urlNotice && <p className="[^"]*" role="status" data-attention-notice>\{urlNotice\}<\/p>\}/.test(src));
  const route = strip("app/api/platform/customer-success/customers/route.ts");
  check("the API's 400 stays for direct calls", /if \(attention === undefined\) \{\s*return NextResponse\.json\(\{ error:[^}]*\}, \{ status: 400 \}\);/.test(route));
}
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
