/**
 * lib/notifications/delivery/store.ts  (Comms Center Phase A-2a)
 *
 * The production ledger WRITER: one INSERT per send, through fm_system.
 *
 * AUTHORITY: systemDb (fm_system), whoever triggers the send. sendEmail is
 * reached from tenant routes, from the pre-identity auth path (reactivation,
 * deletion-cancel at sign-in), from cron and from operator consoles alike, and
 * CommsDelivery is revoked from fm_app and fm_auth by design (it is
 * operational delivery telemetry, not tenant content) — the same reasoning as
 * lib/notifications/create.ts for NotificationDelivery. The client is imported
 * LAZILY so lib/email/send.ts stays free of the database at import time.
 *
 * COST: `createMany` with one row — a single INSERT with no RETURNING (no
 * read-back, no SELECT-policy round trip).
 *
 * NOT RECORDED, by design:
 *   - anything under NODE_ENV=test (unit tests never reach a database);
 *   - a send answered by the in-memory CAPTURE transport (provider "capture":
 *     test mode, or local dev with no RESEND_API_KEY) — that is not a delivery
 *     attempt, and recording it would make every developer's unit run write
 *     rows. The non-production recipient GUARD's captures (provider "none")
 *     ARE recorded: that is the Preview volume the API reports under `captured`.
 */

import "server-only";
import type { CommsDeliveryRow, LedgerWriter } from "@/lib/notifications/delivery/types";

interface LedgerInsertClient {
  commsDelivery: { createMany(args: { data: CommsDeliveryRow[] }): Promise<{ count: number }> };
}

/** True when this row must not be written by the production writer (see header). */
export function skipProductionWrite(row: CommsDeliveryRow, nodeEnv: string | undefined): boolean {
  return nodeEnv === "test" || row.provider === "capture";
}

/** The production writer. Throws on a DB failure — recordDelivery() is the non-throwing wrapper. */
export const writeDeliveryRow: LedgerWriter = async (row) => {
  if (skipProductionWrite(row, process.env.NODE_ENV)) return;
  const { systemDb } = await import("@/lib/db");
  await (systemDb as unknown as LedgerInsertClient).commsDelivery.createMany({ data: [row] });
};
