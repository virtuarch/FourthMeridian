/**
 * lib/notifications/content/content.test.ts  (Comms Center B1 — the pure content layer, pinned)
 *
 *   1. the editable-leg list (§2.1), derived and pinned; locks per definition;
 *      EMAIL_STORM_LIMIT exported from the client-safe vocabulary;
 *   2. code-default PARITY: every editable leg × variant, rendered from its
 *      ContentBody with the fixture values, equals today's registry rendering
 *      (in-app fields; the email byte for byte) — so `code-default` is faithful;
 *   3. the validator: the closed placeholder allowlist and every typed,
 *      per-block issue code, all returned at once; manual severities;
 *   4. escaping and substitution: values are cleaned, never re-expanded, and
 *      every string is escaped by the design system;
 *   5. the AI request: ONLY template text + placeholder NAMES (exact payload);
 *   6. the AI output checks: a dropped placeholder, an added link, an added
 *      figure / claim, added advice and a changed structure are each flagged.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/content/content.test.ts
 */

import { COMMS_CATALOG, EMAIL_STORM_LIMIT as DEF_STORM } from "@/lib/notifications/catalog/definitions";
import { EMAIL_STORM_LIMIT } from "@/lib/notifications/catalog/types";
import { IN_APP_FIXTURES } from "@/lib/notifications/catalog/preview";
import { PREVIEW_APP_BASE } from "@/lib/email/preview";
import { NOTIFICATION_REGISTRY, type NotificationTypeId } from "@/lib/notifications/registry";
import { buildNotificationEmailData } from "@/lib/notifications/channels/email-data";
import { renderNotificationEmail } from "@/lib/email/templates/notification";
import { contentVariants, definitionLock, editableLegs, legEditability, legSpec, variantFor, type LegSpec } from "./legs";
import { parseContentBody, placeholdersUsed, validateContent } from "./validate";
import { inAppRender, renderContentEmail, substitute, textValues } from "./render";
import { ADVICE_LEXICON, CLAIM_LEXICON, adviceHits, claimHits, figureTokens, linkHits } from "./lint";
import { AI_SYSTEM_PROMPT, buildAiRequest, checkSuggestion, normaliseSuggestion } from "./ai";
import type { ContentBody, ContentIssue } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const spec = (key: string, ch: "EMAIL" | "IN_APP"): LegSpec => {
  const s = legSpec(key, ch);
  if (!s) throw new Error(`no spec for ${key}/${ch}`);
  return s;
};
const codes = (issues: readonly ContentIssue[]) => issues.map((i) => i.code);
const manual = (s: LegSpec, body: ContentBody, variant = "default") => validateContent(s, body, { mode: "manual", baseline: s.codeDefault(variant), variant });

