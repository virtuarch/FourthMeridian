/**
 * components/platform/growth/beta-request-review.test.ts  (PB-6)
 *
 * The pure review model (beta-request-review-model.ts) with a scripted Poster —
 * which routes each action calls, in what order, and every outcome's words,
 * partial failures first — plus the source pins on BetaRequestReview.tsx and
 * the Beta Access widget: write controls only for WRITE (UI-001), every
 * mutation through the model (no ad-hoc deny / verdict fetch), no blocklist
 * key material anywhere in the client.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/growth/beta-request-review.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DENY_AND_BLOCK_COPY, DENY_COPY, blockStateText, denyUrl, plainDenyEffect, reviewActions, riskReviewUrl,
  runDeny, runDenyAndBlock, runVerdict, verdictEffect, type PostResult, type Poster,
} from "./beta-request-review-model";
import { betaRequestListSearch, parseBetaRequestListQuery } from "@/lib/platform/growth/beta-request-list-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}

/** A Poster that answers from a script, recording every call. */
function scripted(answers: PostResult[]): { post: Poster; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      const a = answers.shift();
      if (!a) throw new Error(`unscripted call to ${url}`);
      return a;
    },
  };
}
const ok = (body: Record<string, unknown> = {}): PostResult => ({ ok: true, status: 200, body });
const fail = (status: number, body: Record<string, unknown> = {}): PostResult => ({ ok: false, status, body });
const UNAVAILABLE = fail(409, { error: "The blocklist is unavailable (its key is not configured), so a block could not be recorded. Nothing was changed.", code: "BLOCKLIST_UNAVAILABLE" });
const REASON = { code: "ABUSE" as const, note: "burst" };
const ID = "req_1";

