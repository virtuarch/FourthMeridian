/**
 * components/notices/notice-rail.test.ts  (UNIFIED NOTICES)
 *
 *   1. which notices show: maintenance enabled / disabled / reset / unavailable,
 *      2FA on / off, both at once (maintenance first), the AI surface;
 *   2. independent dismissal and reappearance (session store; maintenance
 *      collapses and never vanishes; a collapse ends with its window);
 *   3. rendering: one compact frame with hairline dividers, accessible labels,
 *      mobile wrapping, the enrolment link unchanged;
 *   4. the server read: fact state → boolean, failure → null; the route returns
 *      two fields and nothing operational; enforcement is untouched.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/notices/notice-rail.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LEGACY_TOTP_DISMISS_KEY, MAINTENANCE_DESCRIPTION, MAINTENANCE_TITLE, TWO_FACTOR_ACTION, TWO_FACTOR_HREF, TWO_FACTOR_TEXT,
  readNoticeStatus, shouldForgetMaintenanceCollapse, visibleNotices, type AppNoticeStatus, type NoticeDismissals,
} from "./notice-model";
import { readMaintenanceNotice } from "@/lib/platform/notices/maintenance-notice";
import { PlatformSettingKey } from "@/lib/platform-settings";

/** The fact's settings key, from the registry — never spelled out here (admission census §6). */
const KEY = PlatformSettingKey.MAINTENANCE_MODE;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// A stand-in browser for the session dismissal store (NoticeRail reads `window` lazily).
function storage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() };
}
const session = storage();
const local = storage();
(globalThis as unknown as { window: unknown }).window = {
  sessionStorage: session, localStorage: local, dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {},
};

const NONE: NoticeDismissals = { maintenanceCollapsed: false, twoFactorDismissed: false };
const S = (maintenance: boolean | null, twoFactorReminder: boolean): AppNoticeStatus => ({ maintenance, twoFactorReminder });
const ids = (s: AppNoticeStatus | null, d = NONE, ai = false) => visibleNotices(s, d, { conversationSurface: ai }).map((n) => `${n.id}:${n.mode}`).join(",");

