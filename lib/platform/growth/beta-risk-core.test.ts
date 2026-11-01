/**
 * lib/platform/growth/beta-risk-core.test.ts  (Beta-request risk — the pure half)
 *
 * Synthetic LEGITIMATE and SUSPICIOUS fixtures against the §4 classification of
 * docs/plans/BETA-REQUEST-RISK-ASSESSMENT-2026-10-31.md.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/beta-risk-core.test.ts
 */

import {
  ALIAS_CLUSTER_MIN, BETA_RISK_LEVEL_LABEL, BETA_RISK_REASON_CODES, BETA_RISK_REASON_LABEL, BURST_MIN_REQUESTERS,
  BURST_WINDOW_MINUTES, DUPLICATE_NOTE_MIN, DUPLICATE_NOTE_MIN_CHARS, HIGH_ANCHOR_SIGNALS, MODERATE_SIGNALS,
  REPEATED_SUBMISSION_MIN, SHARED_NETWORK_MIN_OTHERS, SHARED_NETWORK_WINDOW_MINUTES, WEAK_SIGNALS,
  assessBetaRisk, canonicalEmailKey, classify, emailDomain, noteFingerprint, tally, uaFamilyOf,
  type BetaRiskAuditFact, type BetaRiskFleetFacts, type BetaRiskRequestFacts, type UaFamily,
} from "./beta-risk-core";
import { DISPOSABLE_EMAIL_DOMAINS, isDisposableDomain } from "@/lib/marketing/disposable-domains";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const T0 = new Date("2026-10-30T12:00:00.000Z").getTime();
const at = (min: number) => new Date(T0 + min * 60_000);

// ── A tiny fleet builder that mirrors what the reader produces ───────────────

interface Spec {
  id: string;
  email: string;
  note?: string | null;
  /** Submission minutes (relative to T0). */
  times: number[];
  /** One forensic row per submission when given; omitted ⇒ no audit row (insufficient). */
  net?: string | null;
  ua?: UaFamily | null;
  sourcePresent?: boolean;
  noAudit?: boolean;
}

function build(specs: Spec[]): { requests: BetaRiskRequestFacts[]; fleet: BetaRiskFleetFacts } {
  const canonical = specs.map((s) => canonicalEmailKey(s.email));
  const notes = specs.map((s) => noteFingerprint(s.note ?? null));
  const requests: BetaRiskRequestFacts[] = specs.map((s, i) => {
    const audit: BetaRiskAuditFact[] = s.noAudit ? [] : s.times.map((m) => ({ at: at(m), networkDigest: s.net ?? `net-${s.id}`, uaFamily: s.ua === undefined ? "browser" : s.ua }));
    return {
      requestId: s.id,
      requesterKey: `k-${s.email}`,
      auditKey: `a-${s.email}`,
      emailCanonicalKey: canonical[i],
      domain: emailDomain(s.email),
      noteHash: notes[i],
      eventTimes: s.times.map(at),
      sourcePresent: s.sourcePresent ?? true,
      audit,
    };
  });
  return {
    requests,
    fleet: {
      submissions: requests.flatMap((r) => r.eventTimes.map((t) => ({ requesterKey: r.requesterKey, at: t }))),
      network: requests.flatMap((r) => r.audit.filter((a) => a.networkDigest).map((a) => ({ auditKey: r.auditKey, networkDigest: a.networkDigest!, at: a.at }))),
      aliasClusterSizes: tally(canonical),
      noteCounts: tally(notes),
      disposableDomains: DISPOSABLE_EMAIL_DOMAINS,
    },
  };
}
const assess = (specs: Spec[]) => assessBetaRisk(build(specs).requests, build(specs).fleet);
const codes = (r: { reasons: { code: string }[] } | undefined) => (r?.reasons ?? []).map((x) => x.code).sort();

