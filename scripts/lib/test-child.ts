/**
 * scripts/lib/test-child.ts — one test file, one child process, one deadline.
 *
 * Extracted from scripts/run-tests.ts so the WATCHDOG (TEST-007 / TEST-012)
 * can be proven by scripts/run-tests.test.ts without running the whole suite:
 * a child that does not exit by `timeoutMs` is SIGKILLed (a child wedged at
 * 0% CPU in state S does not answer SIGTERM), reported as failed with its own
 * name and "TIMED OUT after N s", and never blocks the run.
 */
import { spawn } from "node:child_process";

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

export function runChild({ bin, args, cwd, file, timeoutMs }: RunChildOptions): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd });
    let output = "";
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => {
      clearTimeout(watchdog);
      resolve({ file, ok: false, timedOut: false, output: `spawn error: ${String(err)}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      if (timedOut) {
        resolve({
          file, ok: false, timedOut: true,
          output: `${output.trimEnd()}\n\nrun-tests: ${file} TIMED OUT after ${Math.round(timeoutMs / 1000)} s and was killed (${signal ?? "SIGKILL"}). ` +
                  "A test that cannot finish is a failed test; raise TEST_FILE_TIMEOUT_MS only with a reason.",
        });
        return;
      }
      resolve({ file, ok: code === 0, timedOut: false, output: output.trimEnd() });
    });
  });
}