async function main() {
  const { NoticeRailView, currentDismissals, dismissNotice, expandMaintenanceNotice, forgetMaintenanceCollapse } = await import("./NoticeRail");

  console.log("1. which notices show");
  check("maintenance enabled ⇒ the maintenance notice", ids(S(true, false)) === "maintenance:full");
  check("maintenance disabled ⇒ nothing", ids(S(false, false)) === "");
  check("maintenance reset (not configured reads as off) ⇒ nothing", ids(S(false, false)) === "" && ids(readNoticeStatus({ maintenance: false, twoFactorReminder: false })) === "");
  check("status unavailable (null) ⇒ no maintenance claim", ids(S(null, false)) === "");
  check("no status at all ⇒ nothing", ids(null) === "");
  check("2FA not enabled ⇒ the reminder", ids(S(false, true)) === "two-factor:full");
  check("2FA enabled ⇒ no reminder", ids(S(false, false)) === "");
  check("both ⇒ one rail, maintenance FIRST", ids(S(true, true)) === "maintenance:full,two-factor:full");
  check("AI surface ⇒ maintenance still shows, the 2FA reminder does not (AI-4)", ids(S(true, true), NONE, true) === "maintenance:full");
  check("the copy is exactly as specified",
    MAINTENANCE_TITLE === "Maintenance in progress" && MAINTENANCE_DESCRIPTION === "AI and account syncing are temporarily paused."
      && TWO_FACTOR_TEXT === "Protect your account with 2FA." && TWO_FACTOR_ACTION === "Enable");
  check("an untrusted body narrows to two fields only",
    JSON.stringify(readNoticeStatus({ maintenance: true, twoFactorReminder: true, [KEY]: "true", updatedBy: "x" })) === JSON.stringify(S(true, true))
      && readNoticeStatus({ maintenance: "yes" })!.maintenance === null && readNoticeStatus(null) === null);

  console.log("\n2. independent dismissal and reappearance");
  {
    check("fresh session: nothing dismissed", JSON.stringify(currentDismissals()) === JSON.stringify(NONE));
    dismissNotice("two-factor");
    check("dismissing 2FA hides only 2FA", ids(S(true, true), currentDismissals()) === "maintenance:full");
    dismissNotice("maintenance");
    check("dismissing maintenance COLLAPSES it — it never disappears while on", ids(S(true, true), currentDismissals()) === "maintenance:collapsed");
    expandMaintenanceNotice();
    check("Details re-opens it in full, 2FA stays dismissed", ids(S(true, true), currentDismissals()) === "maintenance:full");
    dismissNotice("maintenance");
    check("maintenance ending is the signal to forget the collapse", shouldForgetMaintenanceCollapse(S(false, false)) && !shouldForgetMaintenanceCollapse(S(null, false)) && !shouldForgetMaintenanceCollapse(null));
    forgetMaintenanceCollapse();
    check("…so the next window shows in full again", ids(S(true, false), currentDismissals()) === "maintenance:full");
    session.clear();
    check("a new browser session: the 2FA reminder reappears", ids(S(false, true), currentDismissals()) === "two-factor:full");
    local.setItem(LEGACY_TOTP_DISMISS_KEY, "1");
    check("a dismissal made in the retired per-browser nudge is honoured", ids(S(false, true), currentDismissals()) === "");
    local.removeItem(LEGACY_TOTP_DISMISS_KEY);
    check("dismissal is display only: the model has no path to enforcement", !/admit|admission|fetch|PATCH/.test(readFileSync(path.join(process.cwd(), "components/notices/notice-model.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
  }

  console.log("\n3. rendering");
  {
    const render = (s: AppNoticeStatus, d = NONE, ai = false) =>
      renderToStaticMarkup(createElement(NoticeRailView, { notices: visibleNotices(s, d, { conversationSurface: ai }), onDismiss: () => {}, onExpand: () => {} }));
    const both = render(S(true, true));
    check("one labelled frame for every notice", (both.match(/<section/g) ?? []).length === 1 && /aria-label="Notices"/.test(both));
    check("thin hairline dividers between rows, not separate cards", /divide-y divide-\[var\(--border-hairline\)\]/.test(both) && !/rounded-2xl/.test(both));
    check("maintenance is first, as a polite status", both.indexOf('data-notice="maintenance"') < both.indexOf('data-notice="two-factor"') && /role="status" data-notice="maintenance"/.test(both));
    check("the maintenance title and description", both.includes(MAINTENANCE_TITLE) && both.includes(MAINTENANCE_DESCRIPTION));
    check("the 2FA reminder links to the existing enrolment page", both.includes(`href="${TWO_FACTOR_HREF}"`) && />Enable</.test(both) && both.includes(TWO_FACTOR_TEXT));
    check("each dismiss control is named for screen readers", both.includes('aria-label="Dismiss maintenance notice"') && both.includes('aria-label="Dismiss two-factor reminder"'));
    check("icons are decorative (aria-hidden)", !/<svg(?![^>]*aria-hidden)/.test(both));
    check("mobile: the description wraps under the title; desktop: one line with a separator", /block text-\[var\(--text-secondary\)\] sm:inline/.test(both) && /hidden text-\[var\(--text-muted\)\] sm:inline/.test(both));
    check("compact: small text, small padding", /px-3 py-1\.5 text-xs/.test(both) && !/py-3|px-4/.test(both));
    const collapsed = render(S(true, false), { maintenanceCollapsed: true, twoFactorDismissed: false });
    check("collapsed maintenance: one line, still says maintenance, with an expandable Details control",
      collapsed.includes(MAINTENANCE_TITLE) && !collapsed.includes(MAINTENANCE_DESCRIPTION) && /aria-expanded="false"/.test(collapsed) && /aria-label="Show maintenance details"/.test(collapsed));
    check("nothing applies ⇒ nothing rendered (no empty frame, no reserved space)", render(S(false, false)) === "");
    for (const leak of [KEY, "ingestion", "kill switch", "Platform Ops", "updatedBy", "Last changed", "PLATFORM_POLICY"]) {
      check(`no operational detail in the rail: ${leak}`, !both.toLowerCase().includes(leak.toLowerCase()) && !collapsed.toLowerCase().includes(leak.toLowerCase()));
    }
  }

  console.log("\n4. the server read, the route, and enforcement");
  {
    const reader = (values: Record<string, string> | Error) => ({ read: async () => { if (values instanceof Error) throw values; return values; } });
    check("enabled (\"true\") ⇒ true", (await readMaintenanceNotice(reader({ [KEY]: "true" }))) === true);
    check("disabled (\"false\") ⇒ false", (await readMaintenanceNotice(reader({ [KEY]: "false" }))) === false);
    check("reset / not configured (no row) ⇒ false", (await readMaintenanceNotice(reader({}))) === false);
    check("unreadable value ⇒ true (admission refuses the same work)", (await readMaintenanceNotice(reader({ [KEY]: "yes" }))) === true);
    check("store unavailable ⇒ null (no claim)", (await readMaintenanceNotice(reader(new Error("down")))) === null);
    const route = readFileSync(path.join(process.cwd(), "app/api/status/notices/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    check("the route is for any signed-in user (requireUser, no platform grant)", /requireUser\(\)/.test(route) && !/requirePlatformAccess|requireFreshPlatformAccess|CONTROL/.test(route));
    check("…never cached", /"Cache-Control": "no-store"/.test(route));
    const status = readFileSync(path.join(process.cwd(), "lib/platform/notices/app-notice-status.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    check("…and returns exactly two fields", /return \{ maintenance, twoFactorReminder: me \? !me\.totpEnabled : false \};/.test(status));
    const panel = readFileSync(path.join(process.cwd(), "components/platform/widgets/MaintenanceModePanel.tsx"), "utf8");
    check("an operator's applied change revalidates the rail at once", /if \(r\.close\) requestNoticeRevalidation\(\);/.test(panel));
    const facts = readFileSync(path.join(process.cwd(), "lib/platform/admission/facts.ts"), "utf8");
    check("enforcement unchanged: admission does not know the notice exists", !/notice/i.test(facts));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