// Background: legitimate requesters spread over days, each on its own network, browser, with a source.
const background: Spec[] = Array.from({ length: 6 }, (_, i) => ({
  id: `bg${i}`, email: `person${i}@example${i}.com`, times: [i * 600 - 6000], net: `home-${i}`,
}));

console.log("1. thresholds + vocabulary are named and pinned");
{
  check("burst = ≥ 5 distinct requesters in 10 minutes", BURST_MIN_REQUESTERS === 5 && BURST_WINDOW_MINUTES === 10);
  check("shared network = ≥ 3 OTHER requesters within 24 h", SHARED_NETWORK_MIN_OTHERS === 3 && SHARED_NETWORK_WINDOW_MINUTES === 1440);
  check("repeated = ≥ 3 submissions; alias / duplicate note = ≥ 2 requests; note ≥ 12 chars",
    REPEATED_SUBMISSION_MIN === 3 && ALIAS_CLUSTER_MIN === 2 && DUPLICATE_NOTE_MIN === 2 && DUPLICATE_NOTE_MIN_CHARS === 12);
  check("nine reason codes, each with a label", BETA_RISK_REASON_CODES.length === 9 && BETA_RISK_REASON_CODES.every((c) => BETA_RISK_REASON_LABEL[c]?.length > 0));
  check("every code is exactly one of moderate / weak", BETA_RISK_REASON_CODES.every((c) => MODERATE_SIGNALS.has(c) !== WEAK_SIGNALS.has(c)));
  check("moderate = burst, network, UA, alias, duplicate note",
    [...MODERATE_SIGNALS].sort().join() === ["ALIAS_CLUSTER", "AUTOMATION_UA", "BURST_WINDOW", "DUPLICATE_NOTE", "SHARED_NETWORK"].join());
  check("weak = repeated, disposable, no browser signals, unrecognised UA",
    [...WEAK_SIGNALS].sort().join() === ["DISPOSABLE_DOMAIN", "NO_BROWSER_SIGNALS", "REPEATED_SUBMISSION", "UNRECOGNISED_UA"].join());
  check("the high anchors are network / automation / burst", [...HIGH_ANCHOR_SIGNALS].sort().join() === "AUTOMATION_UA,BURST_WINDOW,SHARED_NETWORK");
  const words = [...Object.values(BETA_RISK_REASON_LABEL), ...Object.values(BETA_RISK_LEVEL_LABEL)].join(" ").toLowerCase();
  check("labels are neutral — never bot / fraud / malicious / spam", !/\b(bot|bots|fraud|fraudulent|malicious|spam|spammer|fake)\b/.test(words), words);
  check("level labels are the §4 wording", BETA_RISK_LEVEL_LABEL.review === "Review suggested" && BETA_RISK_LEVEL_LABEL.high === "High suspicion");
}

console.log("2. canonical e-mail, domain, note fingerprint, disposable list");
{
  check("lower-cases and strips +tag", canonicalEmailKey("  Jane.Doe+beta@Example.com ") === "jane.doe@example.com");
  check("gmail: dots removed", canonicalEmailKey("j.o.h.n.smith@gmail.com") === "johnsmith@gmail.com");
  check("googlemail folds to gmail.com, dots + tag removed", canonicalEmailKey("John.Smith+x@googlemail.com") === "johnsmith@gmail.com");
  check("non-gmail dots are significant", canonicalEmailKey("john.smith@outlook.com") !== canonicalEmailKey("johnsmith@outlook.com"));
  check("domain", emailDomain("A@Sub.Example.COM") === "sub.example.com");
  check("short / empty notes are not compared", noteFingerprint("hi") === null && noteFingerprint("   ") === null && noteFingerprint(null) === null);
  check("notes are normalised (case, whitespace)", noteFingerprint("I would love to try   this app") === noteFingerprint(" i would LOVE to try this app "));
  check("different notes differ", noteFingerprint("I would love to try this app") !== noteFingerprint("I would love to test this app"));
  check("disposable: listed domains + subdomains match, ordinary ones do not",
    isDisposableDomain("mailinator.com") && isDisposableDomain("x.yopmail.com") && !isDisposableDomain("gmail.com") && !isDisposableDomain("example.com"));
  check("the vendored list is a meaningful, lower-case set", DISPOSABLE_EMAIL_DOMAINS.size >= 100 && [...DISPOSABLE_EMAIL_DOMAINS].every((d) => d === d.toLowerCase() && d.includes(".")));
}

