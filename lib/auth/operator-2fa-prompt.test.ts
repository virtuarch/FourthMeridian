/**
 * lib/auth/operator-2fa-prompt.test.ts  (owner D4, 2026-11-10 — operator 2FA UX)
 *
 * Standalone tsx, exits 0/1:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/auth/operator-2fa-prompt.test.ts
 *
 *   A. wording selection (pure): operators get the "required for the platform
 *      operator tools" copy; ordinary users keep the exact prior copy.
 *   B. the notice rail picks that copy from the SERVER flag only.
 *   C. the Platform toggle opens enrolment directly when the server says the
 *      operator must enrol, and is the plain directory link otherwise.
 *   D. the enrolment widget auto-opens setup only while NOT enrolled, and the
 *      continue path is a validated Platform path, for operators only.
 *   E. server enforcement is untouched (UX only).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OPERATOR_2FA_NOTICE_TEXT, PLATFORM_HOME_HREF, START_2FA_HREF, USER_2FA_NOTICE_ACTION, USER_2FA_NOTICE_TEXT,
  operatorEnrolmentHref, platformToggleHref, safeOperatorContinuePath, twoFactorAudience, twoFactorNoticeCopy,
  twoFactorRequiredCopy,
} from "@/lib/auth/operator-2fa-prompt";
import {
  TWO_FACTOR_ACTION, TWO_FACTOR_HREF, TWO_FACTOR_TEXT, readNoticeStatus, visibleNotices,
} from "@/components/notices/notice-model";
import { PlatformContextSwitchView } from "@/components/ui/PlatformContextSwitch";
import { PLATFORM_DIRECTORY_HREF, primaryHref } from "@/lib/space-nav";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ─────────────────────────────────────────────────────────────────────────────
console.log("A. wording selection (pure)");
{
  check("server flag true ⇒ operator; anything else ⇒ user",
    twoFactorAudience(true) === "operator" && twoFactorAudience(false) === "user"
      && twoFactorAudience(undefined as unknown as boolean) === "user" && twoFactorAudience("true" as unknown as boolean) === "user");

  const user = twoFactorNoticeCopy("user");
  check("ordinary users keep the exact prior notice (text, action, href)",
    user.title === "Protect your account with 2FA." && user.actionLabel === "Enable" && user.href === "/dashboard/settings/security");
  check("…and it IS the notice model's existing constants",
    user.title === TWO_FACTOR_TEXT && user.actionLabel === TWO_FACTOR_ACTION && user.href === TWO_FACTOR_HREF
      && USER_2FA_NOTICE_TEXT === TWO_FACTOR_TEXT && USER_2FA_NOTICE_ACTION === TWO_FACTOR_ACTION);

  const op = twoFactorNoticeCopy("operator");
  check("operators are told plainly it is required for the platform operator tools",
    op.title === "2FA is required to use the platform operator tools." && op.title === OPERATOR_2FA_NOTICE_TEXT);
  check("…the operator wording is not the 'recommended' wording", op.title !== user.title && !/protect your account/i.test(op.title));
  check("…and its action opens setup directly, cancellable (setup2fa=start, not the enforced mode)",
    op.href === START_2FA_HREF && op.href === "/dashboard/settings/security?setup2fa=start" && op.actionLabel === "Set up 2FA");

  const reqUser = twoFactorRequiredCopy("user");
  const reqOp = twoFactorRequiredCopy("operator");
  check("the widget's required banner: users keep the prior sentence",
    reqUser.body === "Your organization requires 2FA. Set it up now to continue using Fourth Meridian.");
  check("…operators read the platform-operator sentence",
    /required to use the platform operator tools/.test(reqOp.body) && /Platform Spaces/.test(reqOp.body));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. the notice rail picks the copy from the server flag only");
{
  const none = { maintenanceCollapsed: false, twoFactorDismissed: false };
  const opts = { conversationSurface: false };
  const userN = visibleNotices({ maintenance: false, twoFactorReminder: true }, none, opts);
  const opN = visibleNotices({ maintenance: false, twoFactorReminder: true, twoFactorOperator: true }, none, opts);
  check("non-operator ⇒ the prior notice, byte-for-byte",
    JSON.stringify(userN) === JSON.stringify([{ id: "two-factor", mode: "full", title: TWO_FACTOR_TEXT, actionLabel: TWO_FACTOR_ACTION, href: TWO_FACTOR_HREF }]));
  check("operator ⇒ the operator notice",
    opN.length === 1 && opN[0].id === "two-factor" && "title" in opN[0] && opN[0].title === OPERATOR_2FA_NOTICE_TEXT);
  check("an enrolled operator (no reminder) ⇒ no notice at all",
    visibleNotices({ maintenance: false, twoFactorReminder: false, twoFactorOperator: true }, none, opts).length === 0);
  check("the operator notice is still dismissable and still withheld on the AI surface",
    visibleNotices({ maintenance: false, twoFactorReminder: true, twoFactorOperator: true }, { ...none, twoFactorDismissed: true }, opts).length === 0
      && visibleNotices({ maintenance: false, twoFactorReminder: true, twoFactorOperator: true }, none, { conversationSurface: true }).length === 0);
  check("readNoticeStatus keeps the flag only when exactly true",
    readNoticeStatus({ maintenance: false, twoFactorReminder: true, twoFactorOperator: true })!.twoFactorOperator === true
      && !("twoFactorOperator" in readNoticeStatus({ maintenance: false, twoFactorReminder: true, twoFactorOperator: "true" })!)
      && !("twoFactorOperator" in readNoticeStatus({ maintenance: false, twoFactorReminder: true })!));
  const status = code(read("lib/platform/notices/app-notice-status.ts"));
  check("the flag is the server's grant count (directory.server), only for a user without 2FA",
    /import \{ hasActivePlatformGrants \} from "@\/lib\/platform\/directory\.server";/.test(status)
      && /const operator = me && !me\.totpEnabled \? await hasActivePlatformGrants\(userId\) : false;/.test(status));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("C. the Platform toggle");
{
  const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const render = (operatorTotpPending: boolean | undefined) =>
    renderToStaticMarkup(createElement(PlatformContextSwitchView, { hasPlatformGrants: true, pathname: "/dashboard/spaces", operatorTotpPending }));

  const enrolHref = "/dashboard/settings/security?setup2fa=true&next=%2Fdashboard%2Fplatform";
  check("pending operator ⇒ the Platform segment opens the existing enrolment widget, enforced mode, returning to Platform",
    hrefs(render(true)).join() === [primaryHref("spaces"), enrolHref].join(), hrefs(render(true)).join());
  check("enrolled / not enforced ⇒ exactly the prior two links (does nothing extra)",
    hrefs(render(false)).join() === [primaryHref("spaces"), PLATFORM_DIRECTORY_HREF].join()
      && render(undefined) === render(false));
  check("no grant ⇒ still nothing, whatever the flag", renderToStaticMarkup(createElement(PlatformContextSwitchView, { hasPlatformGrants: false, pathname: null, operatorTotpPending: true })) === "");
  check("platformToggleHref is pure over the server flag",
    platformToggleHref(true) === enrolHref && platformToggleHref(false) === PLATFORM_HOME_HREF && PLATFORM_HOME_HREF === PLATFORM_DIRECTORY_HREF);
  check("the enrolment href uses the same enforced mode as the server redirect (setup2fa=true)",
    operatorEnrolmentHref().startsWith("/dashboard/settings/security?setup2fa=true&"));
  check("an unsafe return path never reaches the href", operatorEnrolmentHref("//evil.example") === enrolHref);

  const layout = read("app", "(shell)", "dashboard", "layout.tsx");
  check("layout: pending = grant held AND enforcement on AND no TOTP (fresh read), fail-quiet false",
    /let operatorTotpPending = false;\s*if \(hasPlatformGrants && env\.isOperatorTotpEnforced\) \{\s*operatorTotpPending = !\(await operatorHasTotp\(session\.user\.id\)\.catch\(\(\) => true\)\);\s*\}/.test(layout));
  check("layout → chrome → header → switch, as server props",
    /<DashboardChrome hasPlatformGrants=\{hasPlatformGrants\} operatorTotpPending=\{operatorTotpPending\}/.test(layout)
      && /<GlobalHeader hasPlatformGrants=\{hasPlatformGrants\} operatorTotpPending=\{operatorTotpPending\} \/>/.test(read("components", "ui", "DashboardChrome.tsx")));
  const sw = code(read("components", "ui", "PlatformContextSwitch.tsx"));
  check("the switch still fetches nothing and touches no storage or cookie",
    !/fetch\(|localStorage|sessionStorage|document\.cookie|cookies\(/.test(sw));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. enrolment widget: auto-open + continue");
{
  const totp = code(read("components", "dashboard", "TotpSection.tsx"));
  check("setup auto-opens for the enforced mode OR an explicit start",
    totp.includes('const enforced     = enforcedProp || searchParams.get("setup2fa") === "true";')
      && totp.includes('const autoStart    = enforced || searchParams.get("setup2fa") === "start";'));
  check("…and never once 2FA is on (does nothing extra for an enrolled operator)",
    /if \(!autoStart \|\| loading \|\| status\?\.totpEnabled\) return;/.test(totp));
  check("the start mode stays cancellable (only `enforced` hides Cancel / blocks close)",
    /onClose=\{\(\) => \{ if \(!enforced\) setModal\(null\); \}\}/.test(totp) && /\{!enforced && \(/.test(totp));
  check("continue is for the operator audience only, through the validator",
    /const continueTo = audience === "operator" \? safeOperatorContinuePath\(searchParams\.get\("next"\)\) : null;/.test(totp));
  check("continue happens after the session update, as a full navigation",
    totp.indexOf("await updateSession({ requireTotpSetup: false });") < totp.indexOf("if (continueTo) window.location.assign(continueTo);"));
  check("crypto/verification untouched: the same two endpoints, same bodies",
    /fetch\("\/api\/user\/totp\/setup", \{ method: "POST" \}\)/.test(totp)
      && /fetch\("\/api\/user\/totp\/verify", \{/.test(totp) && /JSON\.stringify\(\{ code: trimmed \}\)/.test(totp));

  check("the audience on Settings is a SERVER fact (getSecurity → page → SecuritySettings → TotpSection)",
    /operator: await hasActivePlatformGrants\(userId\)/.test(read("lib", "settings", "loaders.ts"))
      && /<SecuritySettings email=\{email\} operator=\{operator\} \/>/.test(read("app", "(shell)", "dashboard", "settings", "security", "page.tsx"))
      && /<TotpSection audience=\{twoFactorAudience\(operator\)\} \/>/.test(read("components", "settings", "SecuritySettings.tsx")));

  // The return path: same-origin Platform paths only.
  for (const ok of ["/dashboard/platform", "/dashboard/platform/PLATFORM_OPS", "/dashboard/platform/ai", "/merchant-ops"]) {
    check(`continue accepts ${ok}`, safeOperatorContinuePath(ok) === ok);
  }
  for (const bad of [null, undefined, "", "//evil.example", "/\\evil.example", "https://evil.example/dashboard/platform",
    "/%2F%2Fevil.example", "/dashboard", "/dashboard/platformx", "/dashboard/brief", "/login", "javascript:alert(1)", 42]) {
    check(`continue refuses ${JSON.stringify(bad)}`, safeOperatorContinuePath(bad) === null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("E. server enforcement unchanged");
{
  check("the env switch still accepts only \"enforce\"",
    /get isOperatorTotpEnforced\(\) \{ return _e\.OPERATOR_TOTP_ENFORCEMENT === "enforce"; \}/.test(read("lib", "env.ts")));
  check("the enrolment redirect constant is unchanged",
    /OPERATOR_TOTP_ENROLMENT_PATH = "\/dashboard\/settings\/security\?setup2fa=true"/.test(read("lib", "platform", "authorize.ts")));
  check("the Platform directory still redirects an un-enrolled operator server-side",
    /env\.isOperatorTotpEnforced && !\(await operatorHasTotp\(session\.user\.id\)\)\) redirect\(OPERATOR_TOTP_ENROLMENT_PATH\)/.test(
      code(read("app", "(shell)", "dashboard", "platform", "page.tsx"))));
  const helper = code(read("lib", "auth", "operator-2fa-prompt.ts"));
  check("the UX helper decides nothing: no env, db, session or guard import",
    !/@\/lib\/env|@\/lib\/db|next-auth|platform\/authorize|server-only/.test(helper));
}

console.log(failures === 0 ? "\noperator-2fa-prompt: all checks passed." : `\noperator-2fa-prompt: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
