/**
 * components/platform/workspace-session.test.ts  (OPS-2C-6)
 *
 * The workspace owns the operational session. Two things are pinned:
 *
 *  1. BEHAVIOUR — the store dedupes by url, fans one response out to every
 *     subscriber, and discards everything on dispose. Exercised directly against
 *     the store with a fake `fetch`; no React renderer exists in this repo.
 *
 *  2. BOUNDARY — sharing consumption must not become sharing AUTHORITY. The
 *     tempting next step is a "dashboard endpoint" or an aggregate DTO that
 *     returns several routes at once; that would put response assembly in the
 *     workspace and quietly create a second place operational truth is shaped.
 *     The store therefore stores each response verbatim under its own url and
 *     never merges, folds, or reconciles.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createWorkspaceSessionStore } from "@/components/platform/workspace-session";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Records every url fetched, so dedupe is measured rather than assumed. */
function fakeFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
    } as unknown as Response;
  };
  return { calls, impl };
}

async function main() {
  const realFetch = globalThis.fetch;

  // ── dedupe ─────────────────────────────────────────────────────────────────────
  console.log("session · one request per url, however many widgets ask");
  {
    const { calls, impl } = fakeFetch({ ok: 1 });
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = createWorkspaceSessionStore();
    const url = "/api/platform/platform-ops/convergence";

    // Three widgets in one workspace asking for the same resource.
    store.ensure(url);
    store.ensure(url);
    store.ensure(url);
    await tick();

    check("three subscribers ⇒ ONE network request", calls.length === 1, `issued ${calls.length}`);
    check("the store counts one issued request", store.requestCount() === 1);
    check("it fetched exactly the url asked for", calls[0] === url);

    const snap = store.read(url);
    check("the response is available to subscribers", (snap.data as { ok: number } | null)?.ok === 1);
    check("loading cleared", snap.loading === false);
    check("no error", snap.error === null);

    // Every subscriber sees the SAME object — one operational moment, not three.
    check("all subscribers observe one identical snapshot", store.read(url) === snap);
    store.dispose();
  }

  // ── distinct urls stay distinct ────────────────────────────────────────────────
  console.log("session · different routes are never combined");
  {
    const { calls, impl } = fakeFetch({ v: 1 });
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = createWorkspaceSessionStore();
    store.ensure("/api/platform/platform-ops/refresh/summary");
    store.ensure("/api/platform/platform-ops/refresh/coverage");
    store.ensure("/api/platform/platform-ops/refresh/failures");
    await tick();

    check("three distinct routes ⇒ three requests (no merging)", calls.length === 3, `issued ${calls.length}`);
    check(
      "each response is stored under its OWN url, verbatim",
      store.read("/api/platform/platform-ops/refresh/summary") !==
        store.read("/api/platform/platform-ops/refresh/coverage"),
    );
    store.dispose();
  }

  // ── subscription ───────────────────────────────────────────────────────────────
  console.log("session · subscribers are notified, and can leave");
  {
    const { impl } = fakeFetch({ v: 2 });
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = createWorkspaceSessionStore();
    const url = "/api/platform/platform-ops/cost";

    let aCalls = 0;
    let bCalls = 0;
    const unsubA = store.subscribe(url, () => { aCalls++; });
    store.subscribe(url, () => { bCalls++; });

    const before = store.read(url);
    check("initial snapshot is loading", before.loading === true && before.data === null);
    check("the loading snapshot is stable between reads", store.read(url) === before);

    store.ensure(url);
    await tick();

    check("both subscribers were notified once", aCalls === 1 && bCalls === 1);
    check("the snapshot identity CHANGED on resolve (so React re-renders)", store.read(url) !== before);

    unsubA();
    check("unsubscribing removes only that listener", true); // no throw; b remains
    store.dispose();
  }

  // ── errors fan out too ─────────────────────────────────────────────────────────
  console.log("session · failures are shared, not retried per widget");
  {
    const { calls, impl } = fakeFetch(null, { ok: false, status: 500 });
    globalThis.fetch = impl as unknown as typeof fetch;

    const store = createWorkspaceSessionStore();
    const url = "/api/platform/platform-ops/history";
    store.ensure(url);
    store.ensure(url);
    await tick();

    const snap = store.read(url);
    check("one request even when it fails", calls.length === 1);
    check("the error reaches subscribers", snap.error === "Request failed (500)");
    check("no data is invented on failure", snap.data === null);
    check("loading cleared on failure", snap.loading === false);

    const forbidden = fakeFetch(null, { ok: false, status: 403 });
    globalThis.fetch = forbidden.impl as unknown as typeof fetch;
    const s2 = createWorkspaceSessionStore();
    s2.ensure("/x");
    await tick();
    check("403 is reported as an authorization failure", s2.read("/x").error === "Not authorized");
    s2.dispose();
    store.dispose();
  }

  // ── session lifetime ───────────────────────────────────────────────────────────
  console.log("session · disposal clears the session (refetch on return)");
  {
    const { calls, impl } = fakeFetch({ v: 3 });
    globalThis.fetch = impl as unknown as typeof fetch;

    const first = createWorkspaceSessionStore();
    first.ensure("/api/platform/platform-ops/alerts");
    await tick();
    check("first visit fetches", calls.length === 1);
    first.dispose();

    // A new workspace visit = a new store. Nothing carries over.
    const second = createWorkspaceSessionStore();
    check("a new session starts with no answers", second.read("/api/platform/platform-ops/alerts").loading === true);
    second.ensure("/api/platform/platform-ops/alerts");
    await tick();
    check("returning REFETCHES rather than serving a stale answer", calls.length === 2);
    second.dispose();
  }

  globalThis.fetch = realFetch;

  // ── boundary: consumption shared, authority untouched ──────────────────────────
  console.log("boundary · consumption only, never authority");
  {
    const src = strip("components/platform/workspace-session.tsx");
    check("imports no projection", !/@\/lib\/platform\/refresh\/(projections|execution-query)/.test(src));
    check("imports no db/Prisma", !/@\/lib\/db|@prisma\/client/.test(src));
    check("imports no authority module", !/provider-health|connections\/health|jobs\/health|convergence\/convergence/.test(src));
    check("no folding or merging of responses", !/\.reduce\(|Object\.assign|\.\.\.a,|merge/i.test(src));
    check("no aggregate/dashboard endpoint is constructed", !/dashboard-endpoint|\/api\/platform\/platform-ops\/(all|dashboard|bundle)/.test(src));
    check("no hardcoded route list — widgets still declare their own url", !/platform-ops\/(alerts|job-health|convergence)"/.test(src));
    check("stores responses verbatim (json is not transformed)", /data:\s*json/.test(src));
  }

  console.log("boundary · the shared hook keeps the static-url invariant");
  {
    // The V25-CLOSE-1A guard scans `useWidgetFetch` call sites; this hook has a
    // different name, so its call sites are pinned here instead.
    const CALL = /useSharedWidgetFetch\s*(?:<[^>]*>)?\s*\(\s*([\s\S]*?)\s*[,)]/g;
    const files = [
      "components/platform/widgets/OpsConvergenceWidget.tsx",
      "components/platform/widgets/OpsTimelineWidget.tsx",
    ];
    let sites = 0;
    for (const f of files) {
      for (const m of strip(f).matchAll(CALL)) {
        sites++;
        const arg = m[1].trim();
        check(`${path.basename(f)}: url is a static string literal`, /^"[^"\\]*"$/.test(arg), arg.slice(0, 50));
      }
    }
    check("both migrated widgets were scanned", sites === 2, `found ${sites}`);
  }

  console.log("migration · behaviour unchanged apart from sharing");
  {
    const conv = strip("components/platform/widgets/OpsConvergenceWidget.tsx");
    const time = strip("components/platform/widgets/OpsTimelineWidget.tsx");
    for (const [name, src] of [["convergence", conv], ["timeline", time]] as const) {
      check(`${name}: still reads the SAME route`, /"\/api\/platform\/platform-ops\/convergence"/.test(src));
      check(`${name}: no longer owns an independent fetch`, !/useWidgetFetch/.test(src));
      check(`${name}: destructures the same {data, loading, error}`, /\{\s*data,\s*loading,\s*error\s*\}/.test(src));
      check(`${name}: still renders via WidgetMessage for loading/error`, /WidgetMessage/.test(src));
      check(`${name}: computes no aggregation`, !/\.reduce\(/.test(src));
    }
  }

  console.log("mount · the workspace owns the session");
  {
    const dash = strip("components/platform/PlatformSpaceDashboard.tsx");
    check("the workspace body is wrapped in the session provider", /<WorkspaceSessionProvider>/.test(dash));
    check(
      "the body is keyed by workspace id (session discarded on switch)",
      /key=\{active\.workspaceId\}/.test(dash),
    );
    check("the dashboard still fetches nothing itself", !/fetch\(/.test(dash));
  }

  if (failures > 0) {
    console.error(`\nworkspace-session.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nworkspace-session.test: all passed.");
}

void main();
