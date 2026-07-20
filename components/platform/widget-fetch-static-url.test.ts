/**
 * V25-CLOSE-1A — `useWidgetFetch` is only ever called with a static url.
 *
 * WHY THIS EXISTS. The hook fetches without first resetting `loading`/`error`,
 * because they are already `true`/`null` from initial state and — with a static
 * url — the effect runs exactly once per mount. The reset it used to perform was
 * therefore dead code, and removing it cleared a blocking
 * `react-hooks/set-state-in-effect` error.
 *
 * That deletion is only safe while the precondition holds. If someone passes a
 * changing url (a template literal, a variable, a concatenation), the effect
 * re-runs and the widget renders the PREVIOUS route's data with `loading: false`
 * — presenting stale operator data as current. Lint cannot see that; this can.
 *
 * If you need a widget whose url changes, remount it with a React `key` instead.
 * That resets the hook's state honestly and keeps this guard green.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = process.cwd();
const SCAN_ROOTS = [path.join(ROOT, "components"), path.join(ROOT, "app")];
const HOOK_FILE = path.join(ROOT, "components", "platform", "widget-kit.tsx");

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Strip comments so prose mentioning the hook never counts as a call site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const files = SCAN_ROOTS.filter((d) => {
  try { return statSync(d).isDirectory(); } catch { return false; }
}).flatMap(walk);

// A call site is `useWidgetFetch` + optional <TypeArg> + "(" then the first
// argument. Whitespace/newlines are allowed, since several call sites wrap.
const CALL = /useWidgetFetch\s*(?:<[^>]*>)?\s*\(\s*([\s\S]*?)\s*[,)]/g;

test("every useWidgetFetch call site passes a static string literal url", () => {
  const violations: string[] = [];
  let callSites = 0;

  const SELF = path.join(ROOT, "components", "platform", "widget-fetch-static-url.test.ts");

  for (const file of files) {
    if (file === HOOK_FILE) continue; // the declaration itself, not a call
    if (file === SELF) continue;      // this guard quotes the call shape in its own messages
    const src = stripComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(CALL)) {
      const arg = match[1].trim();
      callSites++;
      // Accept only a double- or single-quoted literal with no interpolation.
      const isStaticLiteral = /^"[^"\\]*"$/.test(arg) || /^'[^'\\]*'$/.test(arg);
      if (!isStaticLiteral) {
        violations.push(`${path.relative(ROOT, file)} — useWidgetFetch(${arg.slice(0, 60)})`);
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `useWidgetFetch requires a static string literal url (see the contract in ` +
      `components/platform/widget-kit.tsx). Offending call sites:\n  ` +
      violations.join("\n  "),
  );

  // Guard against the guard passing vacuously: if the regex stops matching (a
  // rename, a reformat), zero call sites would trivially satisfy the assert
  // above. The hook has ~25 real consumers; require a healthy floor.
  assert.ok(
    callSites >= 20,
    `Expected to find the known useWidgetFetch call sites, found ${callSites}. ` +
      `The scan or the matcher is broken — fix it rather than lowering this floor.`,
  );
});

test("useWidgetFetch does not reset state synchronously inside its effect", () => {
  const src = stripComments(readFileSync(HOOK_FILE, "utf8"));
  const hook = src.slice(src.indexOf("export function useWidgetFetch"));
  const effectBody = hook.slice(hook.indexOf("useEffect("), hook.indexOf("}, [url]);"));

  // The two calls whose removal this guard protects. They must not come back
  // without also restoring the reset semantics the static-url contract replaced.
  for (const banned of ["setLoading(true)", "setError(null)"]) {
    assert.ok(
      !effectBody.includes(banned),
      `${banned} is back in the useWidgetFetch effect body. It is a blocking ` +
        `react-hooks/set-state-in-effect error, and it is unnecessary while the ` +
        `static-url contract holds. If the contract changed, update this guard ` +
        `and the hook's documented contract together.`,
    );
  }
});
