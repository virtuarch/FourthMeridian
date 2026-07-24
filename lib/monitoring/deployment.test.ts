/**
 * lib/monitoring/deployment.test.ts  (OPS-2B′ — Deployment Identity Authority)
 *
 * Guards for the canonical deployment resolver and its stamping at the two
 * operational write boundaries. Standalone tsx (house pattern).
 *
 * This file mutates `process.env`, which is exactly why the runner gives every
 * test file its own process (scripts/run-tests.ts).
 *
 * What this pins:
 *   • ONE AUTHORITY — the resolver is the only place deployment identity is read
 *     for operational purposes, and Sentry's `release` comes from it.
 *   • STAMPED EXACTLY ONCE — at the start write, by both writers.
 *   • IMMUTABLE — the completion write cannot carry it (compiler-enforced, and
 *     verified structurally here).
 *   • NULL IS A REAL ANSWER — never fabricated, never backfilled.
 *   • NOT ON PROJECTIONS — only immutable authorities receive it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
process.on("unhandledRejection", (err) => {
  console.error("  ✗ unexpected:", err);
  process.exit(1);
});

const ROOT = process.cwd();
const strip = (p: string) =>
  readFileSync(path.join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Re-import the resolver after an env change (module-level consts are cached). */
async function freshResolver() {
  const mod = await import(`@/lib/monitoring/deployment?bust=${Math.random()}`);
  return mod.currentDeploymentSha as () => string | null;
}