void (async () => {
  console.log("1. Deny — the deny route only");
  {
    const s = scripted([ok({ success: true, identifierBlocked: false })]);
    const o = await runDeny(ID, s.post);
    check("one call, to …/deny, with an empty body", s.calls.length === 1 && s.calls[0].url === denyUrl(ID) && JSON.stringify(s.calls[0].body) === "{}", s.calls);
    check("outcome says the address is NOT blocked", o.tone === "success" && /not blocked/.test(o.message) && !o.offerBlockNow, o);
    const s2 = scripted([ok({ success: true, identifierBlocked: true })]);
    const o2 = await runDeny(ID, s2.post);
    check("a deny that blocked (already Suspicious) says so", /already marked Suspicious/.test(o2.message), o2);
    const s3 = scripted([UNAVAILABLE]);
    const o3 = await runDeny(ID, s3.post);
    check("deny 409 BLOCKLIST_UNAVAILABLE → 'Not denied … Nothing was changed'", o3.tone === "error" && /^Not denied/.test(o3.message) && /Nothing was changed/.test(o3.message), o3);
  }

  console.log("2. Deny and block — deny FIRST, then risk-review SUSPICIOUS");
  {
    const s = scripted([ok({ success: true, identifierBlocked: false }), ok({ success: true, blocklist: { blocked: "created", removed: 0 } })]);
    const o = await runDenyAndBlock(ID, REASON, "burst", s.post);
    check("two calls: deny, then risk-review", s.calls.length === 2 && s.calls[0].url === denyUrl(ID) && s.calls[1].url === riskReviewUrl(ID), s.calls.map((c) => c.url));
    check("the verdict is SUSPICIOUS with the operator's reason and note", JSON.stringify(s.calls[1].body) === JSON.stringify({ status: "SUSPICIOUS", reason: REASON, note: "burst" }), s.calls[1].body);
    check("success: 'Denied and blocked … silently dropped'", o.tone === "success" && /^Denied and blocked/.test(o.message) && /silently dropped/.test(o.message) && !o.offerBlockNow, o);

    const sa = scripted([ok({ success: true }), ok({ success: true, blocklist: { blocked: "alreadyBlocked", removed: 0 } })]);
    check("alreadyBlocked counts as blocked", /^Denied and blocked/.test((await runDenyAndBlock(ID, REASON, null, sa.post)).message));
    check("no note ⇒ the verdict body carries no note key", !("note" in (sa.calls[1].body as object)));

    // Step 1 fails ⇒ step 2 never runs.
    const f1 = scripted([fail(403, { error: "Re-authenticate to continue." })]);
    const o1 = await runDenyAndBlock(ID, REASON, null, f1.post);
    check("deny fails ⇒ the verdict is never posted", f1.calls.length === 1, f1.calls);
    check("deny fails ⇒ 'Not denied and not blocked — <server error>. Nothing was changed.'",
      o1.tone === "error" && o1.message === "Not denied and not blocked — Re-authenticate to continue. Nothing was changed." && !o1.offerBlockNow, o1);
    const f0 = scripted([fail(0)]);
    check("network failure is named as such", /network error/.test((await runDenyAndBlock(ID, REASON, null, f0.post)).message));

    // Step 2 fails ⇒ denied but NOT blocked, Block now offered.
    const f2 = scripted([ok({ success: true, identifierBlocked: false }), UNAVAILABLE]);
    const o2 = await runDenyAndBlock(ID, REASON, null, f2.post);
    check("verdict 409 BLOCKLIST_UNAVAILABLE ⇒ 'Denied, but NOT blocked' + blocklist unavailable + Block now",
      o2.tone === "warning" && /^Denied, but NOT blocked — the blocklist is unavailable/.test(o2.message) && /denial stands/.test(o2.message) && o2.offerBlockNow, o2);
    const f3 = scripted([ok({ success: true }), fail(429, { error: "Too many requests" })]);
    const o3 = await runDenyAndBlock(ID, REASON, null, f3.post);
    check("verdict fails otherwise ⇒ 'Denied, but NOT blocked — recording the Suspicious verdict failed (<error>)' + Block now",
      o3.tone === "warning" && /^Denied, but NOT blocked — recording the Suspicious verdict failed \(Too many requests\)/.test(o3.message) && o3.offerBlockNow, o3);

    // Both succeed, but no key outside Production ⇒ nothing written, no futile retry.
    const sk = scripted([ok({ success: true, identifierBlocked: false }), ok({ success: true, blocklist: { blocked: null, removed: 0 } })]);
    const o4 = await runDenyAndBlock(ID, REASON, null, sk.post);
    check("skipped block ⇒ 'no block was written', no Block now", o4.tone === "warning" && /no block was written/.test(o4.message) && !o4.offerBlockNow, o4);
  }

  console.log("3. verdicts — Block address / Clear block / Mark …");
  {
    const s = scripted([ok({ blocklist: { blocked: "created", removed: 0 } })]);
    const o = await runVerdict(ID, "SUSPICIOUS", REASON, null, { requestStatus: "DENIED" }, s.post);
    check("Block address posts SUSPICIOUS to risk-review only", s.calls.length === 1 && s.calls[0].url === riskReviewUrl(ID) && (s.calls[0].body as { status: string }).status === "SUSPICIOUS");
    check("…and says it blocked", /blocked/.test(o.message) && o.tone === "success", o);
    const u = scripted([UNAVAILABLE]);
    const ou = await runVerdict(ID, "SUSPICIOUS", REASON, null, { requestStatus: "DENIED" }, u.post);
    check("409 BLOCKLIST_UNAVAILABLE ⇒ an honest 'Not recorded — the blocklist is unavailable … Nothing was changed.'",
      ou.tone === "error" && /^Not recorded — the blocklist is unavailable/.test(ou.message) && /Nothing was changed\.$/.test(ou.message), ou);
    const c = scripted([ok({ blocklist: { blocked: null, removed: 1 } })]);
    const oc = await runVerdict(ID, "UNREVIEWED", { code: "SUPPORT_REQUEST" }, null, { requestStatus: "DENIED" }, c.post);
    check("Clear block (UNREVIEWED) says the block was removed", /block this request caused was removed/.test(oc.message), oc);
    const n = scripted([ok({ blocklist: { blocked: null, removed: 0 } })]);
    check("a clearing verdict with nothing to remove says so", /no active block to remove/.test((await runVerdict(ID, "LEGITIMATE", REASON, null, { requestStatus: "PENDING" }, n.post)).message));
    const p = scripted([ok({ blocklist: { blocked: null, removed: 0 } })]);
    check("SUSPICIOUS on PENDING says nothing is blocked yet", /Nothing is blocked yet/.test((await runVerdict(ID, "SUSPICIOUS", REASON, null, { requestStatus: "PENDING" }, p.post)).message));
  }

  console.log("4. actions — WRITE only, by status");
  {
    const NB = { state: "NOT_BLOCKED" } as const;
    const B = { state: "BLOCKED", since: "2026-11-01T00:00:00.000Z", expiresAt: "2028-11-01T00:00:00.000Z" } as const;
    for (const st of ["PENDING", "APPROVED", "DENIED", "REDEEMED"] as const) {
      check(`READ holder: no actions on ${st}`, reviewActions(false, st, NB).length === 0 && reviewActions(false, st, B).length === 0);
    }
    check("PENDING: Deny + Deny and block + three verdicts", JSON.stringify(reviewActions(true, "PENDING", NB)) === JSON.stringify(["deny", "denyAndBlock", "markLegitimate", "markSuspicious", "markUnreviewed"]));
    check("DENIED, not blocked: Block address", reviewActions(true, "DENIED", NB).includes("blockAddress") && !reviewActions(true, "DENIED", NB).includes("clearBlock"));
    check("DENIED, blocked: Clear block", reviewActions(true, "DENIED", B).includes("clearBlock") && !reviewActions(true, "DENIED", B).includes("blockAddress"));
    check("no Deny outside PENDING", !reviewActions(true, "APPROVED", NB).includes("deny") && !reviewActions(true, "DENIED", NB).includes("denyAndBlock"));
    check("blocked state text (no HMAC / address)", blockStateText(B, "ENFORCED") === "Blocked by this request — expires 2028-11-01"
      && /not configured/.test(blockStateText(NB, "NOT_CONFIGURED")) && /unavailable/.test(blockStateText(NB, "UNAVAILABLE")) && blockStateText(NB, "ENFORCED") === "Not blocked by this request");
    check("Deny copy says it does not block; Deny and block copy says future requests are silently dropped",
      /does not block this address/.test(DENY_COPY) && /future requests from this address are silently dropped/.test(DENY_AND_BLOCK_COPY));
    check("plain Deny on an already-Suspicious request warns it WILL block", /WILL block/.test(plainDenyEffect("SUSPICIOUS")) && /does not block/.test(plainDenyEffect(null)));
    check("verdict effects: SUSPICIOUS on DENIED blocks; clearing a blocked one clears", /Blocks this address/.test(verdictEffect("SUSPICIOUS", "DENIED", NB))
      && /Clears the block/.test(verdictEffect("LEGITIMATE", "DENIED", B)) && /never blocked/.test(verdictEffect("SUSPICIOUS", "REDEEMED", NB)));
  }

  console.log("5. the list query (client ↔ route)");
  {
    const p = (qs: string) => parseBetaRequestListQuery(new URLSearchParams(qs));
    const a = p("view=DENIED&verdict=SUSPICIOUS&page=2&pageSize=10");
    check("parses view / verdict / page / pageSize", a.ok && a.query.view === "DENIED" && a.query.verdict === "SUSPICIOUS" && a.query.page === 2 && a.query.pageSize === 10, a);
    const d = p("view=ALL");
    check("defaults: page 1, pageSize 25, no verdict", d.ok && d.query.page === 1 && d.query.pageSize === 25 && d.query.verdict === null, d);
    check("rejects unknown view / verdict / oversize page", !p("view=x").ok && !p("view=ALL&verdict=LEGITIMATE").ok && !p("view=ALL&pageSize=500").ok && !p("view=ALL&page=-1").ok);
    const round = parseBetaRequestListQuery(new URLSearchParams(betaRequestListSearch({ view: "REDEEMED", verdict: "SUSPICIOUS", page: 3 })));
    check("betaRequestListSearch round-trips", round.ok && round.query.view === "REDEEMED" && round.query.verdict === "SUSPICIOUS" && round.query.page === 3, round);
  }

  console.log("6. source pins — WRITE-only controls, model-only mutations, no key material");
  {
    const ROOT = process.cwd();
    const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const matchParen = (src: string, open: number) => {
      let depth = 0;
      for (let i = open; i < src.length; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") { depth--; if (depth === 0) return i; } }
      return -1;
    };
    const ranges = (src: string) => [...src.matchAll(/\{canWrite && (?:[\w.?]+ && )?\(/g)].map((m) => {
      const open = m.index! + m[0].length - 1;
      return [open, matchParen(src, open)] as const;
    });
    const ungated = (src: string, re: RegExp) => {
      const rs = ranges(src);
      const all = [...src.matchAll(re)];
      return { total: all.length, ungated: all.filter((m) => !rs.some(([a, b]) => m.index! > a && m.index! < b)).length };
    };
    const ui = code("components/platform/growth/BetaRequestReview.tsx");
    for (const [label, re] of [
      ["Deny button", /data-deny(?!-)/g],
      ["Deny and block button", /data-deny-and-block/g],
      ["Block address button", /data-block-address/g],
      ["Clear block button", /data-clear-block/g],
      ["Block now button", /data-block-now/g],
      ["verdict buttons", /data-mark=/g],
      ["confirm dialogs", /<ConfirmDialog/g],
      ["reason fields", /<OperatorReasonField/g],
    ] as const) {
      const r = ungated(ui, re);
      check(`${label}: rendered only under canWrite (${r.total} site${r.total === 1 ? "" : "s"})`, r.total > 0 && r.ungated === 0, `${r.ungated} ungated`);
    }
    check("three verdict buttons", (ui.match(/data-mark=/g) ?? []).length === 3);
    check("READ holders get the explanatory line", /\{!canWrite && <p[^>]*data-read-only-line>\{REVIEW_READ_ONLY_LINE\}/.test(ui));
    check("every mutation goes through the model (runDeny / runDenyAndBlock / runVerdict); the component posts nothing itself",
      /runDeny\(requestId\)/.test(ui) && /runDenyAndBlock\(requestId, chosen, note\)/.test(ui) && /runVerdict\(requestId,/.test(ui) && !/method:\s*"POST"/.test(ui) && !/\/deny`/.test(ui));
    check("verdict confirms wait for a reason code", (ui.match(/confirmDisabled=\{chosen === null\}/g) ?? []).length === 3);
    check("the history is read from GET …/risk-review", /fetch\(riskReviewUrl\(requestId\)/.test(ui));
    check("the browser pages on the server (view / verdict / page in the query)", /betaRequestListSearch\(\{ view, verdict: suspicious \? "SUSPICIOUS" : null, page \}\)/.test(ui));
    const model = code("components/platform/growth/beta-request-review-model.ts");
    check("Deny and block: deny strictly before the SUSPICIOUS verdict, inside runDenyAndBlock",
      (() => { const f = model.slice(model.indexOf("export async function runDenyAndBlock")); const d = f.indexOf("post(denyUrl(id)"); const v = f.indexOf("post(riskReviewUrl(id), { status: \"SUSPICIOUS\""); return d > -1 && v > d; })());
    for (const [f, src] of [["BetaRequestReview.tsx", ui], ["beta-request-review-model.ts", model], ["beta-request-list-types.ts", code("lib/platform/growth/beta-request-list-types.ts")]] as const) {
      check(`${f}: no HMAC / key / token-hash field or import`, !/identifierHmac|hmacPrefix|keyVersion|inviteTokenHash|BETA_BLOCKLIST_HMAC_KEY|beta-blocklist(-core)?["']/.test(src));
    }
    const reader = code("lib/platform/growth/beta-blocklist.ts");
    const fn = reader.slice(reader.indexOf("export async function loadSourceRequestBlocks"), reader.indexOf("export async function intakeMailboxBlocked"));
    check("loadSourceRequestBlocks selects the link + two instants only (no HMAC, key version or id)",
      /select: \{ sourceRequestId: true, createdAt: true, expiresAt: true \}/.test(fn) && /status: "ACTIVE", expiresAt: \{ gt:/.test(fn) && !/identifierHmac|keyVersion/.test(fn), fn.slice(0, 400));
    const list = code("lib/platform/growth/beta-request-list.ts");
    check("the list reader runs on fm_system and never imports db", /systemDb/.test(list) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(list));
    const route = code("app/api/platform/growth-revenue/requests/route.ts");
    check("the status view answers only AFTER the READ gate", route.indexOf('requirePlatformAccess("GROWTH_REVENUE", "READ")') > -1
      && route.indexOf('requirePlatformAccess("GROWTH_REVENUE", "READ")') < route.indexOf("parseBetaRequestListQuery(params)")
      && route.indexOf("parseBetaRequestListQuery(params)") < route.indexOf("listBetaRequests(parsed.query)"));

    const widget = code("components/platform/widgets/GrowthBetaRequestsWidget.tsx");
    check("widget: the pending panel mounts the review section", /<BetaRequestReviewSection requestId=\{selectedRequest\.id\} canWrite=\{canWrite\} onChanged=\{load\} \/>/.test(widget));
    check("widget: the All requests tab mounts the status view", /tab === "all" \? \(\s*<BetaRequestBrowser canWrite=\{canWrite\} onChanged=\{load\} \/>/.test(widget) && /\["all", "All requests"/.test(widget));
    check("widget: no ad-hoc deny call is left (Deny lives in the review section)", !/"deny"/.test(widget) && !/\/deny\b/.test(widget));
    check("widget: Approve renders only while the request is still waiting", /\{canWrite && liveRequest && \(\s*<PanelFooter>/.test(widget));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll PB-6 review checks passed.");
})();
