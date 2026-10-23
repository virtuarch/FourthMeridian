/**
 * lib/platform/operator-actor.ts  (P1 — operator actions)
 *
 * The one translation from a resolved PlatformAuth to the `actor` an operator
 * action is recorded with. `auth.grant` is null exactly when access came from
 * the SYSTEM_ADMIN break-glass bypass (lib/platform/authorize.ts), so the actor
 * is attributed to its real authority, never guessed from the role column.
 */
import type { PlatformAuth } from "@/lib/platform/authorize";
import type { OperatorActionInput } from "@/lib/audit";

export function operatorActorFrom(auth: Pick<PlatformAuth, "user" | "grant">, area: string): OperatorActionInput["actor"] {
  return {
    userId: auth.user.id,
    via: auth.grant ? "PLATFORM_GRANT" : "SYSTEM_ADMIN",
    area,
  };
}
