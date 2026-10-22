/**
 * lib/test-support/space-world.ts  (TEST-002)
 *
 * A two-tenant fixture for Space-mutation route tests, written into a
 * FakePrisma: one SHARED Space with a member of every role, a second tenant's
 * SHARED Space the first tenant's people have no relationship to, and the
 * owner's PERSONAL Space. Every person gets a live session cookie.
 *
 *   S  (SHARED)   owner OWNER · admin ADMIN · member MEMBER · viewer VIEWER · former LEFT
 *   T  (SHARED)   stranger OWNER · strangerMember MEMBER        ← the other tenant
 *   P  (PERSONAL) owner OWNER
 *
 * ⚠️ TEST-ONLY.
 */

import { freshCache, signIn, type SignedIn } from "./route-harness";
import type { FakePrisma } from "./fake-prisma";

export const PEOPLE = ["owner", "admin", "member", "viewer", "former", "stranger", "strangerMember", "loner"] as const;
export type Person = (typeof PEOPLE)[number];

export interface SpaceWorld {
  ids: Record<Person, string>;
  as: Record<Person, SignedIn>;
  S: string;
  T: string;
  P: string;
}

export async function spaceWorld(fake: FakePrisma): Promise<SpaceWorld> {
  fake.reset();
  freshCache();
  const ids = {} as Record<Person, string>;
  for (const p of PEOPLE) {
    const u = fake.seed("User", {
      email: `${p.toLowerCase()}@example.test`, username: p.toLowerCase(), firstName: p[0].toUpperCase() + p.slice(1), lastName: "Test",
      passwordHash: "x", emailVerifiedAt: new Date(),
    });
    ids[p] = u.id as string;
  }
  const S = fake.seed("Space", { name: "Household", type: "SHARED", category: "HOUSEHOLD" }).id as string;
  const T = fake.seed("Space", { name: "Other Tenant", type: "SHARED", category: "HOUSEHOLD" }).id as string;
  const P = fake.seed("Space", { name: "Owner's Space", type: "PERSONAL", category: "PERSONAL" }).id as string;
  const member = (spaceId: string, who: Person, role: string, status = "ACTIVE") =>
    fake.seed("SpaceMember", { spaceId, userId: ids[who], role, status });
  member(S, "owner", "OWNER"); member(S, "admin", "ADMIN"); member(S, "member", "MEMBER"); member(S, "viewer", "VIEWER");
  member(S, "former", "MEMBER", "LEFT");
  member(T, "stranger", "OWNER"); member(T, "strangerMember", "MEMBER");
  member(P, "owner", "OWNER");
  const as = {} as Record<Person, SignedIn>;
  for (const p of PEOPLE) as[p] = await signIn(fake, ids[p]);
  return { ids, as, S, T, P };
}
