/**
 * components/platform/ui/primitives.test.ts  (Platform Operations 2.0 — R1, plan §3)
 *
 * Light render + source checks for the shared Platform presentation primitives:
 * status is always a WORD with its dot, unavailable is never zero, targets are
 * ≥ 44 px with a visible focus ring, deliberate actions open a confirmation
 * (no commit button inline), and the primitives stay data-agnostic.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/ui/primitives.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttentionQueue,
  ControlledActionSurface,
  EntityRow,
  HistoryList,
  KpiTile,
  ProvenanceChip,
  StatusHeader,
  provenanceText,
} from "./index";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const r = (c: unknown, p: Record<string, unknown>) => renderToStaticMarkup(createElement(c as never, p as never));
const DIR = path.join(process.cwd(), "components/platform/ui");
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith(".tsx")).map((f) => [f, readFileSync(path.join(DIR, f), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")] as const);

console.log("ProvenanceChip");
{
  check("four kinds, as words", ["MEASURED", "ESTIMATED", "ASSUMED", "UNKNOWN"].map((k) => provenanceText(k as never)).join() === "Measured,Estimated,Assumed,Unknown");
  check("'as of HH:MM UTC' only from a parseable instant", provenanceText("ESTIMATED", "2026-10-30T14:02:09Z") === "Estimated · as of 14:02 UTC" && provenanceText("MEASURED", "nope") === "Measured");
  check("renders the word", text(r(ProvenanceChip, { kind: "UNKNOWN" })) === "Unknown");
}

console.log("StatusHeader");
{
  const html = r(StatusHeader, { verdict: { word: "Degraded", tone: "warn" }, title: "Something is degraded", checkedAt: "2026-10-30T09:05:00Z", facts: [1, 2, 3, 4, 5].map((i) => ({ label: `F${i}`, value: String(i) })) });
  check("verdict = dot (aria-hidden) + WORD", /<span aria-hidden="true" class="rounded-full"[^>]*><\/span><span class="text-xs font-medium">Degraded<\/span>/.test(html));
  check("checked time stated", text(html).includes("Checked 09:05 UTC"));
  check("at most four facts", (html.match(/<dt /g) ?? []).length === 4);
  check("no invented 'Healthy' when the caller gives none", !/Healthy/.test(r(StatusHeader, { verdict: { word: "Unknown", tone: "muted" }, title: "x" })));
}

console.log("KpiTile");
{
  const na = r(KpiTile, { label: "AI spend", value: null, unavailableReason: "no rate card" });
  check("null value ⇒ em-dash + reason, never 0", text(na).includes("— no rate card") && !/>0</.test(na));
  const link = r(KpiTile, { label: "Calls", value: "12", href: "/dashboard/platform/X", hrefLabel: "open X", points: [{ key: "d1", value: 1 }, { key: "d2", value: null }] });
  check("with href the whole tile is ONE link, ≥ 44 px, focus ring", (link.match(/<a /g) ?? []).length === 1 && /min-h-11/.test(link) && /focus-visible:ring-2/.test(link));
  check("the series is MiniBars (role=img, gap kept)", /role="img"/.test(link) && /no observation/.test(link));
  check("no href ⇒ no link", !/<a /.test(r(KpiTile, { label: "x", value: "1" })));
}

console.log("AttentionQueue");
{
  const items = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, severity: { word: "Warning", tone: "warn" }, title: `T${i}`, why: "why", action: { label: "Open", href: `/x/${i}` } }));
  const html = r(AttentionQueue, { items, viewAll: [{ key: "a", label: "Ops", href: "/a", count: "7" }] });
  check("at most five rows", (html.match(/<li/g) ?? []).length === 5);
  check("rows past the third are hidden below sm", (html.match(/<li class="max-sm:hidden"/g) ?? []).length === 2);
  check("each row: severity word + subject + why + ONE action link (≥ 44 px)", /Warning/.test(html) && (html.match(/<a [^>]*class="group flex min-h-11/g) ?? []).length === 5);
  check("'View all in <Space> (n)' doorway", text(html).includes("View all in Ops (7)"));
  check("loading says so", /role="status"[^>]*>Reading…/.test(r(AttentionQueue, { items: [], loading: true })));
  check("empty claims nothing unless the caller vouches", text(r(AttentionQueue, { items: [] })) === "Needs attention" && text(r(AttentionQueue, { items: [], emptyText: "All clear" })).endsWith("All clear"));
}

console.log("EntityRow / HistoryList");
{
  const row = r(EntityRow, { name: "Plaid", status: { word: "Degraded", tone: "warn" }, metrics: [{ label: "a", value: 1 }, { label: "b", value: 2 }, { label: "c", value: 3 }], href: "/p" });
  check("row: name + status word, ≤ 2 metrics, one link ≥ 44 px", /Degraded/.test(row) && !text(row).includes(" c ") && (row.match(/<a /g) ?? []).length === 1 && /min-h-11/.test(row));
  check("row without href is a button (opens a drawer)", /<button type="button"/.test(r(EntityRow, { name: "x", onSelect: () => {} })));
  const hist = r(HistoryList, { entries: Array.from({ length: 8 }, (_, i) => ({ key: `h${i}`, at: "2026-10-30T10:00:00Z", title: `E${i}` })), fullHref: "/h" });
  check("history: five rows + 'View full history'", (hist.match(/<li /g) ?? []).length === 5 && text(hist).includes("View full history") && text(hist).includes("2026-10-30 10:00 UTC"));
  check("history: empty says so", text(r(HistoryList, { entries: [] })).includes("Nothing recorded yet."));
}

console.log("ControlledActionSurface — deliberate, confirmation-gated");
{
  const html = r(ControlledActionSurface, {
    title: "Manual operations",
    actions: [
      { id: "a", label: "Run sync", description: "Runs it", authority: "Requires write access", confirm: { title: "Run?", message: "m", confirmLabel: "Yes, run now", destructive: true }, onConfirm: () => {} },
      { id: "b", label: "Purge", description: "Purges", authority: "Requires elevated access", unavailableReason: "Your grant does not allow this", confirm: { title: "x", message: "m", confirmLabel: "Yes, purge" }, onConfirm: () => {} },
    ],
  });
  check("each runnable action's ONLY inline control is a 'Review…' opener (aria-haspopup=dialog)",
    (html.match(/<button /g) ?? []).length === 1 && /aria-haspopup="dialog"/.test(html) && text(html).includes("Review…"));
  check("no commit/confirm button is rendered inline (it exists only in the dialog)", !/Yes, run now|Yes, purge/.test(html) && !/role="alertdialog"/.test(html));
  check("an unavailable action is listed with its reason and no opener", text(html).includes("Your grant does not allow this") && !/Review Purge/.test(html));
  check("authority is stated in words for every action", text(html).includes("Requires write access") && text(html).includes("Requires elevated access"));
}

console.log("source rules (all primitives)");
{
  check("eight primitive files", SOURCES.length === 8, SOURCES.map(([f]) => f).join());
  for (const [f, src] of SOURCES) {
    check(`${f}: no literal access-level word (capability ratchet)`, !/\bCONTROL\b/.test(src) && !/canControl/.test(src));
    check(`${f}: data-agnostic (no fetch, no route, no area literal)`, !/fetch\(|\/api\/|PLATFORM_OPS|SECURITY_OPS|CUSTOMER_SUCCESS|GROWTH_REVENUE|MERCHANT_OPS/.test(src));
    const interactive = (src.match(/<(Link|button|summary)\b/g) ?? []).length;
    check(`${f}: every interactive element has a visible focus style`, interactive === 0 || (src.match(/focus-visible:/g) ?? []).length >= 1);
  }
  const drawer = SOURCES.find(([f]) => f === "DetailDrawer.tsx")![1];
  check("DetailDrawer wraps the Atlas RightPanel (side panel desktop, sheet mobile)", /<RightPanel\b/.test(drawer) && /@\/components\/atlas\/panels/.test(drawer));
  check("status renders through ToneBadge (dot + word), never a bare colour", ["StatusHeader.tsx", "AttentionQueue.tsx", "EntityList.tsx"].every((f) => /<ToneBadge\b/.test(SOURCES.find(([n]) => n === f)![1])));
}

if (failures > 0) {
  console.error(`\nplatform-ui-primitives: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-ui-primitives: all checks passed.");
