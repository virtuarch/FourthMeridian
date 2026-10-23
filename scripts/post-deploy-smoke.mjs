// Post-deploy smoke (TEST-006) — the probe and its verdict, run by
// .github/workflows/post-deploy-smoke.yml on every successful Vercel
// deployment. Plain Node (no dependencies, no install): the workflow checks
// out this one file and runs it.
//
// The verdict is the point. The first version mapped any 30x/401 to "exit 0"
// on the theory that it was Vercel's SSO wall, so the check went GREEN on PR #1
// while never reaching the application (three 401s, Preview – fintracker1). A
// check that cannot see the app has not verified it:
//
//   HEALTHY      the app answered and every assertion held          → exit 0
//   UNHEALTHY    the app (or something in front of it) answered wrongly → exit 1
//   UNVERIFIED   Vercel Deployment Protection answered instead of the app
//                (SSO redirect / 401 carrying Vercel's markers)        → exit 1
//
// UNVERIFIED fails on purpose: the run must not read as a pass. Supplying
// VERCEL_AUTOMATION_BYPASS_SECRET_APP / _SITE (each Vercel project's own
// "Protection Bypass for Automation" secret — they differ; an owner action)
// lets the probe through the wall on Preview; Production is
// public, so UNVERIFIED there means protection was turned on in front of users.
// A bare 401/30x WITHOUT Vercel's markers is UNHEALTHY, not UNVERIFIED.
//
// Two targets. The app (fintracker1) serves /api/health → {status, db, commit}.
// The public site (fourth-meridian-site, site/) has no API by design (the
// zero-authority boundary), so it is probed at "/" for a 200 HTML page and has
// no commit identity to compare.

export const VERDICT = Object.freeze({ HEALTHY: "HEALTHY", UNHEALTHY: "UNHEALTHY", UNVERIFIED: "UNVERIFIED" });

/** Which project a deployment belongs to, from GitHub's environment name. */
export function targetFor(environment) {
  return /fourth-meridian-site/i.test(environment ?? "")
    ? { kind: "site", path: "/" }
    : { kind: "app", path: "/api/health" };
}

/** True when the response came from Vercel Deployment Protection, not the app. */
export function isVercelProtection({ status, headers = {}, body = "" }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const location = h["location"] ?? "";
  const cookie = h["set-cookie"] ?? "";
  if ([301, 302, 303, 307, 308].includes(status)) {
    return /^https:\/\/vercel\.com\/sso-api(\?|$)/.test(location);
  }
  if (status === 401 || status === 403) {
    return /_vercel_sso_nonce=/.test(cookie) || /Vercel Authentication/i.test(body) || /^https:\/\/vercel\.com\/sso-api/.test(location);
  }
  return false;
}

/**
 * Pure classification of one probe response. Never throws.
 * @returns {{ verdict: string, reason: string, status?: string, db?: string, commit?: string|null }}
 */
export function classifyProbe({ kind, status, headers = {}, body = "", deployedSha = "", url = "" }) {
  if (isVercelProtection({ status, headers, body })) {
    return { verdict: VERDICT.UNVERIFIED, reason: `Vercel Deployment Protection answered (HTTP ${status}); the application was not reached` };
  }
  if (status !== 200) {
    return { verdict: VERDICT.UNHEALTHY, reason: status === 0 ? `no HTTP response (${String(body).slice(0, 120)})` : `HTTP ${status}` };
  }
  if (kind === "site") {
    const ct = String(Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "");
    return /text\/html/i.test(ct)
      ? { verdict: VERDICT.HEALTHY, reason: "site answered 200 text/html" }
      : { verdict: VERDICT.UNHEALTHY, reason: `site answered 200 with content-type '${ct}'` };
  }
  let json;
  try { json = JSON.parse(body); } catch { return { verdict: VERDICT.UNHEALTHY, reason: "HTTP 200 but the body is not JSON — not the health route" }; }
  if (json === null || typeof json !== "object") return { verdict: VERDICT.UNHEALTHY, reason: "HTTP 200 but the body is not a JSON object" };
  const out = { status: json.status, db: json.db, commit: json.commit ?? null };
  if (json.status !== "ok") return { ...out, verdict: VERDICT.UNHEALTHY, reason: `health status '${json.status}' (db=${json.db}), expected ok` };
  if (typeof json.commit === "string" && json.commit.length > 0) {
    if (!deployedSha.startsWith(json.commit)) {
      return { ...out, verdict: VERDICT.UNHEALTHY, reason: `health reports commit ${json.commit}, not a prefix of the deployed SHA ${deployedSha}` };
    }
    return { ...out, verdict: VERDICT.HEALTHY, reason: `status ok, commit ${json.commit} ⊂ ${deployedSha}` };
  }
  // Since OPS-014 / OBS-010 (bf2da56) /api/health deliberately publishes no
  // commit. On a per-deployment *.vercel.app URL — what Vercel puts in
  // deployment_status.environment_url — identity holds by construction: that
  // URL serves exactly one immutable build, the one GitHub recorded. On an
  // alias (a custom domain) it does not, and the reason says so.
  const immutable = (() => { try { return new URL(url).hostname.endsWith(".vercel.app"); } catch { return false; } })();
  return {
    ...out, verdict: VERDICT.HEALTHY,
    reason: immutable
      ? "status ok; commit not published (OPS-014) — identity holds by the immutable per-deployment URL"
      : "status ok; commit not published (OPS-014) and this is an alias host — build identity NOT verified",
  };
}

