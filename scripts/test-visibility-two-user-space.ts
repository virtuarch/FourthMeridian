/**
 * scripts/test-visibility-two-user-space.ts
 *
 * KD-1 end-to-end privacy regression — LAUNCHER.
 *
 * Usage (dev database — run locally, from the repo root):
 *
 *     npx tsx scripts/test-visibility-two-user-space.ts
 *
 * ── Why a launcher exists ─────────────────────────────────────────────────────
 * Several lib/ modules in the test's import chain (lib/account-privacy.ts,
 * lib/env.ts, …) declare `import 'server-only'`. That package is NOT installed:
 * the Next.js compiler aliases it internally at build time, so any standalone
 * Node/tsx runtime fails at import with "Cannot find module 'server-only'".
 *
 * This launcher patches the CJS resolver to redirect 'server-only' to an
 * empty local stub (scripts/lib/server-only-noop.cjs — `import 'server-only'`
 * is side-effect-only, so an empty module is a faithful stand-in), then
 * dynamically imports the test body. The dynamic import guarantees the shim
 * is installed before ANY app module loads. The shim exists only in this test
 * process — production behavior of `server-only` inside Next.js is untouched.
 *
 * Test scenario, assertions, and cleanup live in
 * scripts/test-visibility-two-user-space.impl.ts.
 */

import Module from 'node:module';
import path from 'node:path';

const NOOP_PATH = path.join(__dirname, 'lib', 'server-only-noop.cjs');

type ResolveFn = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: ResolveFn };

const originalResolve = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (
  this: unknown,
  request: string,
  ...rest: unknown[]
): string {
  if (request === 'server-only') return NOOP_PATH;
  return originalResolve.call(this, request, ...rest) as string;
};

// Dynamic import AFTER the shim is installed — do not convert to a static
// import, or the app modules would load before the resolver is patched.
import('./test-visibility-two-user-space.impl').catch((e: unknown) => {
  console.error('LAUNCH FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
