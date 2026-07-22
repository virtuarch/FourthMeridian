/**
 * lib/events/handlers/snapshot.ts  (EV-1 Slice 2)
 *
 * The first domain-event handler: regenerate a Space's snapshot after a
 * share-set-changing event. This collapses the duplicated inline
 * `regenerateSpaceSnapshot` calls that previously lived in the account-share
 * route into one subscriber.
 *
 * Dependency direction is one-way: this module imports the snapshot writer
 * only. It must NOT import lib/events/emit.ts — emit.ts imports and registers
 * this handler (see the HANDLERS map there), never the reverse.
 *
 * Best-effort by contract: this handler may throw; dispatchDomainEvent
 * (lib/events/emit.ts) catches and logs so a snapshot failure never fails the
 * originating request — matching the pre-seam try/catch semantics.
 *
 * Registered for: AccountShared, AccountShareRevoked. Both carry a spaceId in
 * the envelope, so both resolve to regenerateSpaceSnapshot(spaceId).
 */

import { regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";
import type { DomainEvent } from "@/lib/events/types";

/**
 * Regenerate today's SpaceSnapshot for the event's space. No-ops if the event
 * carries no spaceId (defensive — the share events always do).
 */
export async function regenerateSnapshotOnShareChange(event: DomainEvent): Promise<void> {
  if (!event.spaceId) return;
  await regenerateSpaceSnapshot(event.spaceId);
}
