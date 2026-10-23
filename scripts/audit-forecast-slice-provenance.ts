/**
 * scripts/audit-forecast-slice-provenance.ts
 *
 * THE FORECAST SLICE PROVENANCE AUDIT. Source + git objects, no database.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * EVERY RECORDED "FORECAST-N DID NOT TOUCH …" CLAIM IS TRUE OF THAT SLICE'S OWN
 * COMMIT. lib/forecast/slice-provenance.ts records, per slice, the commit, its
 * parent and the paths it changed nothing under. The unit suites keep those
 * records from being weakened (hermetically); this audit is the half that needs
 * git, so it lives in the architecture gate rather than the unit suite:
 *
 *   1. `parent` is `commit`'s first parent — read from the commit object itself,
 *      so it holds on a shallow clone (the object records its parent's SHA).
 *   2. `commit`'s subject names the slice — the SHA is the commit it claims.
 *   3. `git diff --name-only parent commit -- <untouched>` is empty.
 *
 * ── Shallow clones ──────────────────────────────────────────────────────────
 * A diff of two commits needs their TREES, not the history between them. When a
 * recorded commit is absent (actions/checkout fetches depth 1), the audit fetches
 * exactly the recorded SHAs at depth 1 from `origin`. If they still cannot be
 * read, that is a ✗ — never a skip: an unverifiable claim is not a passing one.
 *
 * Tier: REQUIRED — the corpus is the repository's own history. ✗ ⇒ exit 1.
 *
 * Run: npx tsx scripts/audit-forecast-slice-provenance.ts
 */

import { spawnSync } from "node:child_process";
import { FORECAST_SLICE_PROVENANCE } from "../lib/forecast/slice-provenance";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const hasCommit = (sha: string) => git(["cat-file", "-e", `${sha}^{commit}`]).ok;

function main(): void {
  const shas = [...new Set(FORECAST_SLICE_PROVENANCE.flatMap((c) => [c.parent, c.commit]))];
  const absent = shas.filter((s) => !hasCommit(s));
  if (absent.length > 0) {
    console.log(`  … ${absent.length} recorded commit(s) absent (shallow clone) — fetching them at depth 1`);
    const f = git(["fetch", "--no-tags", "--quiet", "--depth=1", "origin", ...absent]);
    if (!f.ok) console.error(`  fetch failed: ${f.out}`);
  }

  for (const c of FORECAST_SLICE_PROVENANCE) {
    console.log(`\n${c.slice} (${c.commit.slice(0, 7)})`);
    if (!hasCommit(c.parent) || !hasCommit(c.commit)) {
      check(`${c.slice}: recorded commits are readable`, false,
        "cannot verify a claim about a commit this clone cannot read");
      continue;
    }
    const object = git(["cat-file", "commit", c.commit]).out;
    const firstParent = /^parent ([0-9a-f]{40})$/m.exec(object)?.[1];
    check(`${c.slice}: parent ${c.parent.slice(0, 7)} is the commit's first parent`,
      firstParent === c.parent, `object records ${firstParent ?? "no parent"}`);
    const subject = git(["log", "-1", "--format=%s", c.commit]).out;
    check(`${c.slice}: the commit's subject names the slice`,
      subject.startsWith(`${c.slice} `), subject);
    const diff = git(["diff", "--name-only", c.parent, c.commit, "--", ...c.untouched]);
    check(`${c.slice} touched none of: ${c.untouched.join(", ")}`,
      diff.ok && diff.out === "", diff.out);
  }

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} forecast slice provenance check(s) violated.\n`);
    process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — every recorded FORECAST slice claim holds on its own commit. ✓\n`);
}

main();
