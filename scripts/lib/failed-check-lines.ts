/**
 * scripts/lib/failed-check-lines.ts — pick the failed checks out of a test
 * script's output, each preceded by the section header it sits under.
 *
 * run-tests prints only the tail of a failed file's output; a long suite can
 * push the one `✗` line that names what broke out of that tail (CI run
 * 41660617790: "71 passed, 1 failed" with no failed check visible). Pure.
 */

const FAILED = /^\s*✗ /;
// Section headers in these standalone scripts are unindented, non-empty lines
// that are not a check, a summary or a log line.
const SECTION = /^[^\s✓✗[]/;

export function failedCheckLines(output: string): string[] {
  const out: string[] = [];
  let section: string | null = null;
  let printedSection: string | null = null;
  for (const line of output.split("\n")) {
    if (FAILED.test(line)) {
      if (section !== null && section !== printedSection) {
        out.push(section);
        printedSection = section;
      }
      out.push(line);
    } else if (SECTION.test(line)) {
      section = line;
    }
  }
  return out;
}
