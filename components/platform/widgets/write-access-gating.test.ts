/**
 * components/platform/widgets/write-access-gating.test.ts  (UI-001 · UI-002)
 *
 * "Never a button that 403s": the two non-Ops mutating widgets on the UI-001
 * list read `access` and render their write controls only for a WRITE holder.
 * UI-002: Customer Success never fabricates an audit reason.
 *
 * The widgets self-fetch (useEffect), so a static render shows only their
 * loading state; the gating is therefore pinned STRUCTURALLY: every call site of
 * a mutating handler must sit inside a `canWrite`-gated JSX region (found by
 * matching the region's parentheses), and the READ branch carries the
 * explanatory line.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/write-access-gating.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GrowthBetaRequestsWidget, GROWTH_READ_ONLY_LINE } from "./GrowthBetaRequestsWidget";
import { CsCustomersWidget, CS_READ_ONLY_LINE } from "./CsCustomersWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Index of the paren matching the "(" at `open`. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** [start,end] ranges rendered only when canWrite is true. */
function writeRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(/\{canWrite && (?:[\w.?]+ && )?\(/g)) {
    const open = m.index! + m[0].length - 1;
    out.push([open, matchParen(src, open)]);
  }
  // `{!canWrite ? (READ) : (WRITE)}` — the else branch is the write region.
  for (const m of src.matchAll(/\{!canWrite \? \(/g)) {
    const first = m.index! + m[0].length - 1;
    const close = matchParen(src, first);
    const elseOpen = src.indexOf("(", src.indexOf(":", close));
    out.push([elseOpen, matchParen(src, elseOpen)]);
  }
  // `{detail?.actions.refreshAll && canWrite && (`
  for (const m of src.matchAll(/&& canWrite && \(/g)) {
    const open = m.index! + m[0].length - 1;
    out.push([open, matchParen(src, open)]);
  }
  return out;
}

function allGated(src: string, needle: RegExp, ranges: Array<[number, number]>): { total: number; ungated: number } {
  let total = 0, ungated = 0;
  for (const m of src.matchAll(needle)) {
    total++;
    if (!ranges.some(([a, b]) => m.index! > a && m.index! < b)) ungated++;
  }
  return { total, ungated };
}

console.log("1. Growth & Revenue beta block — write controls only for WRITE");
{
  const src = code("components/platform/widgets/GrowthBetaRequestsWidget.tsx");
  const ranges = writeRanges(src);
  check("widget accepts `access` and derives canWrite fail-safe", src.includes("access?: SpaceMountAccess") && src.includes("const canWrite = access?.canWrite === true;"));
  for (const [label, re] of [
    ["product-status toggle", /setPendingStatus\(s\.value\)/g],
    ["signup-mode toggle", /setPendingMode\(m\.value\)/g],
    ["Invite user", /setInviteOpen\(true\)/g],
    ["Send invite", /onClick=\{sendInvite\}/g],
    ["Approve / Deny", /decide\(selectedRequest\.id/g],
    ["Resend", /resend\(selectedInvitation\.id, selectedInvitation\.invitedAt\)/g],
    ["Revoke", /setRevokeId\(selectedInvitation\.id\)/g],
    ["mode confirm", /changeMode\(pendingMode\)/g],
    ["status confirm", /changeStatus\(pendingStatus\)/g],
    ["revoke confirm", /revoke\(revokeId\)/g],
    // PR B — Extend (keeps the token) opens a reason-required confirm.
    ["Extend", /setExtendId\(selectedInvitation\.id\)/g],
    ["extend confirm", /extend\(extendId\)/g],
  ] as const) {
    const r = allGated(src, re, ranges);
    check(`${label}: rendered only under canWrite (${r.total} site${r.total === 1 ? "" : "s"})`, r.total > 0 && r.ungated === 0, `${r.ungated} ungated`);
  }
  check("READ branch renders the explanatory line", /\{!canWrite && \([\s\S]{0,200}\{GROWTH_READ_ONLY_LINE\}/.test(src));
  check("READ holder still sees the current product status as text", /\{!canWrite \? \([\s\S]{0,300}PRODUCT_STATUSES\.find/.test(src));
  check("line names the area and the level", /WRITE access to Growth\b/.test(GROWTH_READ_ONLY_LINE) && !/Revenue/.test(GROWTH_READ_ONLY_LINE));
}

console.log("1b. Invitation validity (PR B) — READ sees text, the editor only for WRITE");
{
  const widget = code("components/platform/widgets/GrowthBetaRequestsWidget.tsx");
  const src = code("components/platform/growth/InvitationValidityControl.tsx");
  const ranges = writeRanges(src);
  check("mounted in the Access settings panel as a full-width row",
    /data-access-settings[\s\S]{0,8000}<div className="sm:col-span-2">\s*<InvitationValidityControl canWrite=\{canWrite\} \/>/.test(widget));
  for (const [label, re] of [
    ["validity input", /id="growth-invitation-validity"/g],
    ["reason field", /<OperatorReasonField/g],
    ["Save", /onClick=\{save\}/g],
  ] as const) {
    const r = allGated(src, re, ranges);
    check(`${label}: rendered only under canWrite (${r.total} site${r.total === 1 ? "" : "s"})`, r.total > 0 && r.ungated === 0, `${r.ungated} ungated`);
  }
  check("the PUT is only reachable from the gated Save", (src.match(/method: "PUT"/g) ?? []).length === 1 && /async function save\(\)/.test(src));
  check("READ holders see the value as plain text", /Invitations valid \$\{daysLabel\(data\.validityDays\)\}/.test(src));
  check("reads through the shared workspace session", src.includes("useSharedWidgetFetch<InvitationPolicyReadModel>(INVITATION_POLICY_URL)"));
  check("the stale 14-day copy is gone", !/14-day/.test(widget));
  check("direct-invite days default to the configured validity, not a literal 7", !/useState\("7"\)/.test(widget) && !/\|\| 7\b/.test(widget));
}

console.log("2. Customer Success spine — editors only for WRITE; no fabricated reason");
{
  const src = code("components/platform/widgets/CsCustomersWidget.tsx");
  const ranges = writeRanges(src);
  check("widget accepts `access` and derives canWrite fail-safe", src.includes("access?: SpaceMountAccess") && src.includes("const canWrite = access?.canWrite === true;"));
  for (const [label, re] of [
    ["Apply policy", /onClick=\{assignPolicy\}/g],
    ["Set override", /onClick=\{setAllowanceOverride\}/g],
    ["Remove override", /onClick=\{removeAllowanceOverride\}/g],
    ["Add cohort", /onClick=\{addCohort\}/g],
    ["Refresh all", /onClick=\{refreshAll\}/g],
  ] as const) {
    const r = allGated(src, re, ranges);
    check(`${label}: rendered only under canWrite (${r.total} site)`, r.total === 1 && r.ungated === 0, `${r.ungated} ungated`);
  }
  check("READ branch renders the explanatory line", src.includes("{!canWrite && <p") && src.includes("{CS_READ_ONLY_LINE}"));
  check("line names the area and the level", /WRITE access to Customer Success/.test(CS_READ_ONLY_LINE));

  // UI-002
  check("no fallback reason is invented (no `reason ?? {`)", !/reason \?\? \{/.test(src));
  check("SUPPORT_REQUEST appears only as a label key, never as a posted code",
    !/code:\s*"SUPPORT_REQUEST"/.test(src));
  check("toggleActive requires the chosen reason", /const toggleActive = \(\) => detail\?\.actions\.deactivate && reason && run\(/.test(src));
  check("toggleActive posts that reason as-is", /: "reactivate", reason \}\)\)/.test(src));
  check("Deactivate/Reactivate button is disabled until a reason is chosen", /onClick=\{toggleActive\} disabled=\{acting !== null \|\| !reason\}/.test(src));
  check("the reason picker is reachable without WRITE (Account access section)", /title="Account access"[\s\S]{0,600}<ReasonFields/.test(src));
}

console.log("3. Render: READ / absent access never throws and shows the loading state");
{
  const section = { id: "s", key: "k", label: "Beta access" };
  const g = renderToStaticMarkup(createElement(GrowthBetaRequestsWidget, { section }));
  check("Growth renders with no access (fail-safe)", g.includes("Loading"));
  const c = renderToStaticMarkup(createElement(CsCustomersWidget, { section, access: { canRead: true, canWrite: false, canControl: false, level: "READ" } }));
  check("CS renders for a READ holder", c.includes("Loading"));
  check("CS search input is labelled", c.includes('aria-label="Search customers by email or name"'));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll UI-001/UI-002 checks passed.");
