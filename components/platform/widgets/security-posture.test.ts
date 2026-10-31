/**
 * components/platform/widgets/security-posture.test.ts  (BETA V2 · Workstream W4)
 *
 * RENDER-PATH proof for the Security Ops "Security posture" surface and its pure
 * view, plus the anomaly projection core (house pattern: standalone tsx +
 * renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/security-posture.test.ts
 *
 * Pinned:
 *   1. the host adapter's first frame is loading inside ONE SectionSurface; the four
 *      absorbed adapters render nothing; the host is the composition's first key
 *   2. the posture row is Detections | Coverage | Notes with VRule separators, Detections first
 *   3. HONESTY FIX — the login-failure pulse is labelled as what it counts, with its basis
 *   4. HONESTY FIX — the anomaly KEY is rendered as kind + opaque digest; never the raw
 *      identifier or IP; the same key correlates across trips; magnitude = count vs threshold
 *   5. coverage ratios come from the house pair over route counts; no users ⇒ Unavailable, never 0 %
 *   6. Notes is the absence block: four Unavailables + Provenance "no authority", no urgency colour
 *   7. the three feeds humanise, attribute, state their depth; the result is a word in its tone; no note
 *   8. empty trips carry the coverage caveat; the surface never reads as secure or healthy
 *   9. one failing route leaves its group absent-and-saying-so; the others still answer
 *  10. privacy: no email, IP, user-agent, userId in the markup; the route no longer emits the key
 *  11. purity: the view authors no metric and reads no clock; the widget fetches five literals and
 *      imports no server module; tokens only across every Sec* file
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AnomaliesResponse, AnomalyTrip } from "@/app/api/platform/security-ops/anomalies/route";
import type { PlatformAuthPosture } from "@/app/api/platform/security-ops/auth-posture/route";
import type { PlatformAuditResponse } from "@/app/api/platform/security-ops/audit/route";
import type { OperatorActionsResponse } from "@/app/api/platform/security-ops/operator-actions/route";
import type { PlatformSessionsResponse } from "@/app/api/platform/security-ops/sessions/route";
import { anomalyKeyKind, keyRefFromKeyHash, projectAnomalyTrip } from "@/lib/platform/security/anomalies-core";
import { hashedAnomalyKey } from "@/lib/security/identifier-hash";
import { SecurityPostureSurface, type SecurityPostureSources } from "./SecurityPostureWidget";
import { SecAuthPostureWidget } from "./SecAuthPostureWidget";
import { SecAnomaliesWidget } from "./SecAnomaliesWidget";
import { AUDIT_SURFACE_TITLE, EndUserAuthGroup, SecAuditFeedWidget } from "./SecAuditFeedWidget";
import { OPERATOR_ACTIONS_SURFACE_TITLE, OperatorActionsGroup, SecOperatorActionsWidget } from "./SecOperatorActionsWidget";
import { SecSessionsWidget } from "./SecSessionsWidget";
import {
  COVERAGE_DENOMINATOR_NOTE, DETECTOR_COVERAGE, NOTES_ABSENT, POSTURE_FOOTNOTE, POSTURE_TITLE, PULSE_BASIS, SECURITY_POSTURE_HOST_KEY,
  anomalyKeyLabel, coverageReadings, feedDepthText, pulseReading, tripMagnitude, tripsEmptyText,
  type Fetched,
} from "./security-posture-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const WIDGET = "components/platform/widgets/SecurityPostureWidget.tsx";
const PARTS = "components/platform/widgets/SecurityPostureParts.tsx";
const VIEW = "components/platform/widgets/security-posture-view.ts";
const CORE = "lib/platform/security/anomalies-core.ts";
const ROUTE = "app/api/platform/security-ops/anomalies/route.ts";
const ADAPTERS = ["SecAuthPostureWidget", "SecAnomaliesWidget", "SecAuditFeedWidget", "SecOperatorActionsWidget", "SecSessionsWidget"] as const;
const SECTION = { id: "s1", key: "sec_auth_posture", label: "Authentication Posture" };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-15T12:00:00.000Z");
const AGO = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const RAW_ACCOUNT_KEY = "identifier:alice@example.com";
const RAW_IP_KEY = "ip:203.0.113.42";
const RAW_RECOVERY_KEY = "recovery:alice@example.com";
// Comms Center A-2b: rows carry the writers' salted keyHash beside the raw key;
// keyRef derives from keyHash only (a fixed test salt, never a real one).
const SALT = { SECURITY_IDENTIFIER_HASH_SALT: "security-posture-test-salt" };
const KH = (raw: string) => hashedAnomalyKey(raw, SALT);
/** The ref the surface must show for a raw key: "h" + the first 8 hex of its salted hash. */
const refOf = (raw: string) => keyRefFromKeyHash(KH(raw));

