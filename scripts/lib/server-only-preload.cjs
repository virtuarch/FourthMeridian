/**
 * scripts/lib/server-only-preload.cjs
 *
 * A `--require` preload for the test runner (scripts/run-tests.ts). A handful of
 * app modules declare `import 'server-only'` — a Next.js-internal alias that is
 * NOT an installed npm package, so under a plain tsx/node runtime the import
 * fails with "Cannot find module 'server-only'".
 *
 * This preload patches the CJS resolver to redirect the bare `server-only`
 * specifier to the existing empty stub (scripts/lib/server-only-noop.cjs). It is
 * the reusable form of the resolver patch that already lives inline in
 * scripts/test-visibility-two-user-space.ts — no new mechanism, no new dep.
 *
 * Scope: test process only. Production behavior of `server-only` inside the
 * Next.js build is untouched (this file is never imported by app/ code).
 */
/* eslint-disable @typescript-eslint/no-require-imports -- CJS preload for `node --require`; require is intrinsic here. */
const path = require("path");
const Module = require("module");

const NOOP_PATH = path.join(__dirname, "server-only-noop.cjs");

const moduleInternals = Module;
const originalResolve = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return NOOP_PATH;
  return originalResolve.call(this, request, ...rest);
};
