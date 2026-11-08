/**
 * app/api/platform/ai/memory/deps.ts  (Platform AI operational memory — the real route seams)
 *
 * heldAreas   ONE directory read of the operator's ACTIVE grants (no denial writes).
 * readersFor  the FRESH guard on that area (conversationAreaAccess) and the
 *             authorized readers built from that same guard result; null on refusal.
 * store       lib/platform/intelligence/ai/memory/store.ts (fm_app, RLS).
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { grantedAreasFrom } from "@/lib/platform/intelligence/ai/conversations/handlers";
import type { MemoryDeps } from "@/lib/platform/intelligence/ai/memory/handlers";
import * as store from "@/lib/platform/intelligence/ai/memory/store";
import { conversationAreaAccess } from "../conversations/area-access";

export function memoryDeps(operatorId: string): MemoryDeps {
  return {
    heldAreas: async () => grantedAreasFrom(await loadPlatformDirectory(operatorId)),
    readersFor: async (area: PlatformArea) => (await conversationAreaAccess(area, operatorId))?.memoryReaders ?? null,
    store,
    now: () => new Date(),
  };
}
