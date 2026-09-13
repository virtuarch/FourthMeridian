/**
 * app/api/brief/brief-authority.test.ts
 *
 * THE DAILY BRIEF'S ROUTE BOUNDARY — pinned by source, because what it decides is
 * which authority is called and which never is.
 *
 * ⚠️ WHAT CHANGED, AND WHAT DID NOT. The Brief used to be a rule engine inside this
 * route (every Space, PERSONAL as primary, computeAssessment + fixed sections). It
 * is now the persisted, AI-generated DailyBrief; the assessment authority is read
 * inside the evidence package (lib/ai/brief/load.ts) and pinned there. What still
 * holds here, and is still tested: no route or view decides a financial verdict
 * from a ratio or recomputes a debt figure, reading never spends a model call, the
 * Space is the one the user is in, and the Brief never refreshes provider data.
 *
 * Behaviour is proven next door: view-model.test.ts (the contract), lifecycle.test.ts
 * (cooldown, inspection), brief-flow.test.ts (the page flow), and against Postgres
 * by `npm run ai:brief-route-check`.
 *
 *   npx tsx app/api/brief/brief-authority.test.ts
 */

import { existsSync, readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
/** The body of an exported function, from its declaration to the next top-level export. */
const body = (src: string, name: string) => {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};

const GET_ROUTE = code("app/api/brief/route.ts");
const POST_ROUTE = code("app/api/brief/generate/route.ts");
const VIEW = code("lib/ai/brief/view.ts");
const VIEW_MODEL = code("lib/ai/brief/view-model.ts");
const LIFECYCLE = code("lib/ai/brief/lifecycle.ts");
const CLIENT = code("components/brief/DailyBriefClient.tsx");
const FLOW = code("components/brief/brief-flow.ts");
const PAGE_PATH = "app/(shell)/dashboard/brief/page.tsx";
const PAGE = code(PAGE_PATH);

console.log("1. GET never spends a model call");
{
  const handler = GET_ROUTE.slice(GET_ROUTE.indexOf("export async function GET"));
  check("requireUser comes first and its error is returned", handler.indexOf("requireUser()") < handler.indexOf("readBriefResponse")
    && /if \(authErr\) return authErr/.test(handler));
  check("it reads through readBriefResponse only", /readBriefResponse\(user\.id, spaceId\)/.test(GET_ROUTE));
  check("it imports nothing that generates", !/generateBriefResponse|ensureDailyBrief|generateBriefFromPackage|lib\/ai\/provider|openai/.test(GET_ROUTE));
  const read = body(VIEW, "readBriefResponse");
  check("readBriefResponse inspects and never ensures", /inspectDailyBrief\(/.test(read) && !/ensureDailyBrief\(/.test(read));
  const inspect = body(LIFECYCLE, "inspectDailyBrief");
  check("inspectDailyBrief cannot claim, assemble or generate",
    inspect.length > 0 && !/\.claim\(|loadPackage\(|\.generate\(|materialDigest\(/.test(inspect));
  check("the spaceId is required", /spaceId is required/.test(GET_ROUTE) && /status: 400/.test(GET_ROUTE));
  check("responses are never cached", /force-dynamic/.test(GET_ROUTE) && /no-store/.test(GET_ROUTE));
}

console.log("\n2. POST is the only way generation starts");
{
  const handler = POST_ROUTE.slice(POST_ROUTE.indexOf("export async function POST"));
  check("requireUser first, the body read after", handler.indexOf("requireUser()") < handler.indexOf("req.json()"));
  check("rate-limited before any lifecycle work",
    handler.indexOf("limitByUser") > -1 && handler.indexOf("limitByUser") < handler.indexOf("generateBriefResponse"));
  check("it runs the lifecycle through generateBriefResponse", /generateBriefResponse\(user\.id, spaceId\)/.test(POST_ROUTE)
    && /ensureDailyBrief\(/.test(body(VIEW, "generateBriefResponse")));
  check("it outlives the generation lease", Number(/maxDuration = (\d+)/.exec(POST_ROUTE)?.[1] ?? 0) >= 90);
  check("the client only generates through POST /api/brief/generate",
    /"\/api\/brief\/generate"/.test(FLOW) && /method: "POST"/.test(FLOW));
}

console.log("\n3. the Space is the active one, re-resolved, never a fallback");
{
  check("both entries resolve the named Space for the session user and refuse a mismatch",
    /resolveSpaceContext\(userId, spaceId\)/.test(VIEW) && /ctx\.spaceId === spaceId \? ctx : null/.test(VIEW)
      && /status: 403/.test(VIEW));
  check("both routes answer a refused Space with 403", /status: 403/.test(GET_ROUTE) && /status: 403/.test(POST_ROUTE));
  check("the page lives in the dashboard shell and resolves the active Space",
    existsSync(PAGE_PATH) && /getSpaceContext\(\)/.test(PAGE) && /key=\{ctx\.spaceId\}/.test(PAGE));
  check("the old standalone route group is gone", !existsSync("app/(brief)"));
  check("nothing aggregates Spaces or prefers PERSONAL",
    ![GET_ROUTE, POST_ROUTE, VIEW, PAGE].some((s) => /spaceMember\.findMany|memberships|"PERSONAL"|'PERSONAL'/.test(s)));
  check("the client drops a response for another Space", /res\.spaceId !== spaceId/.test(FLOW));
}

console.log("\n4. no verdicts, no recomputed money, no provider refresh");
{
  const MONEY = String.raw`(?:\w+\.)?(?:total\w*|netWorth|cash|balance|liquid\w*|income\w*|expense\w*)`;
  const ratioVerdict = new RegExp(String.raw`${MONEY}\s*/\s*${MONEY}\s*[<>]=?\s*[\d.]`, "i");
  const surfaces = { GET_ROUTE, POST_ROUTE, VIEW, VIEW_MODEL, CLIENT, FLOW, PAGE };
  const offenders = Object.entries(surfaces).filter(([, s]) => s.split("\n").some((l) => ratioVerdict.test(l))).map(([k]) => k);
  check("no Brief surface derives a verdict from a ratio of totals", offenders.length === 0, offenders.join(", "));
  check("no Brief surface recomputes a debt figure",
    !Object.values(surfaces).some((s) => /computeDebtAggregate|resolveEffectiveDebtTerms|weightedApr|monthlyInterestBurden\s*[=*+/-]/.test(s)));
  check("no Brief surface refreshes provider data",
    ![GET_ROUTE, POST_ROUTE, VIEW, LIFECYCLE, CLIENT, FLOW, PAGE].some((s) =>
      /\/api\/plaid|refreshPlaidItem|transactionsSync|accountsGet|investmentsHoldingsGet|syncWallet/.test(s)));
  check("the metric day is a calendar day, as the contract promises (the summary stamps an instant)",
    /asOf: s\.asOf\.slice\(0, 10\)/.test(VIEW));
  check("the metric row is the response's deterministic figures, never the narration",
    /formatCurrency\(metrics\.netWorth, metrics\.currency\)/.test(CLIENT)
      && !/(headline|body|title)\s*\.\s*(match|replace|split)\(/.test(CLIENT));
}

console.log("\n5. the retired engine stays retired");
{
  check("the last-viewed endpoint and its call are gone",
    !existsSync("app/api/brief/viewed/route.ts") && !/\/api\/brief\/viewed/.test(CLIENT + FLOW));
  check("freshness never depends on when the user last looked",
    ![GET_ROUTE, POST_ROUTE, VIEW, VIEW_MODEL, LIFECYCLE].some((s) => /lastBriefViewedAt/.test(s)));
  check("no buildContext, assessment or rule sections in the route",
    !/buildContext|computeAssessment|since_last_visit|buildAttention|buildInsight/.test(GET_ROUTE + POST_ROUTE));
}

console.log("\n6. the page rechecks when the tab returns");
{
  check("visibilitychange asks the controller, only when visible",
    /addEventListener\("visibilitychange"/.test(CLIENT) && /visibilityState === "visible"/.test(CLIENT));
  check("pageshow from the back-forward cache asks too", /addEventListener\("pageshow"/.test(CLIENT) && /event\.persisted/.test(CLIENT));
  check("…and both listeners and the flow are torn down on unmount",
    /removeEventListener\("visibilitychange"/.test(CLIENT) && /removeEventListener\("pageshow"/.test(CLIENT) && /controller\.dispose\(\)/.test(CLIENT));
  check("a quiet Brief with no observations reads as calm, not empty",
    /observations\.length === 0/.test(CLIENT) && /Nothing major changed\./.test(CLIENT));
  check("loading is announced once, without invented stages",
    /role="status"/.test(CLIENT) && /Preparing your brief…/.test(CLIENT) && !/Analyzing|Looking for|Crunching/.test(CLIENT));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