function legs(): void {
  console.log("1. editable legs (§2.1)");
  const got = editableLegs().map((l) => `${l.key}/${l.channel}`).sort();
  const PINNED = [
    "ACCOUNT_WELCOME/IN_APP",
    "IMPORT_COMPLETED/EMAIL", "IMPORT_COMPLETED/IN_APP",
    "IMPORT_COMPLETED_WITH_ERRORS/EMAIL", "IMPORT_COMPLETED_WITH_ERRORS/IN_APP",
    "MEMBER_REMOVED/EMAIL", "MEMBER_REMOVED/IN_APP",
    "MEMBER_ROLE_CHANGED/EMAIL", "MEMBER_ROLE_CHANGED/IN_APP",
    "SPACE_INVITE_ACCEPTED/EMAIL", "SPACE_INVITE_ACCEPTED/IN_APP",
    "SPACE_INVITE_RECEIVED/IN_APP",
    "SYNC_COMPLETED/EMAIL", "SYNC_COMPLETED/IN_APP",
    "SYNC_FAILED/EMAIL", "SYNC_FAILED/IN_APP",
    "WALLET_SYNC_FAILED/EMAIL", "WALLET_SYNC_FAILED/IN_APP",
  ].sort();
  check("the editable-leg list is exactly the pinned list", JSON.stringify(got) === JSON.stringify(PINNED), got);
  for (const d of Object.values(COMMS_CATALOG)) {
    if (d.protected) check(`${d.key}: protected ⇒ every leg PROTECTED`, ["EMAIL", "IN_APP"].every((c) => { const e = legEditability(d, c); return !e.editable && e.reason === "PROTECTED"; }));
    if (d.consentClass === "SECURITY_CRITICAL" || d.consentClass === "CEREMONY" || d.consentClass === "OPERATOR") {
      check(`${d.key}: ${d.consentClass} is locked`, definitionLock(d)?.reason === "PROTECTED");
    }
  }
  check("SPACE_INVITE_RECEIVED EMAIL (the space-invite ceremony email) is PROTECTED", (() => { const e = legEditability(COMMS_CATALOG.SPACE_INVITE_RECEIVED, "EMAIL"); return !e.editable && e.reason === "PROTECTED"; })());
  check("ACCOUNT_WELCOME EMAIL (the direct welcome template) is PROTECTED", (() => { const e = legEditability(COMMS_CATALOG.ACCOUNT_WELCOME, "EMAIL"); return !e.editable && e.reason === "PROTECTED"; })());
  check("DIGEST_SENT (BUILD_OFF) is NOT_EDITABLE, not protected", definitionLock(COMMS_CATALOG.DIGEST_SENT)?.reason === "NOT_EDITABLE");
  check("PASSWORD_RESET_LINK_SENT / BETA_INVITATION_ISSUED / PLATFORM_ACCESS_GRANTED are PROTECTED",
    ["PASSWORD_RESET_LINK_SENT", "BETA_INVITATION_ISSUED", "PLATFORM_ACCESS_GRANTED"].every((k) => definitionLock(COMMS_CATALOG[k as keyof typeof COMMS_CATALOG])?.reason === "PROTECTED"));
  check("banners are never editable", ["MAINTENANCE_NOTICE", "TWO_FACTOR_REMINDER", "CONNECT_INVITATION"].every((k) => definitionLock(COMMS_CATALOG[k as keyof typeof COMMS_CATALOG]) !== null));
  check("SYNC_FAILED variants = CONNECTION_STATES + legacy-no-state",
    JSON.stringify(contentVariants("SYNC_FAILED")) === JSON.stringify(["sync-failed", "reauth-required", "disconnected", "legacy-no-state"]));
  check("variantFor: SYNC_FAILED state → its stream; missing / unknown → legacy-no-state",
    variantFor("SYNC_FAILED", { connectionState: "disconnected" }) === "disconnected" && variantFor("SYNC_FAILED", {}) === "legacy-no-state" && variantFor("SYNC_FAILED", { connectionState: "x" }) === "legacy-no-state");
  check("EMAIL_STORM_LIMIT is exported from the client-safe types (5 / 60) and is the same object definitions re-exports",
    EMAIL_STORM_LIMIT.maxPerRecipient === 5 && EMAIL_STORM_LIMIT.windowMinutes === 60 && DEF_STORM === EMAIL_STORM_LIMIT);
  check("SYNC_FAILED requires {{institutionName}} in the subject", spec("SYNC_FAILED", "IN_APP").placeholders.some((p) => p.name === "institutionName" && p.requiredIn?.includes("subject")));
  check("no LINK placeholder carries a request or operator source", editableLegs().every((l) => spec(l.key, l.channel).placeholders.every((p) => p.kind !== "LINK" || p.source.from === "IN_APP_HREF")));
}

