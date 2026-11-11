/**
 * lib/platform/incidents/related-navigation.test.ts  (PB-1 — from an incident, navigate to its related records)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/related-navigation.test.ts
 *
 *   1. targets — every link names a real registry target; iid is an allowed
 *      param on the incidents targets; the Providers and connection-health
 *      targets take NO param (so their links are unfiltered and say so — the
 *      day a filter param exists this fails and the link should use it);
 *   2. each link's href IS resolveNavigationTarget's output for the Ops token
 *      on the Ops surface (nothing composed locally);
 *   3. an Ops-only token sees no Customer Success link; a break-glass token and
 *      a forged token see nothing; an invisible target is simply absent;
 *   4. no raw user / connection id reaches an href (only workspace, view, iid);
 *   5. the previous-episode link exists only when previousIncidentId is set;
 *      same-subject links are the OPEN other episodes, capped;
 *   6. rendering — the "Go to" title, verbatim hrefs, no ghost rows, nothing when empty; 375px classes;
 *      6b. a plain click opens in place ONLY on the link's own view (else the href is followed);
 *      6c. a navigation failure (mint, registry, builder) yields [] and never hides the incident;
 *   7. source scan — the drawer and the builder build no href; each route resolves
 *      with its literal surface and a token from its own guard;
 *   8. Customer Success — CS-tier targets only, ids the CS DTO already exposes,
 *      no self-link, no Ops destination; Ops / break-glass / forged tokens ⇒ [].
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserRole, type PlatformArea } from "@prisma/client";
import { metricAccessFor, type MetricAccessToken } from "@/lib/platform/intelligence/metrics/access";
import { resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import { NAVIGATION_TARGETS } from "@/lib/platform/intelligence/navigation/registry";
import type { IncidentDetailDTO } from "./investigation-dto";
import { IncidentRelatedNavigation, NAVIGATION_SECTION_TITLE, opensInPlace } from "@/components/platform/incidents/IncidentsLead";
import {
  CS_INCIDENT_NAVIGATION_TARGETS, INCIDENT_NAVIGATION_TARGETS, SAME_SUBJECT_LINK_CAP, csIncidentNavigationLinks, incidentNavigationLinks, navigationOrEmpty,
  type IncidentNavigationInput, type IncidentNavigationLinkDTO, type IncidentNavigationResolver,
} from "./related-navigation";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-04T12:00:00.000Z");
const tokenFor = (area: PlatformArea): MetricAccessToken => metricAccessFor({ user: { role: UserRole.USER }, grant: { area, level: "READ" } as never })!;
const PO = tokenFor("PLATFORM_OPS");
const CS = tokenFor("CUSTOMER_SUCCESS");
const SA = metricAccessFor({ user: { role: UserRole.SYSTEM_ADMIN }, grant: null })!;
const opsResolver = (t: MetricAccessToken): IncidentNavigationResolver => (id, p) => resolveNavigationTarget("PLATFORM_OPS", t, id, p, { now: NOW });
const csResolver = (t: MetricAccessToken): IncidentNavigationResolver => (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p, { now: NOW });

const USER_ID = "usr_cust0000000000000001";
const ITEM_ID = "item_conn000000000000001";
const input = (o: Partial<IncidentNavigationInput["verdict"]> = {}, rest: Partial<Omit<IncidentNavigationInput, "verdict">> = {}): IncidentNavigationInput => ({
  // A CS-shaped verdict (carries a customer id and a connection id) — the builder must never forward either.
  verdict: { id: "inc_cur", provider: "PLAID", state: "active", recurrence: { previousIncidentId: "inc_prev" }, subjectUserId: USER_ID, plaidItemId: ITEM_ID, ...o } as IncidentNavigationInput["verdict"],
  itemCount: 1,
  recurrences: [
    { id: "inc_cur", state: "active", recurrence: { generation: 3 } },
    { id: "inc_open2", state: "acknowledged", recurrence: { generation: 2 } },
    { id: "inc_prev", state: "resolved", recurrence: { generation: 1 } },
  ] as IncidentNavigationInput["recurrences"],
  ...rest,
});
const kinds = (ls: readonly IncidentNavigationLinkDTO[]) => ls.map((l) => l.kind);

console.log("1. targets");
{
  const T = INCIDENT_NAVIGATION_TARGETS;
  const byId = (id: string) => NAVIGATION_TARGETS.find((t) => t.id === id);
  check("every link names a real registry target", Object.values(T).every((id) => !!byId(id)), Object.values(T).filter((id) => !byId(id)));
  check("iid is an allowed (incidents-group) param on every incidents target",
    [T.opsIncidentsOpen, T.opsIncidentsHistory, T.csIncidentsOpen].every((id) => byId(id)!.params.includes("iid") && byId(id)!.paramGroups.includes("incidents")));
  check("the Providers view hosts provider health and takes NO param (no per-provider filter exists ⇒ unfiltered link)",
    byId(T.providerHealth)!.sections.includes("ops_provider_health") && byId(T.providerHealth)!.params.length === 0);
  check("the Pipeline view hosts connection health and takes NO param (no per-connection filter exists ⇒ unfiltered link)",
    byId(T.connectionHealth)!.sections.includes("ops_connection_health") && byId(T.connectionHealth)!.params.length === 0);
  check("the Ops targets are OPS-tier; the CS incidents target is CUSTOMER_SUCCESS-tier",
    [T.providerHealth, T.connectionHealth, T.opsIncidentsOpen, T.opsIncidentsHistory].every((id) => byId(id)!.tier === "OPS") && byId(T.csIncidentsOpen)!.tier === "CUSTOMER_SUCCESS");
  check("no customer-detail target was added (no target names a customer)", NAVIGATION_TARGETS.every((t) => !/customer-detail|\[userId\]/.test(t.id + t.pathname)));
}

console.log("\n2. every href is the registry's");
{
  const links = incidentNavigationLinks(input(), opsResolver(PO));
  check("Ops token, Ops surface: provider · connection · previous episode · one open same-subject episode",
    kinds(links).join() === "provider-health,connection-health,previous-episode,same-subject-open", kinds(links));
  const expect: Record<string, string | null> = {
    "provider-health": resolveNavigationTarget("PLATFORM_OPS", PO, INCIDENT_NAVIGATION_TARGETS.providerHealth, undefined, { now: NOW })?.href ?? null,
    "connection-health": resolveNavigationTarget("PLATFORM_OPS", PO, INCIDENT_NAVIGATION_TARGETS.connectionHealth, undefined, { now: NOW })?.href ?? null,
    "previous-episode": resolveNavigationTarget("PLATFORM_OPS", PO, INCIDENT_NAVIGATION_TARGETS.opsIncidentsHistory, { iid: "inc_prev" }, { now: NOW })?.href ?? null,
    "same-subject-open": resolveNavigationTarget("PLATFORM_OPS", PO, INCIDENT_NAVIGATION_TARGETS.opsIncidentsOpen, { iid: "inc_open2" }, { now: NOW })?.href ?? null,
  };
  check("each href equals resolveNavigationTarget's output byte-for-byte", links.every((l) => expect[l.kind] !== null && l.href === expect[l.kind]), links.map((l) => [l.kind, l.href]));
  const prev = links.find((l) => l.kind === "previous-episode")!;
  const u = new URL(prev.href, "https://x");
  check("previous episode opens the Ops incidents History view on that incident (iid) and nothing else",
    u.searchParams.get("workspace") === "platform-incidents" && u.searchParams.get("view") === "history" && u.searchParams.get("iid") === "inc_prev" && [...u.searchParams.keys()].length === 3, prev.href);
  check("in-workspace incident links carry the incident for in-place open; the others carry none",
    links.every((l) => (l.kind === "previous-episode" || l.kind === "same-subject-open") ? l.incidentId !== null : l.incidentId === null));
  check("the unfiltered links say so", links.filter((l) => l.kind === "provider-health" || l.kind === "connection-health").every((l) => !!l.note && /no per-/.test(l.note)));
}

console.log("\n3. permission-filtered per token and surface");
{
  const ops = incidentNavigationLinks(input(), opsResolver(PO));
  check("an Ops-only token sees NO Customer Success link (and no href into the CS area)",
    !ops.some((l) => l.kind === "customer-success") && ops.every((l) => !l.href.includes("CUSTOMER_SUCCESS") && !l.href.includes("customer-success")), ops.map((l) => l.href));
  check("break-glass sees nothing (every destination refuses it)", incidentNavigationLinks(input(), opsResolver(SA)).length === 0);
  check("a forged token sees nothing", incidentNavigationLinks(input(), opsResolver({ grants: [{ area: "PLATFORM_OPS", level: "CONTROL" }] } as unknown as MetricAccessToken)).length === 0);
  check("a CS token on the Ops surface sees nothing (no Ops grant; CS tier hidden off its surface)", incidentNavigationLinks(input(), opsResolver(CS)).length === 0);
  const cs = incidentNavigationLinks(input(), csResolver(CS));
  check("a CS token on the CS surface sees ONLY the CS incidents link (the Ops targets are invisible, not ghosted)",
    kinds(cs).join() === "customer-success", kinds(cs));
  const c = new URL(cs[0].href, "https://x");
  check("…which opens CS incidents on THIS incident (iid = the incident id, an opaque record ref)",
    c.searchParams.get("workspace") === "platform-incidents" && c.searchParams.get("view") === "open" && c.searchParams.get("iid") === "inc_cur", cs[0].href);
  const partial = incidentNavigationLinks(input(), (id, p) => id === INCIDENT_NAVIGATION_TARGETS.providerHealth ? null : opsResolver(PO)(id, p));
  check("a refused target is simply absent — no placeholder, the rest unchanged",
    kinds(partial).join() === "connection-health,previous-episode,same-subject-open", kinds(partial));
  check("no connection subject ⇒ no connection-health and no customer link",
    !incidentNavigationLinks(input({}, { itemCount: 0 }), () => ({ href: "/x" })).some((l) => l.kind === "connection-health" || l.kind === "customer-success"));
}

console.log("\n4. no raw ids in hrefs");
{
  const all: IncidentNavigationLinkDTO[] = [
    ...incidentNavigationLinks(input(), opsResolver(PO)),
    ...incidentNavigationLinks(input(), csResolver(CS)),
  ];
  const seen: Record<string, string>[] = [];
  const spy: IncidentNavigationResolver = (id, p) => { seen.push({ ...(p ?? {}) }); return { href: `/p?${id}` }; };
  incidentNavigationLinks(input(), spy);
  check("no href carries the customer id or the connection id", all.every((l) => !l.href.includes(USER_ID) && !l.href.includes(ITEM_ID) && !l.href.includes("usr_") && !l.href.includes("item_")), all.map((l) => l.href));
  check("hrefs carry only workspace / view / iid", all.every((l) => [...new URL(l.href, "https://x").searchParams.keys()].every((k) => ["workspace", "view", "iid"].includes(k))));
  check("the builder passes the resolver no param but iid, and iid only incident ids",
    seen.every((p) => Object.keys(p).every((k) => k === "iid")) && seen.every((p) => !p.iid || p.iid.startsWith("inc_")), seen);
}

console.log("\n5. episodes");
{
  const none = incidentNavigationLinks(input({ recurrence: { previousIncidentId: null } }), opsResolver(PO));
  check("no previousIncidentId ⇒ no previous-episode link", !none.some((l) => l.kind === "previous-episode"), kinds(none));
  check("previousIncidentId set ⇒ exactly one previous-episode link", incidentNavigationLinks(input(), opsResolver(PO)).filter((l) => l.kind === "previous-episode").length === 1);
  const many = incidentNavigationLinks(input({}, {
    recurrences: Array.from({ length: SAME_SUBJECT_LINK_CAP + 3 }, (_, i) => ({ id: `inc_o${i}`, state: "active", recurrence: { generation: i + 2 } })) as IncidentNavigationInput["recurrences"],
  }), opsResolver(PO));
  check(`same-subject open episodes are capped at ${SAME_SUBJECT_LINK_CAP}`, many.filter((l) => l.kind === "same-subject-open").length === SAME_SUBJECT_LINK_CAP);
  const same = incidentNavigationLinks(input(), opsResolver(PO)).filter((l) => l.kind === "same-subject-open");
  check("…never the incident itself, never a closed episode", same.length === 1 && same[0].incidentId === "inc_open2");
}

console.log("\n6. rendering");
{
  const links = incidentNavigationLinks(input(), opsResolver(PO));
  const html = renderToStaticMarkup(createElement(IncidentRelatedNavigation, { links, viewId: "open", onOpenInPlace: () => {} }));
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  check("one anchor per link, href verbatim", hrefs.length === links.length && hrefs.every((h, i) => h === links[i].href), hrefs);
  check("the section is titled \"Go to\" (never confused with \"Related and recurring\")",
    NAVIGATION_SECTION_TITLE === "Go to" && html.includes(">Go to</h3>") && !html.includes(">Related</h3>"));
  check("no links ⇒ nothing rendered (no empty section, no ghost)", renderToStaticMarkup(createElement(IncidentRelatedNavigation, { links: [] })) === "");
  const bad = renderToStaticMarkup(createElement(IncidentRelatedNavigation, { links: [{ kind: "provider-health", label: "x", note: null, href: "//evil.example/x", incidentId: null, viewId: null }] }));
  check("a non-relative href is refused, not rendered", bad === "");
  check("375px: rows shrink (min-w-0), labels wrap (break-words), no fixed width", /min-w-0/.test(html) && /break-words/.test(html) && !/\bw-\[\d|min-w-\[\d|whitespace-nowrap/.test(html));
  check("no disabled / aria-disabled links", !/disabled/.test(html));
}

console.log("\n6b. in-place open follows the link's view");
{
  const links = incidentNavigationLinks(input(), opsResolver(PO));
  const byKind = (k: string) => links.find((l) => l.kind === k)!;
  const viewOfHref = (h: string) => new URL(h, "https://x").searchParams.get("view") ?? "open"; // no ?view= ⇒ the default view (open)
  check("each incident link names the view its href opens; the others none",
    links.every((l) => l.incidentId ? l.viewId === viewOfHref(l.href) : l.viewId === null), links.map((l) => [l.kind, l.viewId, l.href]));
  check("previous episode → history, same-subject → open", byKind("previous-episode").viewId === "history" && byKind("same-subject-open").viewId === "open");
  const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  check("on the Broken now view, the previous-episode link (History) FOLLOWS its href — never opened in place under the wrong view",
    !opensInPlace(byKind("previous-episode"), "open", plain));
  check("on the History view it opens in place (the in-place URL is the href's)", opensInPlace(byKind("previous-episode"), "history", plain));
  check("a same-view same-subject link opens in place", opensInPlace(byKind("same-subject-open"), "open", plain));
  check("modified / non-primary clicks always follow the href",
    [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }].every((m) => !opensInPlace(byKind("same-subject-open"), "open", { ...plain, ...m })));
  check("a non-incident link and an unknown current view never open in place",
    !opensInPlace(byKind("provider-health"), "open", plain) && !opensInPlace(byKind("same-subject-open"), undefined, plain));
  const lead = readFileSync("components/platform/incidents/IncidentsLead.tsx", "utf8");
  check("the in-place opener writes exactly the href's state: this view's bare preset (no filters) + iid",
    /const openInPlace = \(id: string\) => apply\(\{ query: \{ \.\.\.DEFAULT_SEARCH, status \}, selectedId: id, fromClamped: false \}\)/.test(lead));
}

console.log("\n6c. a navigation failure never hides the incident");
{
  check("a throwing build ⇒ [] (no throw)", (() => { try { return navigationOrEmpty(() => { throw new Error("registry bug"); }).length === 0; } catch { return false; } })());
  const boom: IncidentNavigationResolver = () => { throw new Error("resolver bug"); };
  check("a throwing resolver inside the builder ⇒ []", navigationOrEmpty(() => incidentNavigationLinks(input(), boom)).length === 0);
  check("a working build passes through unchanged", navigationOrEmpty(() => incidentNavigationLinks(input(), opsResolver(PO))).length === 4);
  const route = readFileSync("app/api/platform/platform-ops/incidents/[id]/route.ts", "utf8");
  const guarded = route.match(/const navigation = navigationOrEmpty\(\(\) => \{([\s\S]*?)\n {2}\}\);/);
  check("the Ops route mints AND builds inside navigationOrEmpty (nothing navigation-related outside it)",
    !!guarded && /metricAccessFor\(auth\)/.test(guarded[1]) && /incidentNavigationLinks\(/.test(guarded[1])
    && (route.match(/metricAccessFor\(/g) ?? []).length === 1 && (route.match(/incidentNavigationLinks\(/g) ?? []).length === 1);
  check("…and the incident is still served with navigation: [] on failure (the response spreads the DTO + navigation)",
    /\{ \.\.\.incidentDetailDTO\(inv, "ops", now\), navigation \}/.test(route));
}

console.log("\n7. source scan");
{
  const code = (s: string) => s.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  const lead = code(readFileSync("components/platform/incidents/IncidentsLead.tsx", "utf8"));
  const hrefAttrs = [...lead.matchAll(/\bhref=\{([^}]*)\}/g)].map((m) => m[1].trim());
  check("the drawer's only href attribute is the resolved link's href", hrefAttrs.join() === "l.href", hrefAttrs);
  check("the drawer imports no URL builder (workspace-href / space-url / navigation registry or accessor)",
    !/workspace-href|space\/space-url|intelligence\/navigation|buildSpaceUrl|platformWorkspaceHref|platformAreaHref/.test(lead));
  check("the drawer writes no Platform page path or workspace query literal", !/["'`]\/dashboard|[?&]workspace=|[?&]iid=/.test(lead));
  const builder = code(readFileSync("lib/platform/incidents/related-navigation.ts", "utf8"));
  check("the builder composes no URL and imports no navigation module (it only calls its resolver)",
    !/\/dashboard|URLSearchParams|buildSpaceUrl|platformWorkspaceHref|intelligence\/navigation|`\/|"\/[a-z]/.test(builder));
  const route = readFileSync("app/api/platform/platform-ops/incidents/[id]/route.ts", "utf8");
  check("the Ops route resolves with a literal PLATFORM_OPS surface and a token minted from its own guard result",
    /resolveNavigationTarget\("PLATFORM_OPS", navToken,/.test(route) && /const navToken = metricAccessFor\(auth\)/.test(route) && /const \[auth, err\] = await requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route));
  const csRoute = readFileSync("app/api/platform/customer-success/incidents/[id]/route.ts", "utf8");
  const csGuarded = csRoute.match(/const navigation = navigationOrEmpty\(\(\) => \{([\s\S]*?)\n {2}\}\);/);
  check("the CS route mints from its OWN guard result and resolves with the literal CUSTOMER_SUCCESS surface, inside navigationOrEmpty",
    /const \[auth, err\] = await requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\)/.test(csRoute) && !!csGuarded
    && /const navToken = metricAccessFor\(auth\)/.test(csGuarded[1]) && /resolveNavigationTarget\("CUSTOMER_SUCCESS", navToken,/.test(csGuarded[1])
    && !/resolveNavigationTarget\("(?!CUSTOMER_SUCCESS")/.test(csRoute));
  check("…and builds from the PROJECTED CS DTO (csIncidentNavigationLinks(dto, …)), never the raw investigation",
    /const dto = incidentDetailDTO\(inv, "cs", now, \{ subjectRefOf: opaqueUserRef \}\)/.test(csRoute) && /csIncidentNavigationLinks\(dto,/.test(csRoute) && !/incidentNavigationLinks\(/.test(csRoute.replace(/csIncidentNavigationLinks/g, "")));
}

console.log("\n8. the Customer Success drawer");
{
  const T = CS_INCIDENT_NAVIGATION_TARGETS;
  const byId = (id: string) => NAVIGATION_TARGETS.find((t) => t.id === id);
  check("every CS target is a real CUSTOMER_SUCCESS-tier incidents target allowing iid",
    Object.values(T).every((id) => byId(id)?.tier === "CUSTOMER_SUCCESS" && byId(id)!.area === "CUSTOMER_SUCCESS" && byId(id)!.params.includes("iid")));
  const row = (id: string, state: string, generation: number) => ({ id, state, generation, subjectUserId: USER_ID }) as unknown as IncidentDetailDTO["incident"];
  const dto = (o: Partial<Pick<IncidentDetailDTO, "related" | "recurrences">> = {}): Pick<IncidentDetailDTO, "incident" | "related" | "recurrences"> => ({
    incident: row("inc_cur", "active", 3),
    related: [
      { id: "inc_prev", kind: "PREVIOUS_EPISODE", incident: row("inc_prev", "resolved", 1) },
      { id: "inc_rel", kind: "RELATED", incident: row("inc_rel", "active", 1) },
    ],
    recurrences: [row("inc_cur", "active", 3), row("inc_open2", "acknowledged", 2), row("inc_prev", "resolved", 1)],
    ...o,
  });
  const csOn = (t: MetricAccessToken): IncidentNavigationResolver => (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p, { now: NOW });
  const links = csIncidentNavigationLinks(dto(), csOn(CS));
  check("CS token on CS: previous episode + the open same-subject episode, nothing else", kinds(links).join() === "previous-episode,same-subject-open", kinds(links));
  check("each href is resolveNavigationTarget(\"CUSTOMER_SUCCESS\", …)'s output",
    links[0].href === resolveNavigationTarget("CUSTOMER_SUCCESS", CS, T.incidentsHistory, { iid: "inc_prev" }, { now: NOW })?.href
    && links[1].href === resolveNavigationTarget("CUSTOMER_SUCCESS", CS, T.incidentsOpen, { iid: "inc_open2" }, { now: NOW })?.href, links.map((l) => l.href));
  check("…previous → CS History, same-subject → CS Broken now (viewId = the href's view)",
    links[0].viewId === "history" && links[1].viewId === "open"
    && links.every((l) => l.viewId === (new URL(l.href, "https://x").searchParams.get("view") ?? "open")));
  const exposed = new Set([dto().incident.id, ...dto().related.map((l) => l.id), ...dto().recurrences.map((r) => r.id)]);
  check("every linked id is one the CS DTO already exposes", links.every((l) => !!l.incidentId && exposed.has(l.incidentId)));
  check("no self-link and no \"open in Customer Success\" link", links.every((l) => l.incidentId !== "inc_cur" && l.kind !== "customer-success"));
  check("no Ops destination (provider / connection health)", links.every((l) => l.kind !== "provider-health" && l.kind !== "connection-health"));
  check("an explicitly RELATED incident is not an episode link", !links.some((l) => l.incidentId === "inc_rel"));
  check("no customer id in any href; only workspace / view / iid",
    links.every((l) => !l.href.includes(USER_ID) && [...new URL(l.href, "https://x").searchParams.keys()].every((k) => ["workspace", "view", "iid"].includes(k))));
  check("no PREVIOUS_EPISODE entry in the DTO ⇒ no previous-episode link",
    !csIncidentNavigationLinks(dto({ related: [] }), csOn(CS)).some((l) => l.kind === "previous-episode"));
  const asked: string[] = [];
  csIncidentNavigationLinks(dto(), (id, p) => { asked.push(id); return { href: `/p?${new URLSearchParams(p).toString()}` }; });
  check("only CS-tier targets are ever asked for", asked.length > 0 && asked.every((id) => id.startsWith("CUSTOMER_SUCCESS:")), asked);
  check("an Ops token on the CS surface ⇒ []", csIncidentNavigationLinks(dto(), csOn(PO)).length === 0);
  check("break-glass ⇒ []", csIncidentNavigationLinks(dto(), csOn(SA)).length === 0);
  check("forged ⇒ []", csIncidentNavigationLinks(dto(), csOn({ grants: [{ area: "CUSTOMER_SUCCESS", level: "CONTROL" }] } as unknown as MetricAccessToken)).length === 0);
  check("a throwing resolver inside navigationOrEmpty ⇒ []", navigationOrEmpty(() => csIncidentNavigationLinks(dto(), () => { throw new Error("x"); })).length === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