async function main() {
  const originalPublic = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
  const originalBare = process.env.VERCEL_GIT_COMMIT_SHA;

  // ── resolution ─────────────────────────────────────────────────────────────────
  console.log("resolver · deployment identity");
  {
    const { currentDeploymentSha } = await import("@/lib/monitoring/deployment");

    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    check("no env ⇒ null (never a fabricated 'unknown'/'local'/HEAD)", currentDeploymentSha() === null);

    process.env.VERCEL_GIT_COMMIT_SHA = "abc123def456";
    check("bare VERCEL_GIT_COMMIT_SHA resolves", currentDeploymentSha() === "abc123def456");

    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA = "public999";
    check("NEXT_PUBLIC_ variant wins (identical client + server value)", currentDeploymentSha() === "public999");

    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = "   ";
    check("whitespace-only is ABSENCE, not identity", currentDeploymentSha() === null);

    process.env.VERCEL_GIT_COMMIT_SHA = "";
    check("empty string is ABSENCE, not identity", currentDeploymentSha() === null);

    process.env.VERCEL_GIT_COMMIT_SHA = "  padded123  ";
    check("a padded value is trimmed, not stamped with whitespace", currentDeploymentSha() === "padded123");

    // Restore for the remaining sections.
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    check("resolution is pure — same env, same answer", currentDeploymentSha() === currentDeploymentSha());
  }

  // ── one authority ──────────────────────────────────────────────────────────────
  console.log("authority · exactly one resolver");
  {
    const sentry = strip("lib/monitoring/sentry-options.ts");
    check("Sentry's release comes from the canonical resolver", /currentDeploymentSha\(\)/.test(sentry));
    check(
      "Sentry no longer reads the commit-sha env directly (no drift between release and stamp)",
      !/VERCEL_GIT_COMMIT_SHA/.test(sentry),
    );

    const resolver = strip("lib/monitoring/deployment.ts");
    check("the resolver is client-safe (no server-only)", !/server-only/.test(resolver));
    check("the resolver reads no database", !/@\/lib\/db/.test(resolver));
    check("the resolver performs no I/O", !/fetch\(|readFileSync|child_process/.test(resolver));

    // Every operational stamp must route through the resolver, never a raw env read.
    for (const writer of ["lib/jobs/run.ts", "lib/plaid/refresh-execution.ts"]) {
      const code = strip(writer);
      check(`${writer} stamps via the resolver`, /currentDeploymentSha\(\)/.test(code));
      check(`${writer} does NOT read the env directly`, !/VERCEL_GIT_COMMIT_SHA/.test(code));
    }
  }

  // ── stamped exactly once, at the START write ───────────────────────────────────
  console.log("writers · stamped once, at the start write");
  {
    for (const writer of ["lib/jobs/run.ts", "lib/plaid/refresh-execution.ts"]) {
      const code = strip(writer);
      const stampCount = (code.match(/deploymentSha:\s*currentDeploymentSha\(\)/g) ?? []).length;
      check(`${writer} stamps exactly once`, stampCount === 1, `found ${stampCount}`);
    }

    // IMMUTABILITY, STRUCTURALLY: the completion data types must not carry the
    // field, so the completion write cannot possibly alter it.
    const runSrc = strip("lib/jobs/run.ts");
    const refreshSrc = strip("lib/plaid/refresh-execution.ts");

    const jobCompletion = runSrc.slice(runSrc.indexOf("interface JobRunCompletionData"));
    check(
      "JobRunCompletionData carries NO deploymentSha (completion cannot rewrite it)",
      !jobCompletion.slice(0, jobCompletion.indexOf("}")).includes("deploymentSha"),
    );

    const refreshCompletion = refreshSrc.slice(refreshSrc.indexOf("interface RefreshExecutionCompletionData"));
    check(
      "RefreshExecutionCompletionData carries NO deploymentSha",
      !refreshCompletion.slice(0, refreshCompletion.indexOf("}")).includes("deploymentSha"),
    );

    check("JobRunStartData declares deploymentSha", /interface JobRunStartData[\s\S]*?deploymentSha/.test(runSrc));
    check(
      "RefreshExecutionStartData declares deploymentSha",
      /interface RefreshExecutionStartData[\s\S]*?deploymentSha/.test(refreshSrc),
    );

    // No update/upsert anywhere may set it.
    for (const [name, code] of [["run.ts", runSrc], ["refresh-execution.ts", refreshSrc]] as const) {
      check(
        `${name}: no update() sets deploymentSha`,
        !/update\(\{[\s\S]{0,400}?deploymentSha/.test(code),
      );
    }
  }

  // ── the writers actually stamp (behavioural, via the injected client) ──────────
  console.log("writers · behavioural stamp");
  {
    process.env.VERCEL_GIT_COMMIT_SHA = "deploy-sha-1";
    const { runJob } = await import("@/lib/jobs/run");

    const startWrites: Record<string, unknown>[] = [];
    const completionWrites: Record<string, unknown>[] = [];
    const fakeClient = {
      jobRun: {
        async create(args: { data: Record<string, unknown> }) {
          startWrites.push(args.data);
          return { id: "row1" };
        },
        async update(args: { data: Record<string, unknown> }) {
          completionWrites.push(args.data);
          return {};
        },
      },
    };

    await runJob("test-job", async () => ({ ok: 1 }), { trigger: "cron", client: fakeClient as never });

    check("the start write carries the deployment sha", startWrites[0]?.deploymentSha === "deploy-sha-1");
    check("exactly ONE start write happened", startWrites.length === 1);
    check("exactly ONE completion write happened", completionWrites.length === 1);
    check(
      "the completion write does NOT carry deploymentSha (immutable)",
      !Object.prototype.hasOwnProperty.call(completionWrites[0] ?? {}, "deploymentSha"),
    );

    // Deployment unavailable ⇒ null persisted, never omitted, never fabricated.
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const nullRun = await freshResolver();
    check("resolver returns null when the deployment is unobservable", nullRun() === null);

    const startWrites2: Record<string, unknown>[] = [];
    const fakeClient2 = {
      jobRun: {
        async create(args: { data: Record<string, unknown> }) {
          startWrites2.push(args.data);
          return { id: "row2" };
        },
        async update() {
          return {};
        },
      },
    };
    await runJob("test-job-2", async () => undefined, { trigger: "cron", client: fakeClient2 as never });
    check("the field is PRESENT and null when unobservable (not omitted)",
      Object.prototype.hasOwnProperty.call(startWrites2[0] ?? {}, "deploymentSha") && startWrites2[0].deploymentSha === null);
  }

  // ── only immutable authorities are stamped ─────────────────────────────────────
  console.log("scope · only immutable authorities carry deployment identity");
  {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const stamped = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s*deploymentSha\s/m.test(body))
      .map(([, name]) => name)
      .sort();
    check(
      "exactly JobRun + RefreshExecution carry deploymentSha",
      stamped.join(",") === "JobRun,RefreshExecution",
      `stamped: ${stamped.join(",") || "(none)"}`,
    );
    check("both columns are NULLABLE", (schema.match(/deploymentSha\s+String\?/g) ?? []).length === 2);

    // Children inherit deployment identity by JOIN — stamping them would be
    // denormalized duplication of a fact their parent already owns.
    for (const child of ["RefreshEndpointResult", "ProviderCall", "RefreshEndpointAccountCoverage"]) {
      const body = schema.match(new RegExp(`^model\\s+${child}\\s*\\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";
      check(`${child} is NOT stamped (inherits via its execution FK)`, !/deploymentSha/.test(body));
    }

    // PROJECTIONS AND READ MODELS ARE NEVER STAMPED.
    for (const p of [
      "lib/platform/refresh/projections.ts",
      "lib/platform/refresh/projections-core.ts",
      "lib/platform/refresh/types.ts",
      "lib/platform/refresh/execution-query.ts",
      "lib/platform/refresh/execution-query-core.ts",
    ]) {
      check(`${p} receives no deployment identity`, !/deploymentSha|currentDeploymentSha/.test(strip(p)));
    }
  }

  // ── projection readiness (Part VI) — answerable, not implemented ───────────────
  console.log("readiness · the correlation questions are answerable");
  {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const refreshBody = schema.match(/^model\s+RefreshExecution\s*\{([\s\S]*?)^\}/m)?.[1] ?? "";
    const jobBody = schema.match(/^model\s+JobRun\s*\{([\s\S]*?)^\}/m)?.[1] ?? "";

    // "Which refreshes belong to deployment Y?" / "Did failures begin after X?"
    check(
      "RefreshExecution is indexed by (deploymentSha, startedAt) — deployment + time",
      /@@index\(\[deploymentSha,\s*startedAt\]\)/.test(refreshBody),
    );
    check("JobRun is indexed by deploymentSha", /@@index\(\[deploymentSha\]\)/.test(jobBody));

    // "Was customer impact correlated with deployment Z?" — the join path must exist:
    // deploymentSha → RefreshExecution → plaidItemId (soft ref to the connection).
    check(
      "RefreshExecution retains plaidItemId, so deployment → connection is joinable",
      /plaidItemId\s+String/.test(refreshBody),
    );
    check(
      "RefreshExecution retains overallStatus, so failures are filterable by deployment",
      /overallStatus\s+String/.test(refreshBody),
    );

    // Deliberately NOT built here: no deployment projection, no deployment DTO.
    check(
      "no deployment projection was built in this slice",
      !/deployment/i.test(strip("lib/platform/refresh/projections-core.ts")),
    );
  }

  // ── restore env ────────────────────────────────────────────────────────────────
  if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
  else process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA = originalPublic;
  if (originalBare === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalBare;

  if (failures > 0) {
    console.error(`\ndeployment.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\ndeployment.test: all passed.");
}

void main();