function parity(): void {
  console.log("2. code-default parity (no published version ⇒ today's rendering)");
  for (const { key, channel } of editableLegs()) {
    const s = spec(key, channel);
    const fixtures = IN_APP_FIXTURES[key as NotificationTypeId];
    for (const [name, data] of Object.entries(fixtures)) {
      const variant = variantFor(key, data);
      const reg = NOTIFICATION_REGISTRY[key as NotificationTypeId];
      const code = (reg.render as (d: Record<string, unknown>) => { title: string; body?: string; href?: string; actionLabel?: string })(data);
      const body = s.codeDefault(variant);
      const values = textValues(s, data);
      check(`${key}/${channel}/${name}: code default is clean under the validator`, manual(s, body, variant).length === 0, manual(s, body, variant));
      if (channel === "IN_APP") {
        const r = inAppRender(s, body, values, variant);
        check(`${key}/IN_APP/${name}: title/body/href/actionLabel equal the registry render`,
          r.title === code.title && (r.body ?? null) === (code.body ?? null) && (r.href ?? null) === (code.href ?? null) && (r.actionLabel ?? null) === (code.href ? code.actionLabel ?? null : null), { r, code });
      } else {
        const viaContent = renderContentEmail({ spec: s, body, values, variant, appBaseUrl: PREVIEW_APP_BASE, category: reg.category, preview: false });
        const viaCode = renderNotificationEmail(buildNotificationEmailData({ title: code.title, body: code.body, href: code.href, actionLabel: code.actionLabel, category: reg.category }, PREVIEW_APP_BASE));
        // The hidden preheader is the only part that may differ: the template uses the whole body,
        // operator content caps it at 140 (the code default is cut at a word boundary).
        const stripPre = (h: string) => h.replace(/<div class="fm-preheader"[\s\S]*?<\/div>/, "");
        const sameHtml = !(body.preheader ?? "").endsWith("…") ? viaContent.html === viaCode.html : stripPre(viaContent.html) === stripPre(viaCode.html);
        check(`${key}/EMAIL/${name}: subject, html and text are byte-identical to the notification template`,
          viaContent.subject === viaCode.subject && sameHtml && viaContent.text === viaCode.text);
      }
    }
  }
}

