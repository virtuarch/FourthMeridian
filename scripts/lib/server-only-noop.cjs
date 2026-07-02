/**
 * scripts/lib/server-only-noop.cjs
 *
 * Empty stand-in for the `server-only` Next.js-internal alias, used by the
 * resolver shim in scripts/test-visibility-two-user-space.ts so app modules
 * can load in a standalone tsx runtime. `import 'server-only'` is a
 * side-effect-only import; this file intentionally exports nothing.
 */
module.exports = {};
