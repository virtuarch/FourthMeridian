/**
 * app/api/spaces/[id]/sections/[sectionId]/route.test.ts  (TEST-002)
 *
 * PATCH a dashboard section — REAL exported handler, real session cookies,
 * in-memory Prisma fake, two-tenant world. ADMIN+ of THIS Space edits THIS
 * Space's sections.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/sections/[sectionId]/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";

const t = makeChecker("PATCH /api/spaces/[id]/sections/[sectionId] (TEST-002)");
const fake = new FakePrisma();
let PATCH: typeof import("./route").PATCH;
let w: SpaceWorld;
const edit = (by: Person | null, spaceId: string, sectionId: string, body: unknown) =>
  invoke(PATCH, request(`/api/spaces/${spaceId}/sections/${sectionId}`, { method: "PATCH", cookie: by ? w.as[by].cookie : null, body }), { id: spaceId, sectionId });
const section = (spaceId: string, key: string) =>
  fake.seed("SpaceDashboardSection", { spaceId, key, label: key, enabled: true, order: 1, config: { window: "3m" } }).id as string;
const row = (id: string) => fake.one("SpaceDashboardSection", { id })!;

async function main() {
  await installFakePrisma(fake);
  ({ PATCH } = await import("./route"));

  t.section("1. an ADMIN edits a section of their Space");
  {
    w = await spaceWorld(fake);
    const id = section(w.S, "net_worth");
    const r = await edit("admin", w.S, id, { label: "  Wealth  ", enabled: false, order: 4, config: { window: "1y" } });
    t.check("200 with the updated row", r.status === 200 && r.body.label === "Wealth" && r.body.enabled === false && r.body.order === 4, r.body);
    t.check("stored: label trimmed, config replaced", row(id).label === "Wealth" && JSON.stringify(row(id).config) === '{"window":"1y"}');
    const only = await edit("owner", w.S, id, { enabled: true });
    t.check("a partial body changes only what it names", only.status === 200 && row(id).enabled === true && row(id).label === "Wealth" && row(id).order === 4);
    t.check("config: null clears it (DbNull)", (await edit("owner", w.S, id, { config: null })).status === 200 && row(id).config === null);
  }

  t.section("2. refusals");
  {
    w = await spaceWorld(fake);
    const id = section(w.S, "net_worth");
    for (const by of ["member", "viewer", "former", "stranger"] as const) {
      t.check(`${by} → 403, unchanged`, (await edit(by, w.S, id, { label: "x" })).status === 403 && row(id).label === "net_worth");
    }
    t.check("anonymous → 401", (await edit(null, w.S, id, { label: "x" })).status === 401);
    const theirs = section(w.T, "goals");
    const x = await edit("owner", w.S, theirs, { label: "pwned" });
    t.check("T's section id addressed through S (where the caller IS owner) → 404, unchanged", x.status === 404 && row(theirs).label === "goals");
    t.check("an unknown section → 404", (await edit("owner", w.S, "nope", { label: "x" })).status === 404);
  }

  t.section("3. body validation");
  {
    w = await spaceWorld(fake);
    const id = section(w.S, "net_worth");
    const r = await edit("owner", w.S, id, { label: 42 });
    t.check("a non-string label → 400 (J-D5: was an unhandled TypeError from body.label.trim())", r.status === 400, r);
    t.check("…and nothing was written", row(id).label === "net_worth");
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