/** Trips as the ROUTE now projects them — through the core, from rows carrying the raw keys. */
const trips: AnomalyTrip[] = [
  projectAnomalyTrip({ id: "trip_1", createdAt: AGO(1), metadata: { key: RAW_ACCOUNT_KEY, keyHash: KH(RAW_ACCOUNT_KEY), type: "failed_login_identifier", count: 7, threshold: 5, windowMinutes: 15 } }, 15),
  projectAnomalyTrip({ id: "trip_2", createdAt: AGO(3), metadata: { key: RAW_IP_KEY, keyHash: KH(RAW_IP_KEY), type: "failed_login_ip", count: 12, threshold: 10, windowMinutes: 15 } }, 15),
  projectAnomalyTrip({ id: "trip_3", createdAt: AGO(20), metadata: { key: RAW_RECOVERY_KEY, keyHash: KH(RAW_RECOVERY_KEY), type: "recovery_code_streak", count: 3, threshold: 3, windowMinutes: 15 } }, 15),
  projectAnomalyTrip({ id: "trip_4", createdAt: AGO(22), metadata: { key: RAW_ACCOUNT_KEY, keyHash: KH(RAW_ACCOUNT_KEY), type: "failed_login_identifier", count: 6, threshold: 5, windowMinutes: 15 } }, 15),
  projectAnomalyTrip({ id: "trip_5", createdAt: AGO(30), metadata: { key: "system_admin_disabled", type: "system_admin_disabled", count: 1 } }, 15), // pre-threshold row
];
const anomalies: AnomaliesResponse = { trips, summary: { failedLoginsWindow: 4, windowMinutes: 15, tripsLast24h: 4 } };
const posture: PlatformAuthPosture = { totalUsers: 12, totpEnabled: 8, forcedResetPending: 1, activeSessions: 5, usersWithRecoveryCodes: 6 };
const audit: PlatformAuditResponse = { events: [
  { id: "a1", action: "TWO_FACTOR_ENABLED", at: AGO(2).toISOString(), actor: "alice" },
  { id: "a2", action: "LOGIN_FAILED", at: AGO(5).toISOString(), actor: "system" },
] };
const operators: OperatorActionsResponse = { events: [
  { id: "o1", action: "CUSTOMER_POLICY_ASSIGNED", at: AGO(1).toISOString(), operator: "chris", target: "bob", reasonCode: "SUPPORT_REQUEST", result: "SUCCESS", execution: null },
  { id: "o2", action: "CONNECTION_RESYNC_TRIGGERED", at: AGO(4).toISOString(), operator: "chris", target: "plaid item …abc123", reasonCode: null, result: "REFUSED", execution: { refreshExecutionId: "exec_zz1234" } },
] };
const sessions: PlatformSessionsResponse = { totalActive: 5, distinctUsers: 3, recent: [{ id: "s1", device: "Desktop", browser: "Chrome", os: "macOS", at: AGO(0.5).toISOString() }] };

const ok = <T,>(data: T): Fetched<T> => ({ data, loading: false, error: null });
const LOADING: Fetched<never> = { data: null, loading: true, error: null };
const failed = (error: string): Fetched<never> => ({ data: null, loading: false, error });

const sources = (over: Partial<SecurityPostureSources> = {}): SecurityPostureSources => ({
  anomalies: ok(anomalies), posture: ok(posture), sessions: ok(sessions), ...over,
});
// Redesign §4.9 — the two feeds moved to their own workspaces; their groups render standalone.
const feeds = (a: Fetched<PlatformAuditResponse> = ok(audit), o: Fetched<OperatorActionsResponse> = ok(operators)) => {
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(EndUserAuthGroup, { audit: a, nowMs: NOW.getTime() }),
    createElement(OperatorActionsGroup, { operators: o, nowMs: NOW.getTime() })));
  return { html, text: text(html) };
};
const render = (s: SecurityPostureSources) => {
  const html = renderToStaticMarkup(createElement(SecurityPostureSurface, { sources: s, nowMs: NOW.getTime() }));
  return { html, text: text(html) };
};
const badgeWords = (html: string) => [...html.matchAll(/<span class="text-xs font-medium">([^<]*)<\/span>/g)].map((m) => m[1]);
const REASSURING = /\bsecure\b|healthy|all clear|all good|no issues|operating normally|no threats/i;

