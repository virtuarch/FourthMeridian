/**
 * scripts/run-tests.test.ts — the per-file watchdog (TEST-007 / TEST-012).
 *
 * Proves, with real child processes and a short deadline: a child that never
 * exits is killed and reported FAILED under its own name with "TIMED OUT"; a
 * child that exits 0 in time passes; a child that exits 1 fails without being
 * called a timeout; a wrapper whose grandchild wedges (the tsx shape) is killed
 * as a whole process group without leaving an orphan holding the pipe (the
 * CI-LOCAL completion defect); and scripts/run-tests.ts actually routes every file
 * through that function with a default deadline of 180 s. Hermetic apart from
 * spawning `node -e`.
 */
import { readFileSync } from "node:fs";
import { runChild } from "./lib/test-child";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("the watchdog kills a wedged child and names it");
  {
    const t0 = Date.now();
    const r = await runChild({ bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), file: "fixture/wedged.test.ts", timeoutMs: 400 });
    const ms = Date.now() - t0;
    check("reported as failed", !r.ok);
    check("flagged timedOut", r.timedOut);
    check("output names the file and says TIMED OUT", /fixture\/wedged\.test\.ts TIMED OUT after/.test(r.output), r.output.slice(-200));
    check("returned shortly after the deadline, not after the child's own lifetime", ms >= 350 && ms < 5_000, `${ms} ms`);
  }

  console.log("the watchdog kills the whole process group (tsx wrapper + node grandchild)");
  {
    // The real shape: a wrapper (like tsx) whose GRANDCHILD runs the test, wedges,
    // and inherits the wrapper's stdout. Killing only the wrapper left the
    // grandchild holding the pipe, so "close" never fired and the run hung.
    const grand = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/run-tests-grandchild-${process.pid}.pid`;
    const wrapper = `const { spawn } = require('child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(grand)}, ${JSON.stringify(pidFile)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
    const t0 = Date.now();
    const r = await runChild({ bin: process.execPath, args: ["-e", wrapper], cwd: process.cwd(), file: "fixture/wrapped.test.ts", timeoutMs: 600 });
    const ms = Date.now() - t0;
    check("wrapped wedge: reported failed + timedOut", !r.ok && r.timedOut);
    check("wrapped wedge: returns shortly after the deadline (does not hang on the grandchild's pipe)", ms >= 550 && ms < 5_000, `${ms} ms`);
    let grandPid = NaN;
    try { grandPid = Number(readFileSync(pidFile, "utf8")); } catch { /* not written */ }
    // SIGKILL is asynchronous: a killed-but-not-yet-reaped process still answers
    // kill(pid, 0) for a moment (seen on a GitHub runner). Poll up to 3 s for it to
    // disappear rather than sampling once.
    const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let alive = Number.isFinite(grandPid) && isAlive(grandPid);
    for (let i = 0; alive && i < 30; i++) {
      await new Promise((res) => setTimeout(res, 100));
      alive = isAlive(grandPid);
    }
    check("wrapped wedge: the grandchild is dead (no orphan left behind)", Number.isFinite(grandPid) && !alive, `pid ${grandPid}`);
    if (alive) { try { process.kill(grandPid, "SIGKILL"); } catch { /* ignore */ } }
  }

  console.log("a healthy child is unaffected");
  {
    const ok = await runChild({ bin: process.execPath, args: ["-e", "console.log('hi')"], cwd: process.cwd(), file: "fixture/ok.test.ts", timeoutMs: 5_000 });
    check("exit 0 ⇒ ok, not timedOut, output captured", ok.ok && !ok.timedOut && ok.output === "hi");
    const bad = await runChild({ bin: process.execPath, args: ["-e", "console.error('boom'); process.exit(1)"], cwd: process.cwd(), file: "fixture/bad.test.ts", timeoutMs: 5_000 });
    check("exit 1 ⇒ failed, NOT a timeout, stderr captured", !bad.ok && !bad.timedOut && bad.output === "boom");
  }

  console.log("scripts/run-tests.ts uses it, with a 180 s default");
  {
    const src = readFileSync("scripts/run-tests.ts", "utf8");
    check("imports runChild from ./lib/test-child", /import \{ runChild \} from "\.\/lib\/test-child"/.test(src));
    check("runFile delegates to runChild with FILE_TIMEOUT_MS", /return runChild\(\{[^}]*timeoutMs: FILE_TIMEOUT_MS/.test(src));
    check("default deadline is 180_000 ms, overridable by TEST_FILE_TIMEOUT_MS", /DEFAULT_FILE_TIMEOUT_MS = 180_000/.test(src) && /TEST_FILE_TIMEOUT_MS/.test(src));
    check("no direct spawn remains in the runner", !/\bspawn\(/.test(src));
    check("a timed-out file is marked in the progress line", /timed out/.test(src));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}
void main();