console.log("2b. user-agent families — in-app webviews are browsers, not automation");
{
  const IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.4.32.98 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 609146838)";
  const FB = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/459.0.0.48.106;FBBV/600000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.4.1;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]";
  const LI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.8126";
  check("Instagram iOS webview → browser", uaFamilyOf(IG) === "browser");
  check("Facebook iOS webview → browser", uaFamilyOf(FB) === "browser");
  check("LinkedIn iOS webview → browser", uaFamilyOf(LI) === "browser");
  check("desktop Safari / Chrome / Firefox → browser",
    uaFamilyOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15") === "browser"
    && uaFamilyOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0") === "browser");
  check("curl / python-requests → script", uaFamilyOf("curl/8.4.0") === "script" && uaFamilyOf("python-requests/2.31.0") === "script");
  check("HeadlessChrome → headless (headless outranks the Chrome token)",
    uaFamilyOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36") === "headless");
  check("empty / whitespace → empty", uaFamilyOf("") === "empty" && uaFamilyOf("   ") === "empty" && uaFamilyOf(null) === "empty");
  check("an unknown token → other", uaFamilyOf("SomeReader/1.0") === "other");
}

console.log("3. LEGITIMATE — a single browser submission with a campaign source");
{
  const r = assess([...background, { id: "L1", email: "alex@company.io", times: [0], net: "office", sourcePresent: true }]);
  check("level none, no reasons", r.get("L1")?.level === "none" && r.get("L1")!.reasons.length === 0, r.get("L1"));
  check("the background is clean too", background.every((b) => r.get(b.id)?.level === "none"));
}

console.log("4. LEGITIMATE — a dotted gmail address that is unique after folding");
{
  const r = assess([...background, { id: "L2", email: "jane.q.public@gmail.com", times: [5], net: "home-jane" }]);
  check("no ALIAS_CLUSTER for a unique mailbox", r.get("L2")?.level === "none" && !codes(r.get("L2")).includes("ALIAS_CLUSTER"), r.get("L2"));
}

console.log("5. SUSPICIOUS — 8 requesters in 5 minutes from one network with a script UA");
{
  const burst: Spec[] = Array.from({ length: 8 }, (_, i) => ({
    id: `S${i}`, email: `user${i}@mailbox${i}.net`, times: [i * 0.6], net: "dc-1", ua: "script" as UaFamily, sourcePresent: false,
  }));
  const r = assess([...background, ...burst]);
  const s0 = r.get("S0")!;
  check("every member is High suspicion", burst.every((b) => r.get(b.id)?.level === "high"), burst.map((b) => r.get(b.id)?.level));
  check("reasons: burst, shared network, non-browser client, no browser signals",
    codes(s0).join() === ["AUTOMATION_UA", "BURST_WINDOW", "NO_BROWSER_SIGNALS", "SHARED_NETWORK"].join(), codes(s0));
  const b = s0.reasons.find((x) => x.code === "BURST_WINDOW")!.evidence;
  check("burst evidence: 8 requesters, 10-minute window, first/last timestamps", b.count === 8 && b.windowMinutes === 10 && b.firstAt === at(0).toISOString() && b.lastAt === at(4.2).toISOString(), b);
  const n = s0.reasons.find((x) => x.code === "SHARED_NETWORK")!.evidence;
  check("network evidence: 7 OTHER requesters within 24 h", n.count === 7 && n.windowMinutes === 1440, n);
  check("the background is untouched by the burst", background.every((x) => r.get(x.id)?.level === "none"));
  const json = JSON.stringify([...r.values()]);
  check("the output carries no address, domain or digest", !/@|mailbox|dc-1|net-|k-|a-user/.test(json));
}

console.log("6. thresholds are boundaries, not approximations");
{
  const four: Spec[] = Array.from({ length: 4 }, (_, i) => ({ id: `F${i}`, email: `f${i}@f${i}.com`, times: [i], net: `n${i}` }));
  check("4 requesters in 10 minutes is not a burst", four.every((x) => !codes(assess([...background, ...four]).get(x.id)).includes("BURST_WINDOW")));
  const five: Spec[] = Array.from({ length: 5 }, (_, i) => ({ id: `V${i}`, email: `v${i}@v${i}.com`, times: [i * 2.5], net: `n${i}` }));
  const r5 = assess([...background, ...five]);
  check("5 requesters inside exactly 10 minutes is a burst", five.every((x) => codes(r5.get(x.id)).includes("BURST_WINDOW")));
  check("a burst alone (browsers, own networks, sources) is Review suggested, not high", five.every((x) => r5.get(x.id)?.level === "review"));
  const spread: Spec[] = Array.from({ length: 5 }, (_, i) => ({ id: `W${i}`, email: `w${i}@w${i}.com`, times: [i * 3], net: `n${i}` }));
  check("5 requesters over 12 minutes is not a burst", spread.every((x) => !codes(assess([...background, ...spread]).get(x.id)).includes("BURST_WINDOW")));
  const three: Spec[] = Array.from({ length: 3 }, (_, i) => ({ id: `N${i}`, email: `n${i}@n${i}.com`, times: [i * 200], net: "cafe" }));
  check("2 others on a network is not shared", three.every((x) => !codes(assess([...background, ...three]).get(x.id)).includes("SHARED_NETWORK")));
  const fourNet: Spec[] = Array.from({ length: 4 }, (_, i) => ({ id: `M${i}`, email: `m${i}@m${i}.com`, times: [i * 200], net: "cafe" }));
  const rn = assess([...background, ...fourNet]);
  check("3 others on a network within 24 h is shared", fourNet.every((x) => codes(rn.get(x.id)).includes("SHARED_NETWORK")));
  const days: Spec[] = Array.from({ length: 4 }, (_, i) => ({ id: `D${i}`, email: `d${i}@d${i}.com`, times: [i * 1500], net: "campus" }));
  check("the same network a day apart each time is not shared", days.every((x) => !codes(assess([...background, ...days]).get(x.id)).includes("SHARED_NETWORK")));
}

console.log("7. SUSPICIOUS — an alias cluster (plus-tags and gmail dots fold to one mailbox)");
{
  const alias: Spec[] = [
    { id: "A1", email: "sam.lee+one@gmail.com", times: [0], net: "h1" },
    { id: "A2", email: "samlee+two@gmail.com", times: [400], net: "h2" },
    { id: "A3", email: "s.a.m.l.e.e@googlemail.com", times: [900], net: "h3" },
  ];
  const r = assess([...background, ...alias]);
  check("each member carries ALIAS_CLUSTER with the cluster size", alias.every((a) => r.get(a.id)?.reasons.find((x) => x.code === "ALIAS_CLUSTER")?.evidence.count === 3));
  check("alias alone is one moderate ⇒ Review suggested", alias.every((a) => r.get(a.id)?.level === "review"));
}

console.log("8. SUSPICIOUS — duplicate notes");
{
  const note = "Excited to try Fourth Meridian for my finances!";
  const dup: Spec[] = [
    { id: "N1", email: "a@one.com", note, times: [0], net: "x1" },
    { id: "N2", email: "b@two.com", note: note.toUpperCase(), times: [3000], net: "x2" },
  ];
  const r = assess([...background, ...dup, { id: "N3", email: "c@three.com", note: "hi", times: [10], net: "x3" }, { id: "N4", email: "d@four.com", note: "hi", times: [20], net: "x4" }]);
  check("identical (normalised) notes ⇒ DUPLICATE_NOTE ⇒ review", dup.every((d) => codes(r.get(d.id)).includes("DUPLICATE_NOTE") && r.get(d.id)?.level === "review"));
  check("short generic notes are never compared", r.get("N3")?.level === "none" && r.get("N4")?.level === "none");
  const both = assess([...background,
    { id: "B1", email: "kim+a@gmail.com", note, times: [0], net: "y1" },
    { id: "B2", email: "k.im+b@gmail.com", note, times: [5000], net: "y2" }]);
  check("alias + duplicate note (two moderates, no network/automation anchor) ⇒ review, NOT high",
    both.get("B1")?.level === "review" && codes(both.get("B1")).join() === "ALIAS_CLUSTER,DUPLICATE_NOTE", both.get("B1"));
}

console.log("9. weak signals — disposable domain, repeats, no browser signals");
{
  const r = assess([...background, { id: "W1", email: "someone@mailinator.com", times: [0], net: "w1" }]);
  check("a disposable domain alone is ONE weak signal ⇒ not high (no notable level)",
    r.get("W1")?.level === "none" && codes(r.get("W1")).join() === "DISPOSABLE_DOMAIN", r.get("W1"));
  const r2 = assess([...background, { id: "W2", email: "someone@yopmail.com", times: [0, 30, 60], net: "w2" }]);
  check("disposable + repeated (two weak) ⇒ Review suggested, not high",
    r2.get("W2")?.level === "review" && codes(r2.get("W2")).join() === "DISPOSABLE_DOMAIN,REPEATED_SUBMISSION", r2.get("W2"));
  check("repeat evidence carries count and first/last", (() => { const e = r2.get("W2")!.reasons.find((x) => x.code === "REPEATED_SUBMISSION")!.evidence; return e.count === 3 && e.firstAt === at(0).toISOString() && e.lastAt === at(60).toISOString(); })());
  const r3 = assess([...background, { id: "W3", email: "p@q.com", times: [0], net: "w3", ua: "browser", sourcePresent: false }]);
  check("a browser with no referrer / campaign is NOT flagged (NO_BROWSER_SIGNALS needs a non-browser UA)", r3.get("W3")?.level === "none");
  const r4 = assess([...background, { id: "W4", email: "p@r.com", times: [0], net: "w4", ua: "headless", sourcePresent: true }]);
  check("a headless client alone is one moderate ⇒ review", r4.get("W4")?.level === "review" && codes(r4.get("W4")).join() === "AUTOMATION_UA");
  const r5 = assess([...background, { id: "W5", email: "p@s.com", times: [0], net: "w5", ua: "empty", sourcePresent: false }]);
  check("empty UA + no source ⇒ automation (moderate) + no browser signals (weak) ⇒ review", r5.get("W5")?.level === "review" && codes(r5.get("W5")).join() === "AUTOMATION_UA,NO_BROWSER_SIGNALS");
  const r6 = assess([...background, { id: "W6", email: "p@t.com", times: [0], net: "w6", ua: "other", sourcePresent: true }]);
  check("an UNRECOGNISED client alone is ONE weak signal (never AUTOMATION_UA) ⇒ none",
    r6.get("W6")?.level === "none" && codes(r6.get("W6")).join() === "UNRECOGNISED_UA", r6.get("W6"));
  const r7 = assess([...background, { id: "W7", email: "p@u.com", times: [0], net: "w7", ua: "other", sourcePresent: false }]);
  check("unrecognised client + no source (two weak) ⇒ review, not high",
    r7.get("W7")?.level === "review" && codes(r7.get("W7")).join() === "NO_BROWSER_SIGNALS,UNRECOGNISED_UA", r7.get("W7"));
  const iosBurst: Spec[] = Array.from({ length: 6 }, (_, i) => ({ id: `IG${i}`, email: `ig${i}@ig${i}.com`, times: [i], net: `cell-${i}`, ua: uaFamilyOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0"), sourcePresent: false }));
  const r8 = assess([...background, ...iosBurst]);
  check("a launch spike from Instagram webviews is a burst only ⇒ review, never high",
    iosBurst.every((x) => r8.get(x.id)?.level === "review" && codes(r8.get(x.id)).join() === "BURST_WINDOW"), iosBurst.map((x) => codes(r8.get(x.id))));
}

console.log("10. insufficient evidence — no forensic audit row");
{
  const r = assess([...background, { id: "I1", email: "old@legacy.com", times: [0], noAudit: true }]);
  check("no audit row and nothing else fires ⇒ insufficient", r.get("I1")?.level === "insufficient" && r.get("I1")!.reasons.length === 0, r.get("I1"));
  const r2 = assess([...background, { id: "I2", email: "old@mailinator.com", times: [0], noAudit: true }]);
  check("no audit row + one weak signal ⇒ still insufficient (reason listed)", r2.get("I2")?.level === "insufficient" && codes(r2.get("I2")).join() === "DISPOSABLE_DOMAIN");
  const r3 = assess([...background, { id: "I3", email: "kim+a@gmail.com", times: [0], noAudit: true }, { id: "I4", email: "k.im@gmail.com", times: [9000], net: "z" }]);
  check("no audit row but a moderate signal ⇒ review (evidence outranks absence)", r3.get("I3")?.level === "review");
  check("no audit row ⇒ NO_BROWSER_SIGNALS never fires (UA unknown ≠ non-browser)", !codes(assess([{ id: "I5", email: "x@y.com", times: [0], noAudit: true, sourcePresent: false }]).get("I5")).includes("NO_BROWSER_SIGNALS"));
  const r6 = assess([...background, { id: "I6", email: "e@f.com", times: [0], net: null, ua: null }]);
  check("an audit row with no IP and no UA family is evaluated, not insufficient", r6.get("I6")?.level === "none");
}

console.log("11. classify() — the §4 table directly");
{
  const c = (...codes: (typeof BETA_RISK_REASON_CODES)[number][]) => classify(codes.map((code) => ({ code })), true);
  check("burst + network ⇒ high", c("BURST_WINDOW", "SHARED_NETWORK") === "high");
  check("automation + duplicate note ⇒ high", c("AUTOMATION_UA", "DUPLICATE_NOTE") === "high");
  check("alias + duplicate note ⇒ review", c("ALIAS_CLUSTER", "DUPLICATE_NOTE") === "review");
  check("one moderate ⇒ review", c("SHARED_NETWORK") === "review");
  check("two weak ⇒ review", c("REPEATED_SUBMISSION", "NO_BROWSER_SIGNALS") === "review");
  check("one weak ⇒ none", c("DISPOSABLE_DOMAIN") === "none");
  check("nothing ⇒ none; nothing without audit ⇒ insufficient", c() === "none" && classify([], false) === "insufficient");
  check("three weak, no moderate ⇒ review, never high", c("REPEATED_SUBMISSION", "NO_BROWSER_SIGNALS", "DISPOSABLE_DOMAIN") === "review");
}

console.log("12. determinism");
{
  const specs = [...background, { id: "Z", email: "z@z.com", times: [0, 1, 2], net: "z", ua: "script" as UaFamily }];
  check("same facts ⇒ same output", JSON.stringify([...assess(specs)]) === JSON.stringify([...assess(specs)]));
  check("an unknown fleet (empty) still assesses", assessBetaRisk(build(specs).requests, { submissions: [], network: [], aliasClusterSizes: new Map(), noteCounts: new Map() }).size === specs.length);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
