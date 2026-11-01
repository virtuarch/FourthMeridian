/**
 * lib/email/providers/resend-idempotency.test.ts  (Comms Center C, N-a)
 *
 * The adapter's idempotency-conflict mapping (B2 PRE-FLIP R4), at the adapter
 * level, with the SDK error names taken from RESEND_IDEMPOTENCY_ERROR_NAMES —
 * which is pinned at compile time to the SDK's `ErrorResponse["name"]`, so an
 * SDK rename fails tsc rather than silently disabling the mapping.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/providers/resend-idempotency.test.ts
 */

import {
  createResendAdapter,
  isIdempotencyConflict,
  RESEND_IDEMPOTENCY_ERROR_NAMES,
  type ResendLikeClient,
} from "@/lib/email/providers/resend";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const MSG = { to: "a@example.invalid", from: "FM <x@example.invalid>", subject: "s", text: "t" };
const failingWith = (name: string, statusCode: number | null): ResendLikeClient =>
  ({ emails: { send: async () => ({ data: null, error: { name, statusCode, message: "provider says no" } }) } });

async function main() {
  console.log("Resend idempotency-conflict mapping (adapter level)");
  check("the pinned names are the SDK's literal codes", RESEND_IDEMPOTENCY_ERROR_NAMES.conflict === "invalid_idempotent_request"
    && RESEND_IDEMPOTENCY_ERROR_NAMES.inFlight === "concurrent_idempotent_requests");

  const conflict = failingWith(RESEND_IDEMPOTENCY_ERROR_NAMES.conflict, 409);
  const withKey = await createResendAdapter(() => conflict).send({ ...MSG, idempotencyKey: "item_1" });
  check("invalid_idempotent_request + key ⇒ sent, uncertain IDEMPOTENCY_CONFLICT, no id",
    withKey.status === "sent" && withKey.uncertain === "IDEMPOTENCY_CONFLICT" && withKey.id === undefined, withKey);

  const noKey = await createResendAdapter(() => conflict).send(MSG);
  check("the same error WITHOUT a key ⇒ error (never sent / uncertain)", noKey.status === "error" && !noKey.uncertain, noKey);

  const inFlight = await createResendAdapter(() => failingWith(RESEND_IDEMPOTENCY_ERROR_NAMES.inFlight, 409)).send({ ...MSG, idempotencyKey: "item_1" });
  check("concurrent_idempotent_requests + key ⇒ error (retried under the same key)", inFlight.status === "error" && !inFlight.uncertain, inFlight);

  const otherStatus = await createResendAdapter(() => failingWith(RESEND_IDEMPOTENCY_ERROR_NAMES.conflict, 422)).send({ ...MSG, idempotencyKey: "item_1" });
  check("the conflict name with a non-409 status ⇒ error", otherStatus.status === "error", otherStatus);

  check("predicate: key + conflict (no status) ⇒ true; empty key ⇒ false",
    isIdempotencyConflict({ name: "invalid_idempotent_request" }, { idempotencyKey: "k" })
    && !isIdempotencyConflict({ name: "invalid_idempotent_request", statusCode: 409 }, { idempotencyKey: "" })
    && !isIdempotencyConflict({ name: "invalid_idempotent_request", statusCode: 409 }, undefined));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall idempotency-mapping checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