function validator(): void {
  console.log("3. validator — closed allowlist, typed per-block issues");
  const sf = spec("SYNC_FAILED", "EMAIL");
  const ok = sf.codeDefault("reauth-required");
  const bad: ContentBody = {
    subject: "Hello {{firstName}}",                                            // unknown + required missing
    preheader: "Line one\nline two",                                           // control characters
    blocks: [
      { kind: "paragraph", text: "Visit {{actionUrl}} now {{ broken" },        // kind mismatch + malformed
      { kind: "hero", heading: "x".repeat(130) },                             // order + too long
      { kind: "cta", label: "Go", link: "institutionName" },                   // TEXT as link
      { kind: "info", items: Array.from({ length: 9 }, () => "item") },        // too many items
      { kind: "paragraph", text: "Call 555-123-4567 or see example.com" },     // link
      { kind: "paragraph", text: "Card 4111222233334444" },                    // pii-like
      { kind: "paragraph", text: "" },                                          // empty
    ],
  };
  const issues = manual(sf, bad, "reauth-required");
  const c = codes(issues);
  for (const want of ["UNKNOWN_PLACEHOLDER", "REQUIRED_PLACEHOLDER_MISSING", "CONTROL_CHARACTERS", "PLACEHOLDER_KIND_MISMATCH", "MALFORMED_PLACEHOLDER",
    "BLOCK_ORDER", "FIELD_TOO_LONG", "TOO_MANY_ITEMS", "LINK_NOT_ALLOWED", "PII_LIKE_CONTENT", "EMPTY_FIELD"] as const) {
    check(`returns ${want}`, c.includes(want), c);
  }
  const unknown = issues.find((i) => i.code === "UNKNOWN_PLACEHOLDER" && i.placeholder === "firstName");
  check("UNKNOWN_PLACEHOLDER names the placeholder and the field", unknown?.location?.field === "subject", unknown);
  const mismatch = issues.filter((i) => i.code === "PLACEHOLDER_KIND_MISMATCH");
  check("PLACEHOLDER_KIND_MISMATCH is located per block (paragraph text, cta link)",
    mismatch.some((i) => i.location?.field === "block" && i.location.blockIndex === 0 && i.location.prop === "text")
    && mismatch.some((i) => i.location?.field === "block" && i.location.blockIndex === 2 && i.location.prop === "link"), mismatch);
  check("all issues come back at once, and the button-link rule is template-level (location null)",
    issues.some((i) => i.code === "REQUIRED_PLACEHOLDER_MISSING" && i.location === null) && issues.length >= 11);
  check("messages never echo content (no field text in any message)", issues.every((i) => !i.message.includes("555-123") && !i.message.includes("4111")));

  const inApp = spec("SYNC_FAILED", "IN_APP");
  const ia = manual(inApp, { subject: "{{institutionName}} t", preheader: "p", blocks: [{ kind: "info", items: ["a"] }, { kind: "paragraph", text: "a" }, { kind: "paragraph", text: "b" }] }, "reauth-required");
  check("IN_APP: preheader, info blocks, a second paragraph and >2 blocks are refused",
    ["BLOCK_KIND_NOT_ALLOWED", "TOO_MANY_BLOCKS"].every((x) => codes(ia).includes(x as never)), codes(ia));
  check("IN_APP: a cta must link to inAppHref (actionUrl is unknown there)",
    codes(manual(inApp, { subject: "{{institutionName}}", preheader: null, blocks: [{ kind: "cta", label: "Go", link: "actionUrl" }] }, "reauth-required")).includes("UNKNOWN_PLACEHOLDER"));
  check("EMAIL: no block at all is EMPTY_CONTENT; 13 blocks is TOO_MANY_BLOCKS",
    codes(manual(sf, { ...ok, blocks: [] }, "reauth-required")).includes("EMPTY_CONTENT")
    && codes(manual(sf, { ...ok, blocks: [...ok.blocks, ...Array.from({ length: 10 }, () => ({ kind: "divider" as const }))] }, "reauth-required")).includes("TOO_MANY_BLOCKS"));
  check("EMAIL: a security / expiry block (not operator blocks) is BLOCK_KIND_NOT_ALLOWED",
    (() => { const p = parseContentBody({ ...ok, blocks: [...ok.blocks, { kind: "security" }] }); return p.ok && codes(manual(sf, p.value, "reauth-required")).includes("BLOCK_KIND_NOT_ALLOWED"); })());
  check("a body that is not a ContentBody at all is a shape error (400 VALIDATION)",
    !parseContentBody({ subject: 1 }).ok && !parseContentBody([]).ok && !parseContentBody({ subject: "s", preheader: null, blocks: [{ kind: "cta", label: "x" }] }).ok);
  const fin = manual(sf, { ...ok, blocks: [ok.blocks[0], { kind: "paragraph", text: "Earn 5% APR, guaranteed. We recommend you buy now." }, ok.blocks[2]] }, "reauth-required");
  check("manual draft: financial claim and advice are WARNINGS (operator accountable), not errors",
    fin.some((i) => i.code === "FINANCIAL_CLAIM" && i.severity === "warning") && fin.some((i) => i.code === "ADVICE_LANGUAGE" && i.severity === "warning")
    && fin.every((i) => i.severity === "warning"), fin);
  check("placeholdersUsed: distinct, first-use order, includes the cta link", JSON.stringify(placeholdersUsed(ok, "EMAIL")) === JSON.stringify(["institutionName", "actionUrl"]), placeholdersUsed(ok, "EMAIL"));
  check("lexicons are closed and pinned", CLAIM_LEXICON.length === 25 && ADVICE_LEXICON.length === 27
    && ["guarantee", "risk-free", "returns", "apr", "interest rate", "earn", "grow your money"].every((t) => CLAIM_LEXICON.includes(t))
    && ["you should invest", "we recommend", "buy", "sell", "tax advice", "legal advice", "financial advice", "consult a", "deduct", "write off"].every((t) => ADVICE_LEXICON.includes(t)));
}