/** The bypass secret for this deployment's project, or "" when none is configured. */
export function bypassFor(environment, env) {
  const name = targetFor(environment).kind === "site"
    ? "VERCEL_AUTOMATION_BYPASS_SECRET_SITE"
    : "VERCEL_AUTOMATION_BYPASS_SECRET_APP";
  return (env?.[name] ?? "").trim();
}

/** Only these hosts may receive the bypass secret. */
export function mayCarryBypass(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (/\.vercel\.app$/.test(hostname) || hostname === "fourthmeridian.com" || hostname.endsWith(".fourthmeridian.com"));
  } catch { return false; }
}

async function probeOnce(url, bypass) {
  const headers = { Accept: "application/json, text/html" };
  if (bypass && mayCarryBypass(url)) headers["x-vercel-protection-bypass"] = bypass;
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  } catch (err) {
    return { status: 0, headers: {}, body: String(err?.message ?? err) };
  }
}

/**
 * Probe one deployment and classify it. `bypass` is the project's secret or "".
 * Three attempts, 10 s apart: a just-aliased deployment can take a moment to
 * serve its first cold request. Only an UNHEALTHY answer is retried.
 */
export async function probeDeployment({ base, environment, deployedSha, bypass, log = console.log }) {
  const target = targetFor(environment);
  const url = `${base.replace(/\/$/, "")}${target.path}`;
  log(`environment: ${environment}\ntarget: ${target.kind}\ndeployed sha: ${deployedSha}\nprobe: ${url}\nbypass header: ${bypass ? "sent" : "not configured"}`);
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await probeOnce(url, bypass);
    result = classifyProbe({ kind: target.kind, ...res, deployedSha, url });
    log(`attempt ${attempt}: HTTP ${res.status} → ${result.verdict} (${result.reason})`);
    if (result.verdict !== VERDICT.UNHEALTHY) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 10_000));
  }
  return { ...result, url, environment };
}

async function main() {
  const base = (process.env.DEPLOYMENT_URL ?? "").replace(/\/$/, "");
  const environment = process.env.ENVIRONMENT ?? "";
  const deployedSha = process.env.DEPLOYED_SHA ?? "";
  // This entry point is the deployment_status workflow, which holds NO secret:
  // it runs the workflow file from the deployed commit (any branch can edit it)
  // and its ref is a SHA (Vercel). Protected Previews are therefore UNVERIFIED
  // here, by design;
  // scripts/trusted-deployment-health.mjs verifies v2.6/main with the
  // vercel-probe environment's per-project secrets. bypassFor() still honours
  // the variables when a caller supplies them (local verification).
  const bypass = bypassFor(environment, process.env);
  if (!base) { console.log("::error::deployment_status carried no environment_url/target_url — nothing to probe"); return 1; }
  const result = await probeDeployment({ base, environment, deployedSha, bypass });
  const url = result.url;

  const summary = [`### Post-deploy smoke — ${environment}`, "", `- url: ${url}`, `- verdict: **${result.verdict}** — ${result.reason}`];
  if (result.status !== undefined) summary.push(`- status: ${result.status}, db: ${result.db}, commit: ${result.commit ?? "n/a"} (deployed ${deployedSha})`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
  }
  if (result.verdict === VERDICT.HEALTHY) return 0;
  const prefix = result.verdict === VERDICT.UNVERIFIED ? "health NOT verified" : "deployment unhealthy";
  console.log(`::error::${environment}: ${prefix} — ${result.reason}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
