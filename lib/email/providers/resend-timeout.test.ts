/**
 * lib/email/providers/resend-timeout.test.ts  (PR C review · bounded transport)
 *
 * A hung provider call resolves as the adapter's ordinary error result within
 * the bound — never a throw, never a hang — and a prompt answer is unaffected.
 * Uses a fake client and a short injected bound; no network.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/providers/resend-timeout.test.ts
 */

import { createResendAdapter, RESEND_SEND_TIMEOUT_MS, type ResendLikeClient } from "./resend";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const MSG = { to: "invitee@example.test", from: "FM <hello@example.test>", subject: "s", text: "t https://app.example.test/x?invite=abc" };

// A never-settling promise holds no timer, so without this a hang would let the
// process exit 0 with checks unrun. The watchdog keeps the loop alive and fails.
const watchdog = setTimeout(() => { console.error("  ✗ the adapter hung past the bound (watchdog)"); process.exit(1); }, 3000);

async function main() {
  console.log("Resend adapter — bounded send");
  check("the default bound is 10 s", RESEND_SEND_TIMEOUT_MS === 10_000);

  const hanging: ResendLikeClient = { emails: { send: () => new Promise(() => {}) } };
  const t0 = Date.now();
  let threw = false;
  let r: Awaited<ReturnType<ReturnType<typeof createResendAdapter>["send"]>> | undefined;
  try { r = await createResendAdapter(() => hanging, { timeoutMs: 50 }).send(MSG); } catch { threw = true; }
  const took = Date.now() - t0;
  check("a hanging transport resolves (no throw) as status error", !threw && r?.status === "error" && r.provider === "resend", r);
  check("…within the bound (50 ms injected; < 1 s observed)", took >= 45 && took < 1000, took);
  check("…with a redacted, honest message (no address, no link)", r?.status === "error" && /timed out after 50 ms — delivery unknown/.test(r.error ?? "")
    && !/@|https?:/.test(r.error ?? ""), r);

  const prompt: ResendLikeClient = { emails: { send: async () => ({ data: { id: "re_1" }, error: null }) } };
  const ok = await createResendAdapter(() => prompt, { timeoutMs: 50 }).send(MSG);
  check("a prompt answer is unaffected (sent, provider id)", ok.status === "sent" && ok.id === "re_1", ok);

  // The bound's timer is cleared on a prompt answer (no 10 s straggler per send).
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const before = timers();
  const def = await createResendAdapter(() => prompt).send(MSG);
  check("default bound: prompt answer still sent", def.status === "sent");
  check("…and its timer was cleared", timers() === before, { before, after: timers() });

  clearTimeout(watchdog);
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nresend-timeout: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