function lexicons(): void {
  console.log("3b. link / claim / advice lexicons after normalisation (review P1, P3)");
  const sf = spec("SYNC_FAILED", "EMAIL");
  const base = sf.codeDefault("reauth-required");
  const withText = (t: string): ContentBody => ({ ...base, blocks: base.blocks.map((b) => (b.kind === "paragraph" ? { ...b, text: `${b.text} ${t}` } : b)) });
  const wire = (b: ContentBody) => ({ subject: b.subject, preheader: b.preheader, notes: [],
    blocks: b.blocks.map((x) => ({ kind: x.kind, heading: x.kind === "hero" ? x.heading : null, greeting: null, text: x.kind === "paragraph" ? x.text : null, label: x.kind === "cta" ? x.label : null, link: x.kind === "cta" ? x.link : null, title: null, items: null })) });
  const aiCodes = (b: ContentBody) => { const n = normaliseSuggestion(wire(b), base); return n.ok ? codes(checkSuggestion(sf, "reauth-required", base, n.body)) : codes(n.issues); };
  const LINKS = ["see evil.ru", "evil.to", "evil.shop", "bit.do/abc", "//evil.ru/x", "[click](//evil.ru)", "ｅｖｉｌ．ｃｏｍ", "hxxp://evil", "evil dot com", "evil (dot) com", "evil[.]com", "www.evil", "WWW.EVIL.NET", "mail me@x.co", "call 555 123 4567"];
  for (const t of LINKS) {
    check(`link "${t}" is flagged by the draft validator`, codes(manual(sf, withText(t), "reauth-required")).includes("LINK_NOT_ALLOWED"));
    check(`link "${t}" is flagged by checkSuggestion`, aiCodes(withText(t)).includes("LINK_NOT_ALLOWED"));
  }
  const PROSE = ["3.5% APR", "Q3.", "U.S. accounts", "e.g. your bank", "at 9 a.m. today", "Fourth Meridian.", "version 2.0 is out", "i.e. soon", "Ph.D. holders", "and/or later"];
  for (const t of PROSE) check(`ordinary prose "${t}" is not a link`, linkHits(t).length === 0, linkHits(t));
  check("claims match across NBSP and non-breaking hyphens", claimHits("risk\u2011free").length > 0 && claimHits("risk\u00A0free").length > 0 && claimHits("high\u2013yield").length > 0 && claimHits("ＥＡＲＮ more").length > 0);
  check("investment imperatives are advice", ["Invest now", "start investing today", "Act now", "don\u2019t miss out"].every((t) => adviceHits(t).length > 0));
  check("spelled-out figures are figures", figureTokens("ten percent").length > 0 && figureTokens("fifty dollars").length > 0 && figureTokens("twenty-five per cent").length > 0 && figureTokens("a few percent").length > 0);
  check("no false positives in plain service copy", ["ten minutes", "one of your accounts", "your tenant", "learn more in Settings", "we couldn't sync your bank"].every((t) => figureTokens(t).length === 0 && claimHits(t).length === 0 && adviceHits(t).length === 0 && linkHits(t).length === 0));
  check("an added spelled-out percentage is FINANCIAL_CLAIM in an AI suggestion", aiCodes(withText("Earn ten percent.")).includes("FINANCIAL_CLAIM") && aiCodes(withText("Get ten percent back.")).includes("FINANCIAL_CLAIM"));
  check("an added imperative is ADVICE_LANGUAGE in an AI suggestion", aiCodes(withText("Invest now.")).includes("ADVICE_LANGUAGE"));
  for (const { key, channel } of editableLegs()) {
    const s2 = spec(key, channel);
    check(`${key}/${channel}: every code default stays clean under the stricter lexicons`, s2.variants.every((v) => manual(s2, s2.codeDefault(v), v).length === 0));
  }
}

