/**
 * scripts/lib/test-child.ts — one test file, one child process, one deadline.
 *
 * Extracted from scripts/run-tests.ts so the WATCHDOG (TEST-007 / TEST-012)
 * can be proven by scripts/run-tests.test.ts without running the whole suite:
 * a child that does not exit by `timeoutMs` is SIGKILLed (a child wedged at
 * 0% CPU in state S does not answer SIGTERM), reported as failed with its own
 * name and "TIMED OUT after N s", and never blocks the run.
 *
 * CI-LOCAL completion defect (root cause, 2026-10-27). The runner spawns the
 * `tsx` WRAPPER, and tsx runs the test in a GRANDCHILD node process. The
 * watchdog used to SIGKILL only the wrapper: the wedged grandchild was
 * re-parented to PID 1, kept the inherited stdout/stderr pipes open, so the
 * child's "close" event never fired and `npm run ci` hung forever at 0% CPU
 * (observed: lib/ai/assemblers/transactions.privacy.test.ts orphaned for 30+
 * min). Now each child leads its OWN process group (detached) and the watchdog
 * kills the whole group; after a kill the result resolves on "exit" (plus a
 * short grace for buffered output) instead of waiting for pipes a stray
 * descendant might still hold. Live groups are also killed if the runner
 * itself exits or is interrupted, so detaching never leaks a test process.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface ChildResult { file: string; ok: boolean; timedOut: boolean; output: string }

export interface RunChildOptions {
  /** Executable and its arguments (the test file is passed by the caller). */
  bin: string;
  args: string[];
  cwd: string;
  /** Label for the report (the repo-relative test file). */
  file: string;
  timeoutMs: number;
}

/** After a watchdog kill, how long to wait for "close" before resolving anyway. */
const CLOSE_GRACE_MS = 1_000;

const live = new Set<ChildProcess>();

/** SIGKILL a child's whole process group (it is its group leader), else the child. */
function killGroup(child: ChildProcess): void {
  if (child.pid == null) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

let reaperInstalled = false;
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reapAll = () => { for (const c of live) killGroup(c); live.clear(); };
  process.on("exit", reapAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { reapAll(); process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1)); });
  }
}

export function runChild({ bin, args, cwd, file, timeoutMs }: RunChildOptions): Promise<ChildResult> {
  installReaper();
  return new Promise((resolve) => {
    // detached ⇒ the child leads a new process group, so the watchdog can kill
    // tsx AND the node grandchild that actually runs the test.
    const child = spawn(bin, args, { cwd, detached: true });
    live.add(child);
    let output = "";
    let timedOut = false;
    let settled = false;
    const settle = (r: ChildResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      live.delete(child);
      resolve(r);
    };
    const timedOutResult = (signal: NodeJS.Signals | null): ChildResult => ({
      file, ok: false, timedOut: true,
      output: `${output.trimEnd()}\n\nrun-tests: ${file} TIMED OUT after ${Math.round(timeoutMs / 1000)} s and was killed (${signal ?? "SIGKILL"}). ` +
              "A test that cannot finish is a failed test; raise TEST_FILE_TIMEOUT_MS only with a reason.",
    });
    const watchdog = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => {
      settle({ file, ok: false, timedOut: false, output: `spawn error: ${String(err)}` });
    });
    // After a watchdog kill, never wait on pipes a stray descendant may hold.
    child.on("exit", (_code, signal) => {
      if (!timedOut) return;
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(timedOutResult(signal));
      }, CLOSE_GRACE_MS).unref();
    });
    child.on("close", (code, signal) => {
      if (timedOut) { settle(timedOutResult(signal)); return; }
      settle({ file, ok: code === 0, timedOut: false, output: output.trimEnd() });
    });
  });
}
