/**
 * components/platform/comms/comms-center.test.ts  (Customer Success — Communications Center)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/comms/comms-center.test.ts
 *
 * 1. data shaping — day series (null = not observed, never drawn or summed
 *    as 0; delivery counts are never withheld), status chips, preview channels, small-cell
 *    counts, delivery tiles, list-envelope notes;
 * 2. render — the Library rendered from the REAL merged catalog handlers
 *    (lib/notifications/catalog/http.ts, PR #168), so the UI is pinned to the
 *    server's actual DTOs; the honest 503 / coming-soon states; the sandboxed
 *    preview; the three not-yet-deployed views on 200 and on 404;
 * 3. source rules — no access-level literal, no raw fetch in a view, tokens
 *    only (no raw hex), script-less iframe.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { catalogDetail, catalogList, catalogPreview, triggersList } from "@/lib/notifications/catalog/http";
import type { CatalogDetail, CatalogResponse, DaySeries, PreviewResponse, TriggersResponse } from "@/lib/notifications/catalog/types";
import type { AutomationDetail, AutomationsResponse, DeliveryAnalytics, PreferenceAggregate, RunsResponse, StatusCounts, SuppressionReason } from "@/lib/platform/comms-center/contract-v1-section-4";
import { DELIVERY_STATUSES, SUPPRESSION_REASONS } from "@/lib/platform/comms-center/contract-v1-section-4";
import { SUPPRESSION_REASONS as SERVER_SUPPRESSION_REASONS } from "@/lib/notifications/delivery/types";
import { COMMS_CATALOG, EMAIL_STORM_LIMIT } from "@/lib/notifications/catalog/definitions";
import { EMPTY_CATALOG_FILTERS, DEFAULT_DELIVERY_FILTERS } from "@/lib/platform/comms-center/client";
import type { CommsRead } from "./comms-kit";
import {
  ACTIVATION_BLOCKER_LABEL, BYKEY_STATUSES, BYKEY_STATUSES_MEASURED, DELIVERY_STATUS_LABEL, SERIES_LABEL, byKeyLine, activationLines, COMMS_POLICY, STORM_MAX_PER_HOUR, SUPPRESSION_LABEL, countCell, dayCells, daySummary, daySummaryText, deliveryTiles, envelopeNotes, isInternalPath, previewChannelsFor, protectedNote, retentionText,
  STATUS_LABEL, statusChips, stormNote, suppressionLabel, suppressionRows, totalOf,
} from "./comms-model";
import { CatalogDetailBody, LibrarySurface, PreviewRendition, PreviewSurface } from "./LibraryView";
import { AutomationDetailBody, AutomationsSurface } from "./AutomationsView";
import { DeliverySurface } from "./DeliveryView";
import { PreferencesSurface } from "./PreferencesView";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const ok = <T,>(data: T): CommsRead<T> => ({ loading: false, result: { kind: "ok", data } });
const soon: CommsRead<never> = { loading: false, result: { kind: "coming-soon", status: 404 } };
const down: CommsRead<never> = { loading: false, result: { kind: "unavailable", error: "The notification catalog is unavailable." } };
const NOW = new Date("2026-10-31T12:00:00.000Z");

function series(counts: Array<number | null>, window: DaySeries["window"] = "7d"): DaySeries {
  const days = counts.map((c, i) => ({ day: new Date(Date.UTC(2026, 9, 25 + i)).toISOString().slice(0, 10), count: c }));
  return { window, from: days[0].day, to: days[days.length - 1].day, days, floor: false };
}

async function main() {
  // Real payloads from the merged handlers (no DB, code registry).
  const catalog = (await catalogList(new URL("http://x/api?limit=100"), NOW).json()) as CatalogResponse;
  const triggers = (await triggersList(new URL("http://x/api?limit=100"), NOW).json()) as TriggersResponse;

  console.log("1. data shaping");
  {
    const s = series([3, 0, null, null, 5, null, 2]);
    const cells = dayCells(s);
    check("dense cells, one per day, states preserved", cells.map((c) => c.state).join() === "observed,observed,not-observed,not-observed,observed,not-observed,observed");
    check("a null day is never coerced to 0", cells[2].count === null && cells[3].count === null);
    const sum = daySummary(s);
    check("summary sums OBSERVED days only (3+0+5+2), counts each state", sum.total === 10 && sum.observed === 4 && sum.notObserved === 3 && sum.max === 5);
    const none = daySummary(series([null, null, null, null, null, null, null]));
    check("all-null series ⇒ total null (unknown), not 0", none.total === null && none.observed === 0);
    check("all-null wording says not observed, never '0 sends'", /Not observed yet/.test(daySummaryText(none)) && !/\b0 sends\b/.test(daySummaryText(none)));
    check("delivery day series carry no withheld wording (delivery counts are never withheld)", !/withheld/.test(daySummaryText(sum)));
    // §4.11: delivery counts are never withheld. A stray flag is not a state: null stays "not observed", a number stays itself.
    const stray: DaySeries = { ...series([null, 4]), days: [{ day: "2026-10-25", count: null, withheld: true }, { day: "2026-10-26", count: 4, withheld: true }] };
    check("a stray withheld flag on a delivery day is ignored (null ⇒ not observed, number ⇒ observed)",
      dayCells(stray).map((c) => c.state).join() === "not-observed,observed" && daySummary(stray).total === 4);

    check("status chips: every status in contract order, totals as-is",
      statusChips(catalog.totals).map((c) => c.status).join() === "ENABLED,BUILD,BUILD_OFF,PROPOSED,VOCABULARY,NONE_BY_DESIGN,RETIRED"
        && totalOf(catalog.totals) === catalog.items.length);
    check("preview channels from catalog channels", previewChannelsFor([{ channel: "EMAIL" }, { channel: "IN_APP" }]).join() === "email-html,email-text,in-app"
      && previewChannelsFor([{ channel: "OPERATOR_EMAIL" }]).join() === "operator" && previewChannelsFor([{ channel: "BANNER" }]).join() === "banner" && previewChannelsFor([]).length === 0);
    check("storm limit: applies to SERVICE / AWARENESS / MARKETING email; SECURITY_CRITICAL, CEREMONY and OPERATOR are exempt (storm.ts); absent without email",
      (["SERVICE", "AWARENESS", "MARKETING"] as const).every((c) => stormNote({ consentClass: c, channels: [{ channel: "EMAIL", defaultOn: true, templateVersion: 1, path: "DIRECT" }] }) === COMMS_POLICY.storm)
        && (["SECURITY_CRITICAL", "CEREMONY", "OPERATOR"] as const).every((c) => /^Exempt/.test(stormNote({ consentClass: c, channels: [{ channel: "EMAIL", defaultOn: true, templateVersion: 1, path: "DIRECT" }] }) ?? ""))
        && stormNote({ consentClass: "AWARENESS", channels: [{ channel: "IN_APP", defaultOn: true, templateVersion: null, path: "REGISTRY" }] }) === null);
    check("the storm number is IMPORTED from the client-safe EMAIL_STORM_LIMIT (no local literal)",
      /STORM_MAX_PER_HOUR: number = EMAIL_STORM_LIMIT\.maxPerRecipient;/.test(strip("components/platform/comms/comms-model.ts")) && !/STORM_MAX_PER_HOUR\s*=\s*\d/.test(strip("components/platform/comms/comms-model.ts")));
    check("the UI's storm number mirrors the server's EMAIL_STORM_LIMIT (5 per 60 minutes)",
      STORM_MAX_PER_HOUR === EMAIL_STORM_LIMIT.maxPerRecipient && EMAIL_STORM_LIMIT.windowMinutes === 60 && COMMS_POLICY.storm.includes(`${EMAIL_STORM_LIMIT.maxPerRecipient} emails per person per hour`)
        && /not sent/.test(COMMS_POLICY.storm));
    check("small cells: value / withheld '<5' / not observed '—'",
      countCell(12, false).text === "12" && countCell(0, false).text === "0" && countCell(null, true).state === "withheld" && countCell(null, true).text === "<5" && countCell(null, false).state === "not-observed");
    check("envelope notes: floor, capped, more", envelopeNotes({ floor: true, capped: true, nextCursor: "c" }).length === 3 && envelopeNotes({ floor: false, capped: false }).length === 0);
    const tilesNull = deliveryTiles(null, false);
    check("delivery totals null ⇒ every tile not observed (never 0), all eleven statuses", tilesNull.length === 11 && tilesNull.every((t) => t.value === null));
    check("DELIVERED / BOUNCED / COMPLAINED say 'not measured' while measured.delivered is false",
      tilesNull.filter((t) => t.note === "not measured").map((t) => t.status).join() === "DELIVERED,BOUNCED,COMPLAINED");
    const totals = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as StatusCounts;
    totals.CAPTURED = 7;
    check("observed totals keep zeros as zeros", deliveryTiles(totals, false).find((t) => t.status === "QUEUED")?.value === 0 && deliveryTiles(totals, false).find((t) => t.status === "CAPTURED")?.value === 7);
    const reasons = Object.fromEntries(SUPPRESSION_REASONS.map((r) => [r, 0])) as Record<(typeof SUPPRESSION_REASONS)[number], number>;
    reasons.PREFERENCE_OFF = 2; reasons.ENVIRONMENT_GUARD = 9;
    check("suppression rows: non-zero, largest first; null stays null", suppressionRows(reasons)!.map((r) => r.reason).join() === "ENVIRONMENT_GUARD,PREFERENCE_OFF" && suppressionRows(null) === null);
    // v1.0.3: the reason vocabulary is the SERVER's, and every reason has operator words.
    check("SuppressionReason is the server's list (same array, incl. RATE_LIMITED / RATE_LIMIT_UNVERIFIED)",
      SUPPRESSION_REASONS === SERVER_SUPPRESSION_REASONS && SUPPRESSION_REASONS.includes("RATE_LIMITED") && SUPPRESSION_REASONS.includes("RATE_LIMIT_UNVERIFIED"));
    check("SUPPRESSION_LABEL covers exactly the server's reasons, each with real words (no humanized enum)",
      Object.keys(SUPPRESSION_LABEL).sort().join() === [...SUPPRESSION_REASONS].sort().join()
        && SUPPRESSION_REASONS.every((r: SuppressionReason) => SUPPRESSION_LABEL[r].length > 0 && (SUPPRESSION_LABEL[r] as string) !== r));
    check("storm-limit reasons read as NOT SENT (suppressed, never sent later)", SUPPRESSION_LABEL.RATE_LIMITED === "Not sent: 5 emails/hour limit" && SUPPRESSION_LABEL.RATE_LIMIT_UNVERIFIED === "Not sent: limit couldn’t be verified");
    check("in-app PREFERENCE_OFF = 'Customer turned off in-app'; email / mixed keep the generic words",
      suppressionLabel("PREFERENCE_OFF", "IN_APP") === "Customer turned off in-app" && suppressionLabel("PREFERENCE_OFF", "EMAIL") !== "Customer turned off in-app"
        && suppressionLabel("PREFERENCE_OFF", null) === SUPPRESSION_LABEL.PREFERENCE_OFF && suppressionLabel("RATE_LIMITED", "IN_APP") === SUPPRESSION_LABEL.RATE_LIMITED
        && suppressionRows(reasons, "IN_APP")!.find((r) => r.reason === "PREFERENCE_OFF")?.label === "Customer turned off in-app");
    // Exhaustiveness is a compile-time fact: `satisfies Record<SuppressionReason, string>` (pinned in source).
    check("SUPPRESSION_LABEL is exhaustive BY TYPE (satisfies Record<SuppressionReason, string>)",
      /SUPPRESSION_LABEL = \{[\s\S]*?\} as const satisfies Record<SuppressionReason, string>;/.test(readFileSync(path.join(process.cwd(), "components/platform/comms/comms-model.ts"), "utf8")));
  }

  console.log("2. Library render (real catalog DTOs)");
  {
    const props = { more: null, filters: EMPTY_CATALOG_FILTERS, draftQ: "", onDraftQ: () => {}, onFilters: () => {}, onOpen: () => {}, onMore: () => {}, triggers: ok(triggers), chipTotals: catalog.totals };
    const html = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: ok(catalog) }));
    check("one row per catalog item", count(html, "data-catalog-row=") === catalog.items.length, { rows: count(html, "data-catalog-row="), items: catalog.items.length });
    check("status chips rendered", html.includes("data-status-chips") && html.includes("Enabled"));
    check("rows carry key, consent class, channel, severity, automations counts", html.includes(catalog.items[0].key) && /Automations: \d+ active · \d+ paused · \d+ draft/.test(html));
    check("protected definitions carry the Protected badge", catalog.items.some((i) => i.protected) && html.includes("Protected"));
    check("list carries checkedAt and its complete/floor note", html.includes("data-list-meta") && html.includes("Checked") && html.includes("complete (not a floor, not capped)"));
    check("triggers sub-list: every trigger, AVAILABLE and PROPOSED", count(html, "data-trigger=") === triggers.items.length && html.includes("Available") && html.includes("Proposed"));
    const all5 = ["Status", "Category", "Audience", "Channel", "Consent class"].every((l) => html.includes(`>${l}<select`));
    check("five server-side filters + search", all5 && html.includes('type="search"'));

    const failed = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: down, triggers: down }));
    check("503 ⇒ honest unavailable state, never an empty list", failed.includes('data-comms-state="unavailable"') && !failed.includes("data-catalog-list") && !failed.includes("No definitions match"));
    const empty = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: ok({ ...catalog, items: [] }) }));
    check("a real empty result says so (distinct from unavailable)", empty.includes("No definitions match these filters.") && !empty.includes("data-comms-state"));

    // P2-1 — with a status selected, the server's list totals count only that
    // status; the chips must use the status-free totals (or show no counts).
    const enabledOnly = (await catalogList(new URL("http://x/api?limit=100&status=ENABLED"), NOW).json()) as CatalogResponse;
    // The comparison status is whichever OTHER status has rows today — never a
    // pinned one (BUILD empties as the backlog ships; #181 left one BUILD entry).
    const other = (Object.keys(catalog.totals) as Array<keyof typeof catalog.totals>).find((st) => st !== "ENABLED" && catalog.totals[st] > 0);
    check("(fixture) the catalog has rows outside ENABLED to compare against", other !== undefined, catalog.totals);
    const o = other ?? "BUILD";
    check("(server fact) a status-filtered list zeroes every other status in `totals`", enabledOnly.totals.ENABLED > 0 && enabledOnly.totals[o] === 0 && catalog.totals[o] > 0);
    const chip = (h: string, s: string) => h.match(new RegExp(`data-status-chip="${s}"[^>]*>([\\s\\S]*?)</button>`))?.[1] ?? "";
    const withStatus = renderToStaticMarkup(createElement(LibrarySurface, { ...props, filters: { ...EMPTY_CATALOG_FILTERS, status: "ENABLED" }, read: ok(enabledOnly), chipTotals: catalog.totals }));
    check(`status selected: unselected chips show the status-free counts (${o} is not 0)`,
      chip(withStatus, o).includes(`>${catalog.totals[o]}<`) && chip(withStatus, "ENABLED").includes(`>${catalog.totals.ENABLED}<`), chip(withStatus, o));
    check("status selected: the selected chip is pressed, the list holds only that status",
      /aria-pressed="true"[^>]*data-status-chip="ENABLED"/.test(withStatus) && count(withStatus, "data-catalog-row=") === enabledOnly.items.length);
    const unknown = renderToStaticMarkup(createElement(LibrarySurface, { ...props, filters: { ...EMPTY_CATALOG_FILTERS, status: "ENABLED" }, read: ok(enabledOnly), chipTotals: null }));
    check("status selected, chip totals not yet known ⇒ chips WITHOUT counts (never the misleading zeros)",
      chip(unknown, o).trim() === STATUS_LABEL[o] && !/>0</.test(chip(unknown, o)));

    // (5) a page with more rows is never called complete.
    // Scoped to the catalog block (the Triggers block below has its own, complete, footer).
    const paged = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: ok({ ...catalog, nextCursor: "abc" }) })).split('id="comms-triggers"')[0];
    check("nextCursor set ⇒ no 'complete' claim, a 'more rows' note and a Show more button",
      !paged.includes("complete (not a floor") && paged.includes("More rows exist beyond this page.") && paged.includes("Show more"));

    // (6) Retry on 503 / error; previous rows dimmed + aria-busy while a filter reloads.
    const retry = () => {};
    const down503 = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: { ...down, retry } }));
    check("503 offers Retry", down503.includes("data-retry") && down503.includes(">Retry<"));
    const err = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: { loading: false, result: { kind: "error", status: 500, code: null, error: "Request failed (500)." }, retry } }));
    check("error offers Retry", err.includes('data-comms-state="error"') && err.includes(">Retry<"));
    const reloading = renderToStaticMarkup(createElement(LibrarySurface, { ...props, read: { loading: true, result: null, previous: { kind: "ok", data: catalog } } }));
    check("reloading keeps the previous rows, dimmed and aria-busy, and says Updating",
      count(reloading, "data-catalog-row=") === catalog.items.length
        && /<ul[^>]*aria-busy="true"[^>]*opacity-50[^>]*data-catalog-list/.test(reloading)
        && reloading.includes("Updating the notification catalog"));
  }

  console.log("3. Detail drawer body + preview");
  {
    const prot = catalog.items.find((i) => i.protected && i.consentClass === "SECURITY_CRITICAL" && i.channels.some((c) => c.channel === "EMAIL"))!;
    const detail = (await (await catalogDetail(prot.key, NOW)).json()) as CatalogDetail;
    const details = await Promise.all(catalog.items.map(async (i) => (await (await catalogDetail(i.key, NOW)).json()) as CatalogDetail));
    const html = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(detail), preview: createElement("div", null, "PREVIEW SLOT") }));
    check("SECURITY_CRITICAL protected detail says it can't be muted", html.includes("can’t be muted"));
    check("security email: exempt from the storm limit", /Exempt from the 5-emails-per-hour limit/.test(html));
    check("delivery retention uses the ONE wording (owner policy + server caveat while they differ)", html.includes(retentionText(detail.retention.deliveryDays)));
    // v1.0.3: the merged ledger (#170) reports 90 days, so the real handler's detail carries no "pending alignment" caveat.
    check("real handler: retention.deliveryDays is 90 and the Library shows no 'pending alignment' note",
      details.every((x) => x.retention.deliveryDays === 90) && html.includes("Owner policy: 90 days, then counts only.") && !html.includes("pending alignment"), detail.retention);
    check("retentionText: caveat while the server differs, none once it reports 90, none without a server figure",
      retentionText(180) === "Owner policy: 90 days, then counts only. Server currently reports 180 days (pending alignment)."
        && retentionText(90) === "Owner policy: 90 days, then counts only." && retentionText(null) === retentionText(90));
    // A protected message a customer CAN switch off gets the operator-only note, never "muted".
    const mutable = details.find((x) => x.protected && x.userSuppressible);
    const h = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(mutable ?? { ...detail, consentClass: "CEREMONY" as const, userSuppressible: true }), preview: null }));
    // No protected definition is user-suppressible today, so this case is SYNTHETIC unless the catalog grows one.
    check(`SYNTHETIC unless the catalog has one: a protected but user-suppressible definition gets the generic note, never 'muted' (${mutable ? mutable.key : "synthetic fixture"})`,
      h.includes("Operators can’t disable, pause or re-route this message.") && !h.includes("can’t be muted"));
    const byKey = (k: string) => details.find((x) => x.key === k)!;
    const noteHtml = (k: string) => renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(byKey(k)), preview: null }));
    const ceremony = noteHtml("PASSWORD_RESET_LINK_SENT");
    check("a protected CEREMONY email (PASSWORD_RESET_LINK_SENT) says it can’t be muted, without claiming 'Security alerts'",
      byKey("PASSWORD_RESET_LINK_SENT").consentClass === "CEREMONY" && ceremony.includes(COMMS_POLICY.protectedUnmutable) && !ceremony.includes(COMMS_POLICY.protectedAlerts));
    for (const k of ["MAINTENANCE_NOTICE", "TWO_FACTOR_REMINDER", "CONNECT_INVITATION"]) {
      const b = noteHtml(k);
      check(`banner-only ${k}: 'not editable here', never 'can’t be muted'`, byKey(k).channels.every((c) => c.channel === "BANNER") && b.includes(COMMS_POLICY.protectedBanner) && !b.includes("can’t be muted"));
    }
    const none = noteHtml("BETA_REQUEST_DENIED");
    check("no channels (BETA_REQUEST_DENIED): 'No message is sent (by design).', never 'can’t be muted'",
      byKey("BETA_REQUEST_DENIED").channels.length === 0 && none.includes(COMMS_POLICY.protectedNoChannels) && !none.includes("can’t be muted"));
    const EM = [{ channel: "EMAIL" as const, defaultOn: true, templateVersion: 1, path: "DIRECT" as const }];
    check("protectedNote: by what is sent, not the consent class alone",
      protectedNote({ consentClass: "SECURITY_CRITICAL", userSuppressible: false, channels: EM }) === COMMS_POLICY.protectedAlerts
        && protectedNote({ consentClass: "OPERATOR", userSuppressible: false, channels: EM }) === COMMS_POLICY.protectedUnmutable
        && protectedNote({ consentClass: "CEREMONY", userSuppressible: true, channels: EM }) === COMMS_POLICY.protectedGeneric
        && protectedNote({ consentClass: "SERVICE", userSuppressible: false, channels: [{ channel: "BANNER", defaultOn: true, templateVersion: null, path: "READ_ONLY_SURFACE" }] }) === COMMS_POLICY.protectedBanner
        && protectedNote({ consentClass: "SECURITY_CRITICAL", userSuppressible: false, channels: [] }) === COMMS_POLICY.protectedNoChannels);

    // v1.0.3: the staff security-anomaly bell — OPERATOR class, yet protected and locked (no preference can mute it).
    const anomalyDef = COMMS_CATALOG.SECURITY_ANOMALY_DETECTED;
    const anomalyItem = catalog.items.find((i) => i.key === "SECURITY_ANOMALY_DETECTED");
    check("catalog: SECURITY_ANOMALY_DETECTED is protected and NOT userSuppressible (definition + list DTO)",
      anomalyDef.protected === true && anomalyDef.preference.userSuppressible === false
        && anomalyItem?.protected === true && anomalyItem.userSuppressible === false, { consentClass: anomalyDef.consentClass });
    const anomalyDetail = (await (await catalogDetail("SECURITY_ANOMALY_DETECTED", NOW)).json()) as CatalogDetail;
    const anomalyHtml = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(anomalyDetail), preview: null }));
    check(`Library detail: SECURITY_ANOMALY_DETECTED (consentClass ${anomalyDetail.consentClass}) says it can’t be muted`,
      anomalyHtml.includes("can’t be muted") && !anomalyHtml.includes("Operators can’t disable, pause or re-route this message."));
    check("isInternalPath: '/x' yes; '//host', 'https://', 'javascript:', '' no",
      isInternalPath("/dashboard/platform/GROWTH_REVENUE") && !isInternalPath("//evil.example") && !isInternalPath("https://x") && !isInternalPath("javascript:alert(1)") && !isInternalPath("") && !isInternalPath(null));
    const offsite = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok({ ...detail, ownerSurface: { area: "GROWTH_REVENUE", href: "//evil.example/x" } }), preview: null }));
    check("a non-internal ownerSurface href is never rendered as a link", !offsite.includes("evil.example") && !offsite.includes("Managed in"));
    check("recent series: the server's all-null series draws ONLY not-observed days (never a 0 bar)",
      count(html, 'data-day-state="not-observed"') === detail.recent.days.length && !html.includes('data-day-state="observed"'));
    check("preview slot rendered when PREVIEW is supported", detail.supportedActions.includes("PREVIEW") === html.includes("PREVIEW SLOT"));

    const piiDef = details.find((d) => d.payload.some((f) => f.pii));
    if (piiDef) {
      const h = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(piiDef), preview: null }));
      check("payload: names + PII flag, never values", h.includes("data-payload-fields") && h.includes(">PII<") && h.includes("values are never shown"));
    } else check("a catalog definition with a PII payload field exists", false);

    const mixed = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok({ ...detail, recent: series([1, null, null, 0, 4, null, 2]) }), preview: null }));
    check("recent sends: observed vs not-observed only — no withheld state or legend (delivery counts are never withheld)",
      count(mixed, 'data-day-state="not-observed"') === 3 && count(mixed, 'data-day-state="observed"') === 4 && !mixed.includes('data-day-state="withheld"') && !/Withheld/.test(mixed));

    const emailHtml = (await catalogPreview(prot.key, new URL("http://x/p?channel=email-html"), NOW).json()) as PreviewResponse;
    const ph = renderToStaticMarkup(createElement(PreviewRendition, { p: emailHtml }));
    const frame = ph.match(/<iframe[^>]*>/)?.[0] ?? "";
    check("email-html renders in a sandboxed iframe: sandbox=\"\", srcdoc, no src, no allow-*",
      frame.includes('sandbox=""') && /\ssrcdoc="/i.test(frame) && !/\ssrc="/.test(frame) && !/allow-/.test(frame), frame.slice(0, 200));
    check("the [PREVIEW] synthetic banner is shown", ph.includes("[PREVIEW] synthetic"));
    check("the subject is shown (server-prefixed [PREVIEW])", emailHtml.subject !== null && ph.includes("Subject"));
    const inAppDef = catalog.items.find((i) => i.supportedActions.includes("PREVIEW") && i.channels.some((c) => c.channel === "IN_APP"))!;
    const inApp = (await catalogPreview(inAppDef.key, new URL("http://x/p?channel=in-app"), NOW).json()) as PreviewResponse;
    check("in-app rendition renders as a card", renderToStaticMarkup(createElement(PreviewRendition, { p: inApp })).includes("data-preview-inapp"));
    const sw = renderToStaticMarkup(createElement(PreviewSurface, { channels: ["email-html", "email-text", "in-app"], channel: "email-html", onChannel: () => {}, variant: null, onVariant: () => {}, read: ok(emailHtml) }));
    check("channel switcher offers each available channel", ["Email", "Email text", "In-app"].every((l) => sw.includes(`>${l}</button>`)));
    const noRendition = renderToStaticMarkup(createElement(PreviewSurface, { channels: ["banner"], channel: "banner", onChannel: () => {}, variant: null, onVariant: () => {},
      read: { loading: false, result: { kind: "error", status: 409, code: "INVALID_STATE", error: "x" } } }));
    check("409 INVALID_STATE ⇒ 'no rendition' wording, not an error", noRendition.includes("No banner rendition exists"));
  }

  console.log("4. Automations / Delivery / Preferences — coming soon, then real data");
  {
    const autoSoon = renderToStaticMarkup(createElement(AutomationsSurface, { read: soon, onOpen: () => {} }));
    check("automations 404 ⇒ coming soon (no list), owner rules still stated", autoSoon.includes('data-comms-state="coming-soon"') && !autoSoon.includes("data-automation-list")
      && autoSoon.includes("requires elevated operator permission"));
    const autos: AutomationsResponse = { items: [{ id: "a1", name: "Reauth nudge", state: "PAUSED", triggerKey: "plaid.item.webhook_needs_reauth", definitionKey: "PLAID_ITEM_REAUTH_REQUIRED", definitionVersion: 2, channels: ["IN_APP", "EMAIL"], version: 4, activatedVersion: 3, autoPausedReason: "DEFINITION_CHANGED", lastRun: null, updatedAt: "2026-10-30T10:00:00.000Z" }],
      checkedAt: NOW.toISOString(), nextCursor: null, limit: 50, floor: false, capped: false };
    const autoOk = renderToStaticMarkup(createElement(AutomationsSurface, { read: ok(autos), onOpen: () => {} }));
    check("automations 200 ⇒ the list with state + auto-pause reason", autoOk.includes("data-automation-list") && autoOk.includes("Reauth nudge") && autoOk.includes("Auto-paused: Definition changed"));
    const detail: AutomationDetail = { ...autos.items[0], description: "", conditions: [{ op: "recipient.has_verified_email" }], recipient: { kind: "EVENT_SUBJECT_USER" }, delay: { minutes: 30 },
      dedupeKeyTemplate: "{recipientId}:{plaidItemId}", frequencyCap: { max: 1, perHours: 24 }, retryPolicy: "STANDARD", maxRecipientsPerRun: 50, history: [] };
    const runs: RunsResponse = { items: [], checkedAt: NOW.toISOString(), nextCursor: null, limit: 20, floor: false, capped: false };
    const dh = renderToStaticMarkup(createElement(AutomationDetailBody, { read: ok(detail), runs: ok(runs) }));
    check("automation detail is read-only: actions listed as seams, none a button", dh.includes("data-action-seams") && dh.includes("Activate · requires elevated operator permission · not yet available")
      && !/<button[^>]*>(Activate|Pause|Disable|Dry run|Test send)</.test(dh));
    check("a v1 detail (no activationBlockers / viewer) shows no Activation section", !dh.includes("data-activation-blockers") && !dh.includes("data-activation-ready"));
    const blockers = ["DEFINITION_CHANGED", "OWNER_APPROVAL_REQUIRED", "DRY_RUN_REQUIRED", "TRIGGER_NOT_AVAILABLE", "DEFINITION_NOT_ACTIVATABLE", "PROTECTED", "MARKETING_NOT_IN_V1", "STATE"];
    const v11 = { ...detail, activationBlockers: blockers, viewer: { activationDisabledReason: "ACTIVATION_DISABLED_PENDING_HARDENING" } };
    const dv = renderToStaticMarkup(createElement(AutomationDetailBody, { read: ok(v11 as AutomationDetail), runs: ok(runs) }));
    check("v1.1 detail: the hard gate and every blocker in plain English", dv.includes("data-activation-blockers") && dv.includes("Activation is switched off until the safety hardening ships")
      && dv.includes("The message definition changed since this automation was checked — edit it to re-check.") && blockers.every((b) => dv.includes(ACTIVATION_BLOCKER_LABEL[b as keyof typeof ACTIVATION_BLOCKER_LABEL])));
    const activationHtml = dv.slice(dv.indexOf('aria-label="Activation"'), dv.indexOf('aria-label="Conditions"'));
    check("no raw blocker / gate code ever renders", !/[A-Z]{3,}_[A-Z_]{3,}/.test(activationHtml), activationHtml.slice(0, 200));
    check("an unknown code is dropped, never shown raw", activationLines({ activationBlockers: ["SOMETHING_NEW"], viewer: null }).length === 0);
    const clear = renderToStaticMarkup(createElement(AutomationDetailBody, { read: ok({ ...detail, activationBlockers: [], viewer: { activationDisabledReason: null } } as AutomationDetail), runs: ok(runs) }));
    check("no blockers and the gate open ⇒ 'checks pass'", clear.includes("data-activation-ready"));
    check("the blocker / gate label maps are exhaustive by type (a new code fails to compile)",
      /ACTIVATION_BLOCKER_LABEL = \{[\s\S]*?\} as const satisfies Record<ActivationBlocker, string>;/.test(strip("components/platform/comms/comms-model.ts"))
        && /ACTIVATION_DISABLED_LABEL = \{[\s\S]*?\} as const satisfies Record<NonNullable<Viewer\["activationDisabledReason"\]>, string>;/.test(strip("components/platform/comms/comms-model.ts")));

    const delSoon = renderToStaticMarkup(createElement(DeliverySurface, { read: soon, filters: DEFAULT_DELIVERY_FILTERS, onFilters: () => {} }));
    check("delivery 404 ⇒ coming soon; commitments + provider link still shown", delSoon.includes('data-comms-state="coming-soon"') && delSoon.includes("No open or click tracking, ever")
      && delSoon.includes('href="/dashboard/platform/PLATFORM_OPS?workspace=platform-providers"') && delSoon.includes(retentionText(null)) && !delSoon.includes("data-delivery-totals"));
    check("Delivery window toggle: every segment ≥ 44 px wide (WideTargets)", /data-wide-targets[^>]*>[\s\S]*?aria-label="Window"/.test(delSoon) && delSoon.includes("[&amp;_button]:min-w-11"));
    const z = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as StatusCounts;
    const r0 = Object.fromEntries(SUPPRESSION_REASONS.map((r) => [r, 0])) as Record<(typeof SUPPRESSION_REASONS)[number], number>;
    const sz = series([null, null, 0, 3, 0, 1, 0]);
    const delivery: DeliveryAnalytics = { window: "7d", from: sz.from, to: sz.to, filters: { channel: null, status: null, template: null },
      totals: { ...z, CAPTURED: 4 }, suppressedByReason: { ...r0, ENVIRONMENT_GUARD: 4 }, byKey: [{ key: "PASSWORD_RESET_LINK_SENT", counts: { ...z, CAPTURED: 4 } }],
      series: { accepted: sz, failed: sz, dead: sz, suppressed: sz, captured: sz, cancelled: sz }, measured: { delivered: false, opens: false, clicks: false },
      coverage: { ledgerSince: sz.days[2].day, directSendsCovered: true, environment: "preview" },
      providerHealth: { href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers", source: "GET /api/platform/platform-ops/email-health" },
      floor: false, capped: false, checkedAt: NOW.toISOString() };
    const dOk = renderToStaticMarkup(createElement(DeliverySurface, { read: ok(delivery), filters: DEFAULT_DELIVERY_FILTERS, onFilters: () => {} }));
    check("delivery 200 ⇒ all eleven status tiles", count(dOk, "data-status-tile=") === 11);
    check("delivery 200 ⇒ all six series incl. captured / dead / cancelled", ["accepted", "failed", "dead", "suppressed", "captured", "cancelled"].every((k) => dOk.includes(`data-series="${k}"`)));
    check("measured.delivered false ⇒ explicit 'Delivery not yet measured'", dOk.includes("data-delivery-not-measured") && dOk.includes("Delivery not yet measured."));

    // Phase C (v1.2): the per-message row and the series once delivery is measured.
    const legacyLine = (c: StatusCounts) => (["ACCEPTED", "FAILED", "DEAD", "SUPPRESSED", "CAPTURED", "CANCELLED"] as const).map((st) => `${c[st].toLocaleString("en-US")} ${DELIVERY_STATUS_LABEL[st].toLowerCase()}`).join(" · ");
    const rowCounts = { ...z, ACCEPTED: 3, DELIVERED: 9, BOUNCED: 2, COMPLAINED: 1, FAILED: 1 };
    check("measured=false: the per-message row text is exactly today's (accepted … cancelled)", byKeyLine(rowCounts, false) === legacyLine(rowCounts) && !/delivered|bounced|complained/i.test(byKeyLine(rowCounts, false)));
    check("measured=false: the rendered row is the same text", dOk.includes(legacyLine({ ...z, CAPTURED: 4 })));
    check("the ordered row statuses are ONE exported constant each", BYKEY_STATUSES.join() === "ACCEPTED,FAILED,DEAD,SUPPRESSED,CAPTURED,CANCELLED"
      && BYKEY_STATUSES_MEASURED.join() === "ACCEPTED,DELIVERED,BOUNCED,COMPLAINED,FAILED,DEAD,SUPPRESSED,CAPTURED,CANCELLED"
      && !/\["ACCEPTED", "FAILED"/.test(strip("components/platform/comms/DeliveryView.tsx")));
    check("measured=true: delivered / bounced / complained follow 'accepted by provider'", byKeyLine(rowCounts, true) === "3 accepted by provider · 9 delivered · 2 bounced · 1 complained · 1 failed · 0 dead · 0 suppressed · 0 captured · 0 cancelled");
    const measured: DeliveryAnalytics = { ...delivery, measured: { delivered: true, opens: false, clicks: false }, totals: { ...z, ...rowCounts },
      byKey: [{ key: "SYNC_FAILED", counts: rowCounts }], series: { ...delivery.series, delivered: sz, bounced: sz, complained: sz } };
    const mOk = renderToStaticMarkup(createElement(DeliverySurface, { read: ok(measured), filters: DEFAULT_DELIVERY_FILTERS, onFilters: () => {} }));
    check("measured=true: the row renders delivered, bounced and complained", mOk.includes(byKeyLine(rowCounts, true)));
    check("measured=true: the three provider series render after the six", ["delivered", "bounced", "complained"].every((k) => mOk.includes(`data-series="${k}"`)) && count(mOk, "data-series=") === 9
      && mOk.indexOf('data-series="cancelled"') < mOk.indexOf('data-series="delivered"'));
    check("measured=true: the provider-confirmed caption replaces 'not yet measured'; accepted stays 'accepted by provider'",
      mOk.includes("data-delivery-measured") && mOk.includes("confirmed by the email provider") && !mOk.includes("data-delivery-not-measured") && mOk.includes("Accepted by provider"));
    check("no copy equates accepted with delivered", !/accepted\s*(=|means|is)\s*delivered/i.test(mOk + dOk) && SERIES_LABEL.accepted === "Accepted by provider");
    const partial = renderToStaticMarkup(createElement(DeliverySurface, { read: ok({ ...measured, series: { ...delivery.series, delivered: sz } }), filters: DEFAULT_DELIVERY_FILTERS, onFilters: () => {} }));
    check("measured but a provider series absent ⇒ that series is not rendered", partial.includes('data-series="delivered"') && !partial.includes('data-series="bounced"'));
    const unmeasuredWithKeys = renderToStaticMarkup(createElement(DeliverySurface, { read: ok({ ...delivery, series: { ...delivery.series, delivered: sz } }), filters: DEFAULT_DELIVERY_FILTERS, onFilters: () => {} }));
    check("not measured ⇒ provider series never render, even if a key is present", !unmeasuredWithKeys.includes('data-series="delivered"'));
    const visibleText = (h: string) => h.replace(/<[^>]*>/g, " ");
    check("no raw status code ever appears in the rendered text (measured or not)",
      ![...DELIVERY_STATUSES].some((st) => new RegExp(`\\b${st}\\b`).test(visibleText(mOk) + visibleText(dOk))), DELIVERY_STATUSES.filter((st) => new RegExp(`\\b${st}\\b`).test(visibleText(mOk))));
    check("Preview environment explains Captured", /Preview captures sends/.test(dOk));
    check("by-key rows show keys and counts only (no address)", dOk.includes("PASSWORD_RESET_LINK_SENT") && !/@/.test(dOk.replace(/@v\d/g, "")));
    const inApp = renderToStaticMarkup(createElement(DeliverySurface, { read: ok({ ...delivery, filters: { channel: "IN_APP" as const, status: null, template: null }, suppressedByReason: { ...r0, PREFERENCE_OFF: 3, RATE_LIMITED: 2 } }),
      filters: { ...DEFAULT_DELIVERY_FILTERS, channel: "IN_APP" }, onFilters: () => {} }));
    check("Delivery under IN_APP: a PREFERENCE_OFF suppressed row reads 'Customer turned off in-app'; storm-limited rows read 'Not sent'",
      inApp.includes("Customer turned off in-app") && inApp.includes("Not sent: 5 emails/hour limit"));
    check("Delivery with no channel filter keeps the generic preference words", dOk.includes("Environment guard") && !dOk.includes("Customer turned off in-app"));
    const dDown = renderToStaticMarkup(createElement(DeliverySurface, { read: down, filters: DEFAULT_DELIVERY_FILTERS, onFilters: () => {} }));
    check("delivery 503 ⇒ unavailable, no tiles", dDown.includes('data-comms-state="unavailable"') && !dDown.includes("data-status-tile"));

    const prefSoon = renderToStaticMarkup(createElement(PreferencesSurface, { read: soon }));
    check("preferences 404 ⇒ coming soon", prefSoon.includes('data-comms-state="coming-soon"') && !prefSoon.includes("data-preference-matrix"));
    const prefs: PreferenceAggregate = { population: 42, floor: false, checkedAt: NOW.toISOString(), rows: [
      { category: "ACCOUNT_SECURITY", locked: true, channels: { IN_APP: { default: true, optedOut: 0, optedIn: 0, withheld: false }, EMAIL: { default: true, optedOut: 0, optedIn: 0, withheld: false } } },
      { category: "SPACES", locked: false, channels: { IN_APP: { default: true, optedOut: 12, optedIn: null, withheld: true }, EMAIL: { default: false, optedOut: null, optedIn: null, withheld: false } } },
    ], coupledSuppression: [{ key: "SYNC_FAILED", usersAffected: { value: null, withheld: true }, explanation: "Email is dropped when FINANCIAL in-app is off." }] };
    const pOk = renderToStaticMarkup(createElement(PreferencesSurface, { read: ok(prefs) }));
    check("preferences 200 ⇒ population + one row per category", pOk.includes(">42<") && count(pOk, "data-preference-row=") === 2);
    // (7) one shared `withheld` flag: "<5" only for a NULL count when withheld; a number stays a number.
    check("shared withheld flag: optedOut 12 stays 12, null optedIn under withheld ⇒ '<5'", /Turned off <span[^>]*data-count-state="value"[^>]*>12</.test(pOk));
    check("withheld cells render '<5' distinctly; not observed renders '—'", count(pOk, 'data-count-state="withheld"') === 2 && count(pOk, 'data-count-state="not-observed"') === 2 && pOk.includes("&lt;5"));
    check("locked category is marked", pOk.includes("Locked"));
  }

  console.log("5. source rules");
  {
    const dir = "components/platform/comms";
    const files = readdirSync(path.join(process.cwd(), dir)).filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f)).map((f) => `${dir}/${f}`);
    check("the comms component files exist", files.length >= 6, files);
    for (const f of files) {
      const src = strip(f);
      check(`${f}: no access-level literal / control flag / raw fetch / matchMedia`, !/\bCONTROL\b|canControl|canWrite|matchMedia|innerWidth|\bfetch\(/.test(src));
      check(`${f}: tokens only — no raw hex colour`, !/#[0-9a-fA-F]{3,8}\b/.test(src));
    }
    const kit = strip(`${dir}/comms-kit.tsx`);
    check("the iframe (PreviewRendition, comms-kit) is sandbox=\"\" (no allow-*) and fed by srcDoc only", /<iframe[^>]*sandbox=""/.test(kit) && !/allow-scripts|allow-same-origin|<iframe[^>]*\ssrc=/.test(kit) && /srcDoc=\{p\.html\}/.test(kit));
    check("exactly one iframe in the comms views (no second, unreviewed rendition)", files.reduce((a, f) => a + (strip(f).match(/<iframe/g) ?? []).length, 0) === 1);
    check("no view posts or patches anything", files.every((f) => !/method\s*:|"POST"|"PATCH"/.test(strip(f))));
  }

  if (failures > 0) { console.error(`\ncomms-center.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncomms-center.test: all passed.");
}

void main();