function escaping(): void {
  console.log("4. escaping and substitution (server-side)");
  const s = spec("SYNC_FAILED", "EMAIL");
  const evil = { institutionName: "<b>Bank</b>\"><script>alert(1)</script>{{institutionName}}‮\nX", connectionState: "reauth-required" };
  const values = textValues(s, evil);
  check("values are cleanText-ed: no controls, newline or bidi override", !/[\n‮]/.test(values.institutionName));
  check("one pass: a value containing {{…}} is inserted literally, never re-expanded",
    substitute("A {{institutionName}} B", { institutionName: "{{institutionName}}" }) === "A {{institutionName}} B");
  check("one pass: a value naming ANOTHER placeholder is never expanded either", substitute("{{a}}", { a: "{{b}}", b: "X" }) === "{{b}}");
  check("an unknown {{token}} is left as typed (never resolved from anywhere)", substitute("{{nope}}", {}) === "{{nope}}");
  const body: ContentBody = { subject: "{{institutionName}} alert", preheader: "pre <i>x</i>", blocks: [{ kind: "hero", heading: "Hi <img src=x onerror=alert(1)>" }, { kind: "paragraph", text: "{{institutionName}} & co" }, { kind: "cta", label: "Fix", link: "actionUrl" }] };
  const r = renderContentEmail({ spec: s, body, values, variant: "reauth-required", appBaseUrl: PREVIEW_APP_BASE, category: "FINANCIAL", preview: true });
  check("no raw <script>, <img src=x> or <b> from a value or operator text reaches the HTML", !/<script|<img src=x|<b>Bank|<i>x/i.test(r.html));
  check("they render escaped as text", r.html.includes("&lt;script&gt;") && r.html.includes("&lt;img src=x"));
  check("the CTA URL is the trusted app base + the registry href", r.html.includes(`${PREVIEW_APP_BASE}/dashboard/connections`) && r.text.includes(`${PREVIEW_APP_BASE}/dashboard/connections`));
  check("the locked frame stays code: footer reason, preference link and legal links present", /notification settings/i.test(r.text) && /Privacy|Terms/i.test(r.text));
  check("preview subjects are marked [PREVIEW]", r.subject.startsWith("[PREVIEW] "));
  check("braces are stripped from values, so no send can carry a literal {{…}}", !/[{}]/.test(textValues(s, { institutionName: "{{x}} Bank }}" }).institutionName));
  check("missing values take the fallback, never empty / \"undefined\"", textValues(s, {}).institutionName === "your institution");
}