function main() {
  console.log("1. hosting — Posture renders the surface; Audit and Operator actions render their own; two render nothing");
  {
    const host = renderToStaticMarkup(createElement(SecAuthPostureWidget, { section: SECTION }));
    check("host first frame: ONE section titled Security posture", (host.match(/<section/g) ?? []).length === 1 && text(host).includes(POSTURE_TITLE));
    check("every gated source is loading as a status (two for anomalies: column + trips group; posture; sessions)", (host.match(/role="status"/g) ?? []).length === 4, String((host.match(/role="status"/g) ?? []).length));
    check("no figure, no badge in the first frame", badgeWords(host).length === 0 && !/text-2xl/.test(host));
    for (const [name, C] of [["SecAnomaliesWidget", SecAnomaliesWidget], ["SecSessionsWidget", SecSessionsWidget]] as const) {
      check(`${name} renders nothing (absorbed)`, renderToStaticMarkup(createElement(C, { section: SECTION })) === "");
    }
    for (const [name, C, title] of [["SecAuditFeedWidget", SecAuditFeedWidget, AUDIT_SURFACE_TITLE], ["SecOperatorActionsWidget", SecOperatorActionsWidget, OPERATOR_ACTIONS_SURFACE_TITLE]] as const) {
      const w = renderToStaticMarkup(createElement(C, { section: SECTION }));
      check(`${name} renders its own workspace surface (one section, its title, loading as a status)`,
        (w.match(/<section/g) ?? []).length === 1 && text(w).includes(title) && /role="status"/.test(w));
    }
    const hostDone = render(sources());
    check("the posture surface no longer carries the two moved feeds", !hostDone.text.includes("End-user auth") && !/Operator actions/.test(hostDone.text));
    check("the host key is the first key composed into the SECURITY_OPS Overview", SECURITY_POSTURE_HOST_KEY === "sec_auth_posture", SECURITY_POSTURE_HOST_KEY);
    check("…and the hosting adapter is that key's widget", /SecurityPostureWidget/.test(strip("components/platform/widgets/SecAuthPostureWidget.tsx")));
  }

  console.log("2. the posture row");
  {
    const { html, text: t } = render(sources());
    const d = t.indexOf("Detections"), c = t.indexOf("Coverage"), n = t.indexOf("Notes");
    check("Detections | Coverage | Notes, in that order (Detections first below md too)", d >= 0 && d < c && c < n, `${d} ${c} ${n}`);
    check("two VRule separators, collapsing by class", (html.match(/md:block/g) ?? []).length >= 2 && (strip(WIDGET).match(/<VRule \/>/g) ?? []).length === 2 && !/matchMedia/.test(strip(WIDGET)), String((html.match(/md:block/g) ?? []).length));
    check("columns stack below md and row from md", /flex flex-col gap-8 md:flex-row/.test(html));
    check("exactly one surface frame", (html.match(/var\(--shadow-e2\)/g) ?? []).length === 1);
    check("footnote states the five-route basis and the identity rule", t.includes(POSTURE_FOOTNOTE));
  }

  console.log("3. HONESTY FIX · the pulse is labelled as what it counts");
  {
    const { html, text: t } = render(sources());
    check("label: login failures · all reasons · platform-wide · window", t.includes("Login failures · all reasons · platform-wide · 15 m"), t.slice(0, 600));
    check("its derivation names the population and denies the per-account threshold", t.includes(PULSE_BASIS));
    check("the value is the route's raw count", /Login failures · all reasons · platform-wide · 15 m 4 raw volume, not a trip/.test(t), t.slice(0, 600));
    check("the old 'fails · 15m' label is gone", !/fails ·/.test(html) && !/fails · 15m/.test(strip("components/platform/widgets/SecAnomaliesWidget.tsx")));
    check("trips · 24 h is a separate reading with its own basis", t.includes("Detector trips · 24 h 4 one per open (key, window)"), t.slice(0, 800));
    check("view: the pulse reading is pure words over the summary", pulseReading({ failedLoginsWindow: 9, windowMinutes: 15, tripsLast24h: 0 }).value === "9");
  }

  console.log("4. HONESTY FIX · the anomaly key is rendered — as kind + opaque digest");
  {
    const { html, text: t } = render(sources());
    for (const h of ["Type", "Key", "Magnitude", "When"]) check(`trip column "${h}"`, t.includes(h));
    check("type words", ["Failed-login burst (account)", "Failed-login burst (IP)", "Invalid recovery-code streak", "Disabled-admin probe"].every((w) => t.includes(w)), t);
    const accountRef = refOf(RAW_ACCOUNT_KEY);
    check("an account key renders as 'account h<keyHash prefix>'", t.includes(`account ${accountRef}`), accountRef);
    check("an IP key renders as 'IP h<keyHash prefix>'", t.includes(`IP ${refOf(RAW_IP_KEY)}`));
    check("a recovery key names the kind", t.includes(`recovery on account ${refOf(RAW_RECOVERY_KEY)}`));
    check("the disabled-admin key needs no digest", t.includes("disabled admin account"));
    // A-2b: the salted hash covers the VALUE (the kind stays a separate word), so the two
    // account trips AND the recovery streak on the same account share one ref — three rows.
    check("the SAME account correlates across its trips, recovery streak included (ref appears 3×)", (t.match(new RegExp(accountRef, "g")) ?? []).length === 3, String((t.match(new RegExp(accountRef, "g")) ?? []).length));
    check("…and a different key (the IP) has its own ref", (t.match(new RegExp(refOf(RAW_IP_KEY), "g")) ?? []).length === 1);
    check("NEVER the raw identifier, the domain, the IP or the key prefix", !/alice@|example\.com|203\.0\.113|identifier:|ip:203/.test(html), html.match(/alice@|example\.com|203\.0\.113|identifier:/)?.[0]);
    check("magnitude = count against the threshold that tripped", t.includes("7 of ≥5 in 15 m") && t.includes("12 of ≥10 in 15 m"));
    check("a pre-threshold row says the threshold is not recorded, never assumes one", t.includes("1 in 15 m · threshold not recorded"));
    check("rows are in the route's order (newest first), never re-sorted here", t.indexOf("7 of ≥5") < t.indexOf("12 of ≥10") && t.indexOf("12 of ≥10") < t.indexOf("6 of ≥5") && !/\.sort\(/.test(strip("components/platform/widgets/SecAnomaliesWidget.tsx") + strip(VIEW)));
    check("the trips feed states its depth", t.includes(feedDepthText(5, "trips")));
    check("trip header hidden below md, cells carry their column word", /class="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"/.test(html) && /md:hidden">Key</.test(html));
    // The core, directly.
    check("core: key kinds from the detector's prefixes", anomalyKeyKind("identifier:x") === "account" && anomalyKeyKind("ip:1.2.3.4") === "ip" && anomalyKeyKind("recovery:x") === "recovery" && anomalyKeyKind("system_admin_disabled") === "admin" && anomalyKeyKind("weird") === "unknown");
    // Comms Center A-2b: keyRef = "h" + the first 8 hex of the salted keyHash — a literal prefix of the audit row's keyHash.
    check("core: keyRef is 'h' + 8 hex, a literal prefix of the stored keyHash's hash part, stable, distinct per key",
      /^h[0-9a-f]{8}$/.test(accountRef) && KH(RAW_ACCOUNT_KEY).startsWith(`identifier:${accountRef}`) && refOf(RAW_ACCOUNT_KEY) === accountRef && refOf(RAW_IP_KEY) !== accountRef && keyRefFromKeyHash(undefined) === "" && keyRefFromKeyHash("") === "");
    check("core: the ref never contains the identifier", !accountRef.includes("alice") && !refOf(RAW_IP_KEY).includes("203"));
    check("core: rows with a keyHash are not legacy", trips.slice(0, 4).every((tr) => tr.legacy === false));
    const legacy = projectAnomalyTrip({ id: "x", createdAt: NOW, metadata: { type: "failed_login_ip" } }, 15);
    check("core: a row with no key / count / threshold / window is unknown · 0 · null · default, never invented",
      legacy.keyKind === "unknown" && legacy.keyRef === "" && legacy.legacy === true && legacy.count === 0 && legacy.threshold === null && legacy.windowMinutes === 15);
    const rawOnly = projectAnomalyTrip({ id: "y", createdAt: NOW, metadata: { key: RAW_IP_KEY, type: "failed_login_ip", count: 12 } }, 15);
    check("core: a LEGACY row (raw key, no keyHash) keeps its kind, gets an EMPTY ref and legacy: true — nothing derived from the raw key",
      rawOnly.keyKind === "ip" && rawOnly.keyRef === "" && rawOnly.legacy === true && !JSON.stringify(rawOnly).includes("203.0.113"));
    const fnv = (k: string) => { let h = 0x811c9dc5; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
    const outputs = JSON.stringify([...trips, rawOnly]);
    check("core: no unsalted FNV digest of any raw key appears in the projection",
      [RAW_ACCOUNT_KEY, RAW_IP_KEY, RAW_RECOVERY_KEY].every((k) => !outputs.includes(fnv(k).slice(-6)) && !outputs.includes(fnv(k))));
    check("core: the projection carries no raw key and no hash of it other than the salted keyHash prefix",
      !/alice|203\.0\.113|identifier:|recovery:/.test(outputs));
    check("view: a LEGACY row (no keyHash) reads 'legacy (digest unavailable)' — kind known or not",
      anomalyKeyLabel(rawOnly) === "legacy (digest unavailable)" && anomalyKeyLabel(legacy) === "legacy (digest unavailable)");
    check("view: 'no key recorded' only for a row that is neither legacy nor carries a keyRef",
      anomalyKeyLabel({ keyKind: "unknown", keyRef: "", legacy: false }) === "no key recorded" && anomalyKeyLabel({ keyKind: "unknown", keyRef: "" }) === "no key recorded"
        && anomalyKeyLabel({ keyKind: "ip", keyRef: refOf(RAW_IP_KEY), legacy: false }) === `IP ${refOf(RAW_IP_KEY)}`
        && tripMagnitude({ count: 2, threshold: null, windowMinutes: 15 }).includes("threshold not recorded"));
    check("view: the value-free admin key stays 'disabled admin account', legacy or not",
      anomalyKeyLabel({ keyKind: "admin", keyRef: "", legacy: true }) === "disabled admin account" && anomalyKeyLabel({ keyKind: "admin", keyRef: "", legacy: false }) === "disabled admin account");
    const legacyHtml = render(sources({ anomalies: ok({ trips: [rawOnly], summary: { failedLoginsWindow: 0, windowMinutes: 15, tripsLast24h: 1 } }) }));
    check("render: a legacy trip shows 'legacy (digest unavailable)', never 'no key recorded' and never the raw IP",
      legacyHtml.text.includes("legacy (digest unavailable)") && !legacyHtml.text.includes("no key recorded") && !/203\.0\.113/.test(legacyHtml.html));
  }

  console.log("5. coverage — the house ratio over route counts; no users ⇒ Unavailable");
  {
    const { text: t } = render(sources());
    check("MFA adoption 67% · 8 of 12", t.includes("MFA adoption 67% 8 of 12 users with TOTP enabled"), t);
    check("recovery-code coverage 50% · 6 of 12", t.includes("Recovery-code coverage 50% 6 of 12 users hold ≥1 unused code"), t);
    check("forced resets pending is a count with its basis", t.includes("Forced password resets pending 1") && t.includes("COUNT(User.forcePasswordReset = true), counted now"));
    check("every ratio names its denominator (deactivated included)", (t.match(new RegExp(COVERAGE_DENOMINATOR_NOTE.replace(/[()]/g, "\\$&"), "g")) ?? []).length === 2);
    const none = render(sources({ posture: ok({ totalUsers: 0, totpEnabled: 0, forcedResetPending: 0, activeSessions: 0, usersWithRecoveryCodes: 0 }) }));
    check("zero users ⇒ em-dash + reason, never 0% or NaN", none.text.includes("no User rows to measure against") && !/0%|NaN/.test(none.text), none.text.slice(0, 900));
    check("view: coverage readings are three, with the ratio null when undefined", coverageReadings({ totalUsers: 0, totpEnabled: 0, forcedResetPending: 0, activeSessions: 0, usersWithRecoveryCodes: 0 }).filter((r) => r.value === null).length === 2);
    check("view authors no ratio of its own — it imports the house pair", /import \{ barFraction, formatRate \} from "\.\/growth-funnel-view"/.test(strip(VIEW)) && !/\/\s*(p|d)\.totalUsers/.test(strip(VIEW)));
  }

  console.log("6. Notes is the absence block");
  {
    const { html, text: t } = render(sources());
    const notes = html.slice(html.indexOf(">Notes<"), html.indexOf("Anomaly trips"));
    check("the four absences are named", NOTES_ABSENT.every((n) => t.includes(n.label) && t.includes(n.reason)));
    check("each absence is an Unavailable (em-dash + reason), not a zero", (notes.match(/—/g) ?? []).length >= 4 && !/>0</.test(notes));
    check("Provenance 'no authority' for the four, and the real sources are chips", t.includes("no authority") && ["AuditLog", "User", "RecoveryCode", "UserSession"].every((s) => t.includes(s)) && /font-mono/.test(notes));
    check("Notes carries no urgency colour", !/--coral-|--emerald-|--accent-negative|--accent-positive|--accent-warning/.test(notes), notes.match(/--coral-|--emerald-/)?.[0]);
  }

  console.log("7. the three feeds");
  {
    const { html: hostHtml, text: hostText } = render(sources());
    const f = feeds();
    const html = f.html + hostHtml, t = f.text + " " + hostText;
    check("end-user auth: action humanised, actor attributed, depth stated", t.includes("Two factor enabled alice") && t.includes("Login failed system") && t.includes(feedDepthText(2, "security events")));
    check("operator actions: P1 label, operator → target · reason code", t.includes("Assigned a policy group chris → bob · support request"), t);
    check("operator actions: an execution handle is opaque", t.includes("Resynced a connection chris → plaid item …abc123 · refresh …zz1234"), t);
    check("operator actions: the result is a WORD in its tone; success is not badged", badgeWords(html).includes("refused") && !badgeWords(html).includes("succeeded"), badgeWords(html).join(","));
    check("operator actions: depth stated; never the note", t.includes(feedDepthText(2, "operator actions")) && !/\.note\b/.test(strip("components/platform/widgets/SecOperatorActionsWidget.tsx")));
    check("sessions: counts with their derivation", t.includes("Active sessions 5") && t.includes("Distinct users with a session 3") && t.includes("UserSession.revokedAt IS NULL"));
    check("sessions: browser · device · OS, depth stated", t.includes("Chrome · Desktop · macOS") && t.includes(feedDepthText(1, "recently active sessions")));
    const emptyFeeds = feeds(ok({ events: [] }), ok({ events: [] }));
    const emptyHost = render(sources({ sessions: ok({ totalActive: 0, distinctUsers: 0, recent: [] }) }));
    const empties = { text: emptyFeeds.text + " " + emptyHost.text };
    check("empty feeds say 'no … in the route's newest page' as a status", empties.text.includes("no security events in the route's newest page") && empties.text.includes("no operator actions in the route's newest page") && empties.text.includes("no recently active sessions in the route's newest page"));
  }

  console.log("8. empty trips and the reassurance ban");
  {
    const quiet = render(sources({ anomalies: ok({ trips: [], summary: { failedLoginsWindow: 0, windowMinutes: 15, tripsLast24h: 0 } }) }));
    check("no trips ⇒ the coverage caveat, as a status", quiet.text.includes(tripsEmptyText()) && quiet.text.includes(DETECTOR_COVERAGE) && /role="status"/.test(quiet.html));
    check("the surface never reads as secure or healthy", !REASSURING.test(quiet.text) && !REASSURING.test(render(sources()).text), quiet.text.match(REASSURING)?.[0]);
    check("the pulse at zero is still a count, not a verdict", quiet.text.includes("Login failures · all reasons · platform-wide · 15 m 0"));
  }

  console.log("9. one failing route");
  {
    const { html, text: t } = render(sources({ anomalies: failed("Request failed (500)") }));
    check("the Detections column and the trips group each say the source could not be read, as alerts", (html.match(/role="alert"/g) ?? []).length === 2 && t.includes("Anomalies could not be read (Request failed (500)) — this group is absent, not empty."), t.slice(0, 500));
    check("the other sources on the posture surface still answer", t.includes("MFA adoption 67%") && t.includes("Chrome · Desktop · macOS"));
    const half = render(sources({ posture: LOADING }));
    check("a loading source is a status inside its column, nothing else blocked", /role="status"/.test(half.html) && half.text.includes("7 of ≥5 in 15 m"));
  }

  console.log("10. privacy");
  {
    const { html } = render(sources());
    check("no email-shaped string", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(html));
    check("no IPv4 literal", !/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(html));
    check("no user-agent string, no userId, no raw key", !/Mozilla|userId|identifier:/.test(html));
    const route = strip(ROUTE);
    check("route: projects every trip through the pure core", /projectAnomalyTrip\(r, windowMinutes\)/.test(route) && !/\bkey:\s/.test(route));
    check("route: selects no email / ip / user-agent", !/email:\s*true|ipAddress:\s*true|userAgent:\s*true/.test(route));
    check("route: still gated SECURITY_OPS READ before reading", /requirePlatformAccess\(\s*["']SECURITY_OPS["']\s*,\s*["']READ["']\s*\)/.test(route) && route.indexOf("requirePlatformAccess") < route.indexOf("findMany"));
    check("core: pure (no db, no clock, no env)", !/@\/lib\/db|server-only|Date\.now|new Date\(|process\.env/.test(strip(CORE)));
  }

  console.log("11. purity and grammar");
  {
    const view = strip(VIEW);
    check("view: React-free, clock-free, fetch-free", !/from "react"|Date\.now\(|new Date\(|\bfetch\(/.test(view));
    check("view: imports only types from the routes", !/import \{[^}]*\} from "@\/app\/api/.test(view.replace(/import type[^;]+;/g, "")));
    const w = strip(WIDGET);
    const urls = [...w.matchAll(/useWidgetFetch<[^>]+>\("([^"]+)"\)/g)].map((m) => m[1]);
    // Redesign §4.9 — the audit and operator-action feeds are fetched by their own workspace widgets.
    check("widget: exactly three reads, each a string literal, one per route", urls.length === 3 && new Set(urls).size === 3 && urls.every((u) => u.startsWith("/api/platform/security-ops/")) && (w.match(/useWidgetFetch</g) ?? []).length === 3, urls.join(","));
    for (const [f, route] of [["components/platform/widgets/SecAuditFeedWidget.tsx", "/api/platform/security-ops/audit"], ["components/platform/widgets/SecOperatorActionsWidget.tsx", "/api/platform/security-ops/operator-actions"]] as const) {
      const g = strip(f);
      check(`${f}: one static-URL read of its own route`, (g.match(/useWidgetFetch</g) ?? []).length === 1 && g.includes(`useWidgetFetch<`) && g.includes(`("${route}")`));
    }
    check("widget: no sort, no derived metric, one mount clock", !/\.sort\(/.test(w) && !/\/\s*\w+\.totalUsers/.test(w) && /useState\(\(\) => Date\.now\(\)\)/.test(w));
    check("widget + parts + groups: import no reader or server module", ![WIDGET, PARTS, ...ADAPTERS.map((a) => `components/platform/widgets/${a}.tsx`)].some((f) => /@\/lib\/db|server-only|customer-core|@\/lib\/platform\/security\/anomalies-core"/.test(strip(f).replace(/import type[^;]+;/g, ""))));
    for (const f of [WIDGET, PARTS, ...ADAPTERS.map((a) => `components/platform/widgets/${a}.tsx`)]) {
      const s = strip(f);
      check(`${path.basename(f)}: tokens only — no raw hex, no palette class, no coral-500/600/700`,
        !/#[0-9a-fA-F]{3,8}\b/.test(s) && !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green|violet|yellow|amber)-\d{2,3}\b/.test(s) && !/--coral-(5|6|7)00/.test(s), s.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
      check(`${path.basename(f)}: page grain — no PlatformWidgetCard, no WidgetStat`, !/PlatformWidgetCard|WidgetStat\b/.test(s));
    }
    check("the surface imports downward only (groups → parts, surface → groups; no cycle)",
      !ADAPTERS.some((a) => /from "\.\/SecurityPostureWidget"/.test(strip(`components/platform/widgets/${a}.tsx`)) && a !== "SecAuthPostureWidget") && !/from "\.\/Sec[A-Z]/.test(strip(PARTS)));
  }

  if (failures > 0) { console.error(`\nsecurity-posture.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nsecurity-posture.test: all passed.");
}

main();
