// Trusted deployment health (A4b) — run by .github/workflows/trusted-deployment-health.yml
// on a PUSH to v2.6 or main, inside the `vercel-probe` GitHub Environment,
// which is the only place the two Vercel automation-bypass secrets exist.
//
// Why a push and not deployment_status: Vercel creates each GitHub Deployment
// with `ref` = the commit SHA, so which branch a deployment_status run belongs
// to is GitHub's inference, not something this repository controls. (In the
// 2026-10-22 denial test GitHub resolved such a run to its feature branch and
// refused it — doc 17 §3 — but the trusted path does not depend on that.) On a
// push, github.ref IS the branch, and the environment's deployment-branch
// policy (v2.6, main) decides: a feature branch, a PR, a dispatch from another
// ref, or a deployment_status run of a feature branch cannot obtain the secrets.
//
// What it does: waits for every Vercel deployment GitHub records for this
// commit to reach a terminal status, then probes each successful one with its
// own project's secret (bypassFor) and classifies it (classifyProbe):
//   HEALTHY → ok · UNHEALTHY / UNVERIFIED / failed deployment → exit 1 ·
//   inactive/cancelled (e.g. the site's Ignored Build Step) → SKIPPED, ok ·
//   no deployment at all within the wait → exit 1 (nothing was verified).
// Plain Node, no dependencies; talks to the GitHub REST API with GITHUB_TOKEN.

import { bypassFor, probeDeployment, targetFor, VERDICT } from "./post-deploy-smoke.mjs";

/**
 * Targets every v2.6 / main commit MUST have a Vercel deployment for. The app
 * (fintracker1) builds on every commit; the site may be cancelled by its
 * Ignored Build Step, which still records a deployment, but it is not required.
 * 2026-10-22, first real run (0773008): the site's deployment was recorded
 * ~20 s after the push and the app's minutes later, so "something seen,
 * nothing pending" ended the wait with only the site probed — a false green
 * for the app. The wait now ends only once every required target is seen.
 */
export const REQUIRED_TARGETS = Object.freeze(["app"]);

/** Pure: required targets with no Vercel deployment among `deployments`. */
export function missingRequiredTargets(deployments, required = REQUIRED_TARGETS) {
  const seen = new Set(deployments.filter((d) => d.creator === "vercel[bot]").map((d) => targetFor(d.environment).kind));
  return required.filter((t) => !seen.has(t));
}

const TERMINAL_OK = new Set(["success"]);
const TERMINAL_BAD = new Set(["failure", "error"]);
const TERMINAL_SKIP = new Set(["inactive"]);

/**
 * Pure: from GitHub deployments (each with its newest status) decide what to
 * probe. Only Vercel-created deployments count.
 * @typedef {{ id: number, environment: string, creator?: string, latestStatus: { state: string, description: string, url: string } | null }} Deployment
 * @param {Deployment[]} deployments
 * @returns {{ pending: Deployment[], probe: Deployment[], failed: Deployment[], skipped: Deployment[] }}
 */
export function planFromDeployments(deployments) {
  const out = { pending: [], probe: [], failed: [], skipped: [] };
  for (const d of deployments) {
    if (d.creator !== "vercel[bot]") continue;
    const state = d.latestStatus?.state ?? "pending";
    const desc = d.latestStatus?.description ?? "";
    if (TERMINAL_OK.has(state)) out.probe.push(d);
    else if (TERMINAL_BAD.has(state) && /cancel|ignored build step/i.test(desc)) out.skipped.push(d);
    else if (TERMINAL_BAD.has(state)) out.failed.push(d);
    else if (TERMINAL_SKIP.has(state)) out.skipped.push(d);
    else out.pending.push(d);
  }
  return out;
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} → HTTP ${res.status}`);
  return res.json();
}

async function readDeployments(repo, sha, token) {
  const list = await gh(`/repos/${repo}/deployments?sha=${sha}&per_page=50`, token);
  return Promise.all(list.map(async (d) => {
    const statuses = await gh(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`, token);
    const s = statuses[0];
    return {
      id: d.id, environment: d.environment, creator: d.creator?.login,
      latestStatus: s ? { state: s.state, description: s.description ?? "", url: s.environment_url || s.target_url || "" } : null,
    };
  }));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY, sha = process.env.GITHUB_SHA, token = process.env.GITHUB_TOKEN;
  const waitMs = Number(process.env.WAIT_SECONDS ?? 900) * 1000;
  if (!repo || !sha || !token) { console.log("::error::GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN are required"); return 1; }
  console.log(`commit ${sha} on ${process.env.GITHUB_REF ?? "?"}; waiting up to ${waitMs / 1000}s for its Vercel deployments`);

  const deadline = Date.now() + waitMs;
  let plan, missing = [];
  for (;;) {
    const deployments = await readDeployments(repo, sha, token);
    plan = planFromDeployments(deployments);
    missing = missingRequiredTargets(deployments);
    const seen = plan.probe.length + plan.failed.length + plan.skipped.length + plan.pending.length;
    if (seen > 0 && plan.pending.length === 0 && missing.length === 0) break;
    if (Date.now() > deadline) break;
    console.log(`  ${seen} deployment(s) seen, ${plan.pending.length} still pending${missing.length ? `, no ${missing.join("/")} deployment yet` : ""} — re-reading in 20 s`);
    await new Promise((r) => setTimeout(r, 20_000));
  }

  let bad = 0;
  const lines = [];
  if (plan.probe.length + plan.failed.length + plan.skipped.length === 0) {
    console.log(`::error::no Vercel deployment reached a terminal state for ${sha} — nothing was verified`);
    return 1;
  }
  for (const t of missing) { bad++; lines.push(`- ${t}: no Vercel deployment recorded for this commit by the deadline — NOT verified`); }
  for (const d of plan.pending) { bad++; lines.push(`- ${d.environment}: still pending at the deadline — NOT verified`); }
  for (const d of plan.failed) { bad++; lines.push(`- ${d.environment}: deployment ${d.latestStatus.state} (${d.latestStatus.description})`); }
  for (const d of plan.skipped) lines.push(`- ${d.environment}: SKIPPED — ${d.latestStatus?.state} (${d.latestStatus?.description})`);
  for (const d of plan.probe) {
    const r = await probeDeployment({ base: d.latestStatus.url, environment: d.environment, deployedSha: sha, bypass: bypassFor(d.environment, process.env) });
    if (r.verdict !== VERDICT.HEALTHY) bad++;
    lines.push(`- ${d.environment}: **${r.verdict}** — ${r.reason} (${r.url})`);
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Trusted deployment health — ${sha}`, "", ...lines, ""].join("\n"));
  }
  if (bad) console.log(`::error::${bad} deployment(s) not verified healthy`);
  return bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => { console.log(`::error::${err.message}`); process.exit(1); });
}