function aiRequest(): void {
  console.log("5. the AI request carries ONLY template text and placeholder names");
  for (const { key, channel } of editableLegs()) {
    const s = spec(key, channel);
    for (const variant of s.variants) {
      const base = s.codeDefault(variant);
      const names = placeholdersUsed(base, channel);
      const req = buildAiRequest(base, names, "POLISH", "WARM");
      const allowed = new Set<string>([base.subject, ...(base.preheader !== null ? [base.preheader] : []), "POLISH", "WARM",
        ...base.blocks.flatMap((b) => [b.kind, ...("heading" in b ? [b.heading] : []), ...("greeting" in b && b.greeting ? [b.greeting] : []),
          ...("text" in b ? [b.text] : []), ...("label" in b ? [b.label, b.link] : []), ...("title" in b && b.title ? [b.title] : []), ...("items" in b ? b.items : [])]),
        ...names.map((n) => `{{${n}}}`)]);
      const strings: string[] = [];
      const walk = (v: unknown) => { if (typeof v === "string") strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
      const payload = JSON.parse(req.messages[0].content) as Record<string, unknown>;
      walk(payload);
      const extra = strings.filter((x) => !allowed.has(x));
      check(`${key}/${channel}/${variant}: one user message, keys {mode,tone,placeholders,content}, every string is base text / a kind / a {{name}}`,
        req.messages.length === 1 && req.system === AI_SYSTEM_PROMPT && JSON.stringify(Object.keys(payload)) === JSON.stringify(["mode", "tone", "placeholders", "content"]) && extra.length === 0, extra);
      const serial = JSON.stringify(req);
      check(`${key}/${channel}/${variant}: no sample, fallback or fixture value is sent`,
        s.placeholders.filter((p) => p.kind === "TEXT").every((p) => (p.sample.length < 4 || !serial.includes(p.sample)) && (p.fallback.length < 4 || !serial.includes(`"${p.fallback}"`))));
    }
  }
}

function aiChecks(): void {
  console.log("6. AI output checks (§4.4)");
  const s = spec("SYNC_FAILED", "EMAIL");
  const base = s.codeDefault("reauth-required");
  const wire = (b: ContentBody) => ({
    subject: b.subject, preheader: b.preheader, notes: [],
    blocks: b.blocks.map((x) => ({ kind: x.kind, heading: x.kind === "hero" ? x.heading : null, greeting: null, text: x.kind === "paragraph" ? x.text : null,
      label: x.kind === "cta" ? x.label : null, link: x.kind === "cta" ? x.link : null, title: null, items: null })),
  });
  const run = (mut: (b: ContentBody) => ContentBody) => {
    const n = normaliseSuggestion(wire(mut(JSON.parse(JSON.stringify(base)) as ContentBody)), base);
    return n.ok ? codes(checkSuggestion(s, "reauth-required", base, n.body)) : codes(n.issues);
  };
  check("a clean rewrite passes every check", run((b) => ({ ...b, blocks: b.blocks.map((x) => x.kind === "paragraph" ? { ...x, text: "Please sign in to {{institutionName}} again so your accounts stay current. Until you do, {{institutionName}} cannot sync." } : x) })).length === 0);
  check("a dropped placeholder is PLACEHOLDERS_DROPPED", run((b) => ({ ...b, subject: "Your bank needs you to sign in again" })).includes("PLACEHOLDERS_DROPPED"));
  check("an added placeholder is PLACEHOLDERS_ADDED", run((b) => ({ ...b, subject: `${b.subject} {{institutionName}}` })).includes("PLACEHOLDERS_ADDED"));
  check("an added link is LINK_NOT_ALLOWED", run((b) => ({ ...b, blocks: b.blocks.map((x) => x.kind === "paragraph" ? { ...x, text: `${x.text} See https://evil.example.com` } : x) })).includes("LINK_NOT_ALLOWED"));
  check("an added bare domain is LINK_NOT_ALLOWED", run((b) => ({ ...b, blocks: b.blocks.map((x) => x.kind === "paragraph" ? { ...x, text: `${x.text} Visit evil.com.` } : x) })).includes("LINK_NOT_ALLOWED"));
  check("an added figure is FINANCIAL_CLAIM", run((b) => ({ ...b, blocks: b.blocks.map((x) => x.kind === "paragraph" ? { ...x, text: `${x.text} Save $50 today.` } : x) })).includes("FINANCIAL_CLAIM"));
  check("added guarantee language is FINANCIAL_CLAIM", run((b) => ({ ...b, blocks: b.blocks.map((x) => x.kind === "paragraph" ? { ...x, text: `${x.text} Your data is guaranteed safe.` } : x) })).includes("FINANCIAL_CLAIM"));
  check("added advice is ADVICE_LANGUAGE", run((b) => ({ ...b, blocks: b.blocks.map((x) => x.kind === "paragraph" ? { ...x, text: `${x.text} We recommend you sell your stocks.` } : x) })).includes("ADVICE_LANGUAGE"));
  check("a removed block is STRUCTURE_CHANGED", run((b) => ({ ...b, blocks: b.blocks.slice(0, 2) })).includes("STRUCTURE_CHANGED"));
  check("a changed cta link is STRUCTURE_CHANGED", (() => { const w = wire(base); (w.blocks[2] as { link: string | null }).link = "inAppHref"; const n = normaliseSuggestion(w, base); return !n.ok && codes(n.issues).includes("STRUCTURE_CHANGED"); })());
  check("an unparseable shape is STRUCTURE_CHANGED (location null)", (() => { const n = normaliseSuggestion({ nope: true }, base); return !n.ok && n.issues[0].code === "STRUCTURE_CHANGED" && n.issues[0].location === null; })());
  check("every AI issue is an error (never returned as clean)", (() => { const n = normaliseSuggestion(wire({ ...base, subject: "x" }), base); return n.ok && checkSuggestion(s, "reauth-required", base, n.body).every((i) => i.severity === "error"); })());
}

legs();
parity();
validator();
lexicons();
escaping();
aiRequest();
aiChecks();
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall content checks passed");
