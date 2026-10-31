/**
 * lib/notifications/catalog/api.test.ts  (Comms Center Phase A-1)
 *
 * The four READ-ONLY routes under /api/platform/customer-success/notifications/,
 * exercised through the same handlers the routes call (lib/notifications/catalog/
 * http.ts) with an injected gate:
 *
 *   1. gating — 401 / 403 / 429 short-circuit before any work; the real policy
 *      refuses a non-Customer-Success grant; every route is wired to
 *      requirePlatformAccess("CUSTOMER_SUCCESS", "READ") and exports GET only;
 *   2. GET /catalog — default sort (status, then displayName), filters,
 *      limit=100 returns everything, cursor pagination, 400 on bad input;
 *   3. GET /catalog/[key] — detail, 404, dense all-null `recent`;
 *   4. preview — every (key × channel × variant) renders synthetic data with
 *      BOTH transports replaced by throwing stubs (the send seam is never
 *      called); the channel enum and parameters are validated; 409 for a
 *      channel the definition does not have;
 *   5. no PII — no address outside @example.invalid (and the support
 *      contact in the footer), no token but the non-redeemable one, no
 *      recipient field, in ANY response;
 *   6. 503 UNAVAILABLE on a failed build, with a fixed message.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/catalog/api.test.ts
 */

import { readFileSync } from "node:fs";
import { UserRole } from "@prisma/client";
import { decidePlatformAccess } from "@/lib/platform/authorize";
import { captureAdapter, capturedEmails } from "@/lib/email/providers/capture";
import { resendAdapter } from "@/lib/email/providers/resend";
import { PREVIEW_TOKEN } from "@/lib/email/preview";
import { CATALOG_KEYS, COMMS_CATALOG } from "@/lib/notifications/catalog/definitions";
import {
  catalogDetail,
  catalogList,
  catalogPreview,
  compareCatalog,
  runRead,
  triggersList,
  type ReadDeps,
} from "@/lib/notifications/catalog/http";
import { previewVariants } from "@/lib/notifications/catalog/preview";
import { DEFINITION_STATUS_ORDER, PREVIEW_CHANNELS, TRIGGER_KEYS } from "@/lib/notifications/catalog/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const NOW = new Date("2026-10-31T12:00:00.000Z");
const u = (path: string) => new URL(`https://app.example.invalid/api/platform/customer-success/notifications${path}`);
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every response body the tests produce, for the PII sweep in §5. */
const seen: string[] = [];
async function capture(r: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  const text = await r.text();
  seen.push(text);
  return { status: r.status, json: JSON.parse(text) as Record<string, unknown> };
}

const deny = (status: number): ReadDeps["guard"] => async () => [null, new Response(JSON.stringify({ error: "no" }), { status })];
const allow: ReadDeps["guard"] = async () => [{ user: { id: "operator-preview" } }, null];
const noLimit: ReadDeps["rateLimit"] = async () => null;

