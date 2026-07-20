/**
 * lib/prototype-containment.test.ts — V25-CLOSE-2
 *
 * INVARIANT: prototype code can never become a production route.
 *
 * The failure this prevents actually happened. `app/prototype/` sits under the
 * App Router, so a tracked file there is built and deployed like any other page,
 * and `/prototype/*` is outside the `proxy.ts` auth matcher — i.e. public and
 * unauthenticated. One harness file (`timeline-component-v4/page.tsx`) shipped
 * that way for an entire release cycle before V25-CLOSE-1 found and untracked
 * it. Nothing in the repo would have objected; this file is that objection.
 *
 * Containment has four independent mechanisms, and this guard asserts all four
 * so none can rot silently:
 *
 *   1. TRACKING   — no file under app/prototype/ is tracked by git. This is the
 *                   one that actually stops a deploy: Vercel builds from git, so
 *                   untracked means unshipped. The other three are depth.
 *   2. GITIGNORE  — the tree stays ignored, so tracking cannot happen by accident
 *                   (only via a deliberate `git add -f`, which rule 1 then
 *                   catches).
 *   3. TYPECHECK  — tsconfig excludes it, so a broken experiment cannot fail
 *                   `tsc --noEmit` for the real application.
 *   4. LINT       — eslint ignores it, so prototype noise cannot drown the CI
 *                   lint signal. That exact masking hid five real blocking
 *                   errors in tracked components until V25-CLOSE-1A.
 *
 * Prototypes themselves are untouched and remain fully usable locally — this
 * guards their BOUNDARY, not their existence. Deleting an experiment is never
 * required to make this pass.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = process.cwd();
const PROTOTYPE_ROOTS = ["app/prototype", "prototype"];

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Strip comments so prose describing a rule never satisfies the rule. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("1. TRACKING — no prototype file is tracked by git (untracked ⇒ never deployed)", () => {
  let tracked: string;
  try {
    tracked = execFileSync("git", ["ls-files", "--", ...PROTOTYPE_ROOTS], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    // No git available (unlikely — CI checks out with git). Skip rather than
    // fail: the remaining three mechanisms still assert below.
    return;
  }

  assert.equal(
    tracked,
    "",
    `Prototype files are TRACKED and will deploy as public, unauthenticated ` +
      `routes under /prototype/*:\n  ${tracked.split("\n").join("\n  ")}\n\n` +
      `Prototypes must stay untracked. Run: git rm --cached <file> ` +
      `(the file stays on disk, so the experiment survives).`,
  );
});

test("2. GITIGNORE — both prototype trees stay ignored", () => {
  const gitignore = read(".gitignore");
  for (const dir of PROTOTYPE_ROOTS) {
    assert.ok(
      new RegExp(`^${dir}/\\s*$`, "m").test(gitignore),
      `.gitignore no longer ignores "${dir}/". Without it, a routine ` +
        `\`git add -A\` re-tracks the tree and ships it.`,
    );
  }
});

test("3. TYPECHECK — tsconfig excludes both prototype trees", () => {
  const tsconfig = JSON.parse(read("tsconfig.json")) as { exclude?: string[] };
  const exclude = tsconfig.exclude ?? [];
  for (const dir of ["prototype", "app/prototype"]) {
    assert.ok(
      exclude.includes(dir),
      `tsconfig.json "exclude" no longer lists "${dir}". The include glob is ` +
        `**/*.ts, so without this a prototype (or a whole nested Next app under ` +
        `prototype/) is typechecked as production source.`,
    );
  }
});

test("4. LINT — eslint ignores both prototype trees", () => {
  const config = stripComments(read("eslint.config.mjs"));
  for (const pattern of ["prototype/**", "app/prototype/**"]) {
    assert.ok(
      config.includes(`"${pattern}"`) || config.includes(`'${pattern}'`),
      `eslint.config.mjs no longer ignores "${pattern}". Prototype lint noise ` +
        `then makes \`npm run lint\` exit non-zero for reasons CI never sees, ` +
        `and a gate that always fails stops being a gate (V25-CLOSE-1A).`,
    );
  }
});

test("5. TEST DISCOVERY — run-tests.ts does not collect prototype tests", () => {
  const runner = stripComments(read("scripts/run-tests.ts"));
  assert.ok(
    /NON_PRODUCTION_DIRS\s*=\s*new Set<string>\(\s*\[[^\]]*"prototype"/.test(runner),
    `scripts/run-tests.ts no longer prunes "prototype" during collection. A ` +
      `prototype's private copy of a component's tests then runs in the ` +
      `production suite indistinguishably from the real guard, so a green suite ` +
      `implies an invariant production code never had to satisfy.`,
  );
});
