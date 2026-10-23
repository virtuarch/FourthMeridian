/**
 * scripts/trusted-deployment-health.test.ts
 *
 * Pins planFromDeployments (scripts/trusted-deployment-health.mjs): which of a
 * commit's GitHub Deployments the trusted check probes, fails, skips or waits
 * for. Shapes mirror what Vercel records (creator vercel[bot]; the site's
 * Ignored Build Step reports a cancelled status).
 *
 * Hermetic. Run: npx tsx scripts/trusted-deployment-health.test.ts
 */

import { missingRequiredTargets, planFromDeployments } from "./trusted-deployment-health.mjs";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const dep = (environment: string, state: string | null, description = "", creator = "vercel[bot]") =>
  ({ id: 1, environment, creator, latestStatus: state ? { state, description, url: "https://x.vercel.app" } : null });

console.log("classification of a commit's deployments");
{
  const p = planFromDeployments([
    dep("Preview – fintracker1", "success"),
    dep("Preview – fourth-meridian-site", "failure", "Canceled by Ignored Build Step"),
  ]);
  check("success ⇒ probed", p.probe.length === 1 && p.probe[0].environment === "Preview – fintracker1");
  check("Ignored Build Step cancel ⇒ skipped, not failed", p.skipped.length === 1 && p.failed.length === 0);
  check("a real build failure ⇒ failed", planFromDeployments([dep("Production – fintracker1", "failure", "Build failed")]).failed.length === 1);
  check("error ⇒ failed", planFromDeployments([dep("Production – fintracker1", "error", "")]).failed.length === 1);
  check("no status yet ⇒ pending", planFromDeployments([dep("Preview – fintracker1", null)]).pending.length === 1);
  check("in_progress / queued ⇒ pending", planFromDeployments([dep("a", "in_progress"), dep("b", "queued")]).pending.length === 2);
  check("inactive (superseded) ⇒ skipped", planFromDeployments([dep("a", "inactive")]).skipped.length === 1);
  check("deployments not created by Vercel are ignored", Object.values(planFromDeployments([dep("x", "success", "", "someone")])).every((l) => l.length === 0));
}

console.log("required targets (the 0773008 false green)");
{
  const siteOnly = [dep("Preview – fourth-meridian-site", "success")];
  check("site seen, app not yet ⇒ app missing (keep waiting / fail at deadline)", missingRequiredTargets(siteOnly).join() === "app");
  check("app seen ⇒ nothing missing", missingRequiredTargets([...siteOnly, dep("Preview – fintracker1", null)]).length === 0);
  check("a non-Vercel deployment of the app's name does not count", missingRequiredTargets([dep("Preview – fintracker1", "success", "", "github-actions[bot]")]).join() === "app");
  check("GitHub's own vercel-probe environment deployment is not a Vercel deployment", planFromDeployments([dep("vercel-probe", "success", "", "github-actions[bot]")]).probe.length === 0);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