async function gating(): Promise<void> {
  console.log("1. gating");
  let ran = 0;
  const work = () => { ran++; return new Response("{}"); };
  const r401 = await runRead({ guard: deny(401), rateLimit: noLimit }, work);
  const r403 = await runRead({ guard: deny(403), rateLimit: noLimit }, work);
  check("unauthenticated → 401, and no work runs", r401.status === 401 && ran === 0);
  check("no / insufficient grant → 403, and no work runs", r403.status === 403 && ran === 0);
  let limitedFor: string | null = null;
  const r429 = await runRead({ guard: allow, rateLimit: async (id) => { limitedFor = id; return new Response("{}", { status: 429 }); } }, work);
  check("rate-limited → 429 after the gate, keyed by the operator id, no work", r429.status === 429 && limitedFor === "operator-preview" && ran === 0);
  const ok = await runRead({ guard: allow, rateLimit: noLimit }, work);
  check("allowed → the work runs once", ok.status === 200 && ran === 1);

  // The real decision the gate applies (lib/platform/authorize.ts → policy).
  const grant = (area: string, level: string) => [{ area, level, status: "ACTIVE" }] as never;
  check("policy: a PLATFORM_OPS grant does NOT open CUSTOMER_SUCCESS READ (→ 403)",
    decidePlatformAccess(UserRole.USER, "CUSTOMER_SUCCESS", "READ", grant("PLATFORM_OPS", "CONTROL")) === false);
  check("policy: a GROWTH_REVENUE grant does NOT open CUSTOMER_SUCCESS READ (→ 403)",
    decidePlatformAccess(UserRole.USER, "CUSTOMER_SUCCESS", "READ", grant("GROWTH_REVENUE", "WRITE")) === false);
  check("policy: no grant → refused (→ 403)", decidePlatformAccess(UserRole.USER, "CUSTOMER_SUCCESS", "READ", [] as never) === false);
  check("policy: a revoked CUSTOMER_SUCCESS grant → refused",
    decidePlatformAccess(UserRole.USER, "CUSTOMER_SUCCESS", "READ", [{ area: "CUSTOMER_SUCCESS", level: "READ", status: "REVOKED" }] as never) === false);
  check("policy: an ACTIVE CUSTOMER_SUCCESS READ grant → allowed",
    decidePlatformAccess(UserRole.USER, "CUSTOMER_SUCCESS", "READ", grant("CUSTOMER_SUCCESS", "READ")) === true);

  const deps = code("lib/notifications/catalog/read-deps.ts");
  check("read-deps: the cs-comms-read bucket is applied per operator, and carries no gate",
    /limitByUser\(userId, CS_COMMS_READ_BUCKET, CS_COMMS_READ_LIMIT\)/.test(deps) && !/requirePlatformAccess|requireFresh/.test(deps));
  const base = "app/api/platform/customer-success/notifications";
  for (const f of [`${base}/catalog/route.ts`, `${base}/catalog/[key]/route.ts`, `${base}/catalog/[key]/preview/route.ts`, `${base}/triggers/route.ts`]) {
    const src = code(f);
    check(`${f}: GET only`, /export async function GET\(/.test(src) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(src));
    check(`${f}: gated by exactly requirePlatformAccess("CUSTOMER_SUCCESS", "READ") through runRead, with the cs-comms-read bucket`,
      (src.match(/requirePlatformAccess\(/g) ?? []).length === 1 &&
      /runRead\(\{ guard: \(\) => requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit \},/.test(src) &&
      !/requireFreshPlatformAccess|"WRITE"|"CONTROL"/.test(src));
    check(`${f}: no DB, no send`, !/@\/lib\/db|@\/lib\/email\/send/.test(src));
  }
}

async function list(): Promise<void> {
  console.log("2. GET /catalog");
  const all = await capture(catalogList(u("/catalog?limit=100"), NOW));
  const items = all.json.items as Array<{ key: string; status: string; displayName: string }>;
  check("limit=100 → 200 with every entry (58) and nextCursor null", all.status === 200 && items.length === 58 && all.json.nextCursor === null && all.json.limit === 100);
  check("checkedAt is the server time; floor and capped are false (code registry)", all.json.checkedAt === NOW.toISOString() && all.json.floor === false && all.json.capped === false);
  const rank = (s: string) => DEFINITION_STATUS_ORDER.indexOf(s as never);
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let sorted = true;
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    if (rank(a.status) > rank(b.status) || (a.status === b.status && fold(a.displayName) > fold(b.displayName))) sorted = false;
  }
  check("default sort: status order, then displayName (ASCII case-folded)", sorted);
  check("ENABLED first, NONE_BY_DESIGN last", items[0].status === "ENABLED" && items[items.length - 1].status === "NONE_BY_DESIGN");
  check("same order as compareCatalog", items.map((i) => i.key).join() === CATALOG_KEYS.map((k) => COMMS_CATALOG[k]).sort(compareCatalog).map((d) => d.key).join());
  const totals = all.json.totals as Record<string, number>;
  check("totals carry every status key and sum to the item count",
    DEFINITION_STATUS_ORDER.every((s) => typeof totals[s] === "number") && Object.values(totals).reduce((a, b) => a + b, 0) === 58 && totals.RETIRED === 0);

  const def = await capture(catalogList(u("/catalog"), NOW));
  check("default limit is 50, with a cursor for the rest", (def.json.items as unknown[]).length === 50 && typeof def.json.nextCursor === "string" && def.json.limit === 50);

  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r = await capture(catalogList(u(`/catalog?limit=7${cursor ? `&cursor=${cursor}` : ""}`), NOW));
    walked.push(...(r.json.items as Array<{ key: string }>).map((i) => i.key));
    cursor = r.json.nextCursor as string | null;
    pages++;
  } while (cursor && pages < 20);
  check("cursor pages of 7 walk the whole catalog once, in order (9 pages)", walked.join() === items.map((i) => i.key).join() && pages === 9);

  for (const bad of ["limit=0", "limit=101", "limit=abc", "limit=-1", "cursor=%25%25", "cursor=eyJrIjoiTk9QRSJ9", "status=SENT", "channel=SMS", "category=nope", "audience=x", "consentClass=x"]) {
    const r = await capture(catalogList(u(`/catalog?${bad}`), NOW));
    check(`?${bad} → 400 VALIDATION`, r.status === 400 && r.json.code === "VALIDATION");
  }
  const build = await capture(catalogList(u("/catalog?status=BUILD"), NOW));
  check("status=BUILD → the five BUILD keys, totals filtered", (build.json.items as unknown[]).length === 5 && (build.json.totals as Record<string, number>).BUILD === 5 && (build.json.totals as Record<string, number>).ENABLED === 0);
  const banners = await capture(catalogList(u("/catalog?channel=BANNER"), NOW));
  check("channel=BANNER → the three banners", (banners.json.items as Array<{ key: string }>).map((i) => i.key).sort().join() === "CONNECT_INVITATION,MAINTENANCE_NOTICE,TWO_FACTOR_REMINDER");
  const crit = await capture(catalogList(u("/catalog?consentClass=SECURITY_CRITICAL&limit=100"), NOW));
  check("consentClass=SECURITY_CRITICAL → every item protected and not suppressible",
    (crit.json.items as Array<{ protected: boolean; userSuppressible: boolean }>).every((i) => i.protected && !i.userSuppressible) && (crit.json.items as unknown[]).length > 10);
  const q = await capture(catalogList(u("/catalog?q=institution"), NOW));
  check("q matches displayName case-insensitively", (q.json.items as Array<{ key: string }>).some((i) => i.key === "SYNC_FAILED"));
  const qk = await capture(catalogList(u("/catalog?q=platform_alert"), NOW));
  check("q matches the key", (qk.json.items as Array<{ key: string }>).map((i) => i.key).join() === "PLATFORM_ALERT");
  const item = items.find((i) => i.key === "SYNC_FAILED") as unknown as Record<string, unknown>;
  check("list items carry protected / editable / supportedActions / userSuppressible / automations",
    ["protected", "editable", "supportedActions", "userSuppressible", "automations", "channels", "ownerSurface"].every((k) => k in item));
  check("list items do not leak internal wiring (email builder, preview slugs, sources)",
    !/"builder"|"previewSlugs"|"sources"|"email":/.test(JSON.stringify(all.json)));

  const trig = await capture(triggersList(u("/triggers?limit=100"), NOW));
  check("GET /triggers → every trigger key, read-only list envelope", trig.status === 200 &&
    (trig.json.items as Array<{ key: string }>).map((i) => i.key).join() === TRIGGER_KEYS.join() && trig.json.nextCursor === null && trig.json.floor === false);
  check("triggers: only emitted events are AVAILABLE (7)", (trig.json.items as Array<{ status: string }>).filter((t) => t.status === "AVAILABLE").length === 7);
  const trigBad = await capture(triggersList(u("/triggers?limit=500"), NOW));
  check("triggers: limit=500 → 400", trigBad.status === 400);
}

async function detail(): Promise<void> {
  console.log("3. GET /catalog/[key]");
  for (const key of CATALOG_KEYS) {
    const r = await capture(catalogDetail(key, NOW));
    const recent = r.json.recent as { days: Array<{ count: unknown; day: string }>; window: string; from: string; to: string };
    if (r.status !== 200 || recent.days.length !== 30 || !recent.days.every((d) => d.count === null) || recent.to !== "2026-10-31" || recent.from !== "2026-10-02") {
      check(`${key}: detail 200 with a dense 30-day all-null series`, false, { status: r.status });
    }
  }
  check("every key: detail 200 with a dense 30-day all-null (not observed) series ending today UTC", true);
  const sf = await capture(catalogDetail("SYNC_FAILED", NOW));
  check("detail carries trigger, typed payload, eligibility, dedupe, retention",
    (sf.json.trigger as { triggerKey: string }).triggerKey === "plaid.item.sync_failed" &&
    (sf.json.payload as Array<{ name: string }>).map((p) => p.name).join() === "plaidItemId,institutionName,connectionState" &&
    (sf.json.eligibility as string[]).join() === "connection.removed_by_user" &&
    (sf.json.dedupe as { keyTemplate: string }).keyTemplate === "SYNC_FAILED:item:{plaidItemId}:open" &&
    (sf.json.retention as { inAppArchiveDays: number; deliveryDays: number }).inAppArchiveDays === 30);
  for (const key of ["NOPE", "sync_failed", "", "../../etc", "SYNC_FAILED%00"]) {
    const r = await capture(catalogDetail(key, NOW));
    check(`unknown key ${JSON.stringify(key)} → 404 NOT_FOUND`, r.status === 404 && r.json.code === "NOT_FOUND");
  }
  check("prototype keys are not definitions (__proto__, constructor → 404)",
    catalogDetail("__proto__", NOW).status === 404 && catalogDetail("constructor", NOW).status === 404);
}

async function preview(): Promise<void> {
  console.log("4. preview — synthetic, never sends");
  const capturedBefore = capturedEmails().length;
  let sendCalls = 0;
  const origCapture = captureAdapter.send, origResend = resendAdapter.send;
  captureAdapter.send = async () => { sendCalls++; throw new Error("send seam called from preview"); };
  resendAdapter.send = async () => { sendCalls++; throw new Error("send seam called from preview"); };
  let rendered = 0, conflicts = 0;
  try {
    for (const key of CATALOG_KEYS) {
      const def = COMMS_CATALOG[key];
      for (const channel of PREVIEW_CHANNELS) {
        const variants = previewVariants(def, channel);
        if (variants.length === 0) {
          const r = await capture(catalogPreview(key, u(`/catalog/${key}/preview?channel=${channel}`), NOW));
          if (r.status === 409 && r.json.code === "INVALID_STATE") conflicts++;
          else check(`${key} ${channel}: no rendition → 409 INVALID_STATE`, false, r.status);
          continue;
        }
        for (const variant of variants) {
          const r = await capture(catalogPreview(key, u(`/catalog/${key}/preview?channel=${channel}&variant=${variant}`), NOW));
          const j = r.json;
          const isEmail = channel === "email-html" || channel === "email-text" || channel === "operator";
          const ok = r.status === 200 && j.synthetic === true && j.key === key && j.channel === channel && j.checkedAt === NOW.toISOString() &&
            (j.variants as string[]).includes(variant) &&
            (!isEmail || (typeof j.subject === "string" && (j.subject as string).startsWith("[PREVIEW]") && typeof j.text === "string")) &&
            (channel !== "email-html" || typeof j.html === "string") &&
            (channel !== "email-text" || j.html === null) &&
            (channel !== "in-app" || (j.inApp !== null && typeof (j.inApp as { title: string }).title === "string")) &&
            (channel !== "banner" || (typeof j.text === "string" && j.html === null && j.subject === null));
          if (ok) rendered++;
          else check(`${key} ${channel} ${variant}: renders synthetic data`, false, { status: r.status, j: JSON.stringify(j).slice(0, 200) });
        }
      }
    }
  } finally {
    captureAdapter.send = origCapture;
    resendAdapter.send = origResend;
  }
  check(`every (key × channel × variant) rendered (${rendered}) or refused 409 (${conflicts})`, rendered > 100 && conflicts > 0);
  check("the send seam was never called (both transports stubbed to throw)", sendCalls === 0);
  check("nothing reached the capture buffer", capturedEmails().length === capturedBefore);

  const def = await capture(catalogPreview("SYNC_FAILED", u("/catalog/SYNC_FAILED/preview?channel=email-html"), NOW));
  check("no variant → the first; variants named (reauth-required, legacy-no-state)",
    def.status === 200 && ["notification--connection-reauth-required", "notification--connection-legacy-no-state"].every((v) => (def.json.variants as string[]).includes(v)));
  const inApp = await capture(catalogPreview("SYNC_FAILED", u("/catalog/SYNC_FAILED/preview?channel=in-app&variant=reauth-required"), NOW));
  check("in-app SYNC_FAILED reauth-required uses the registry render", inApp.status === 200 && /needs you to sign in again/.test((inApp.json.inApp as { title: string }).title));
  const op = await capture(catalogPreview("PLATFORM_ALERT", u("/catalog/PLATFORM_ALERT/preview?channel=operator"), NOW));
  check("operator renders platform-alert", op.status === 200 && /platform alert/i.test(op.json.subject as string));
  const ban = await capture(catalogPreview("MAINTENANCE_NOTICE", u("/catalog/MAINTENANCE_NOTICE/preview?channel=banner"), NOW));
  check("banner renders the client notice copy", ban.status === 200 && /Maintenance in progress/.test(ban.json.text as string));
  const reset = await capture(catalogPreview("PASSWORD_RESET_LINK_SENT", u("/catalog/PASSWORD_RESET_LINK_SENT/preview?channel=email-text"), NOW));
  check("ceremony links carry the non-redeemable token", reset.status === 200 && (reset.json.text as string).includes(`token=${PREVIEW_TOKEN}`));

  for (const [q, label] of [
    ["", "missing channel"], ["channel=EMAIL", "uppercase channel"], ["channel=sms", "unknown channel"], ["channel=email-html&channel=", "a second value is ignored but the first must be valid"],
    ["channel=email-html&variant=NOPE", "uppercase variant"], ["channel=email-html&variant=no-such-variant", "unknown variant"],
    ["channel=email-html&to=someone%40example.com", "a data parameter (to)"], ["channel=in-app&data=%7B%7D", "a data parameter (data)"],
  ] as const) {
    const r = await capture(catalogPreview("SYNC_FAILED", u(`/catalog/SYNC_FAILED/preview?${q}`), NOW));
    const expect400 = label !== "a second value is ignored but the first must be valid";
    check(`preview ${label} → ${expect400 ? "400 VALIDATION" : "200"}`, expect400 ? r.status === 400 && r.json.code === "VALIDATION" : r.status === 200);
  }
  const noLeg = await capture(catalogPreview("PLATFORM_ALERT", u("/catalog/PLATFORM_ALERT/preview?channel=in-app"), NOW));
  check("a channel the definition lacks → 409 INVALID_STATE", noLeg.status === 409 && noLeg.json.code === "INVALID_STATE");
  const nf = await capture(catalogPreview("NOPE", u("/catalog/NOPE/preview?channel=in-app"), NOW));
  check("unknown key → 404 before channel validation", nf.status === 404);

  for (const f of ["lib/notifications/catalog/preview.ts", "lib/notifications/catalog/http.ts", "lib/notifications/catalog/definitions.ts", "lib/notifications/catalog/triggers.ts"]) {
    check(`${f}: imports no send chokepoint, transport, channel adapter or DB`,
      !/from\s+["']@\/lib\/(email\/send|email\/providers|notifications\/channels\/email"|db|rate-limit|notifications\/create)/.test(code(f)));
  }
}

function pii(): void {
  console.log("5. no PII in any response");
  const all = seen.join("\n");
  const addresses = [...all.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
  const foreign = [...new Set(addresses.filter((a) => !/@example\.invalid$/.test(a) && a !== "support@fourthmeridian.com"))];
  check(`every address is synthetic (@example.invalid) or the support contact (${addresses.length} seen)`, foreign.length === 0, foreign);
  const tokens = [...new Set([...all.matchAll(/[?&](?:amp;)?token=([^&"\s<\\]+)/g)].map((m) => m[1]))];
  check("every token in any link is the non-redeemable preview token", tokens.length > 0 && tokens.every((t) => t === PREVIEW_TOKEN), tokens);
  const invites = [...new Set([...all.matchAll(/[?&](?:amp;)?invite=([^&"\s<\\]+)/g)].map((m) => m[1]))];
  check("every beta-invite link carries the non-redeemable token", invites.every((t) => t === PREVIEW_TOKEN), invites);
  check("no hex run ≥ 32 (no hashed or raw token, no secret)", !/[0-9a-f]{32,}/i.test(all));
  // DaySeries.to is a UTC day bound ("to":"YYYY-MM-DD"), not a recipient.
  const withoutDayBounds = all.replace(/"to":"\d{4}-\d{2}-\d{2}"/g, "");
  check("no recipient / user field in any payload", !/"(to|recipient|recipientEmail|userId|email|address|dedupeKey)":/.test(withoutDayBounds));
}

async function unavailable(): Promise<void> {
  console.log("6. 503 UNAVAILABLE");
  const r = await runRead({ guard: allow, rateLimit: noLimit }, () => { throw new Error("secret detail user@real.example"); });
  const j = await body(r);
  check("a failed build → 503 { code: UNAVAILABLE }", r.status === 503 && j.code === "UNAVAILABLE");
  check("the error is never echoed", !JSON.stringify(j).includes("secret detail") && !JSON.stringify(j).includes("@"));
  check("503 is no-store", r.headers.get("Cache-Control") === "no-store");
  const ok = catalogList(u("/catalog"), NOW);
  check("every success is no-store", ok.headers.get("Cache-Control") === "no-store");
}

(async () => {
  await gating();
  await list();
  await detail();
  await preview();
  pii();
  await unavailable();
  console.log(failures === 0 ? "\nAll notification catalog API checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
