import { PrismaClient } from "@prisma/client";

import { runtimeDatasourceUrl } from "@/lib/db/connection-url";
import { assertNonLiveDatabase } from "@/lib/db/live-guard";

// Prevent multiple Prisma Client instances in Next.js dev (hot-reload creates
// new module instances; without this guard you'd exhaust the connection pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// PROD-POOLER-AUTH-INCIDENT-1 — the runtime pool size is owned by
// lib/db/connection-url.ts, NOT by whatever `connection_limit` happens to be in
// the DATABASE_URL env var. Production and Preview both carried an accidental
// `connection_limit=1` (a local troubleshooting leftover), which under Vercel
// Fluid Compute serialised every concurrent request in a process onto ONE
// connection and produced P2024 pool timeouts. Host, port 6543 and
// `pgbouncer=true` are preserved exactly; only the pool size is normalised.
const datasourceUrl = runtimeDatasourceUrl();

// I1 — Slice 0. When `FM_DB_GUARD=clone-only` is set, this process may reach a
// clone and nothing else; anything it cannot identify as one is refused here,
// BEFORE a client exists, so a write-capable script cannot reach a query against
// live. Inert when the variable is unset, which is every ordinary runtime.
//
// ⚠️ IT CHECKS THE RESOLVED URL, NOT THE ENV FILE. An exported DATABASE_URL beats
// `--env-file`; that precedence is the mechanism behind the post-M1 incident, and
// a guard that read a file rather than the value in force would have missed it.
assertNonLiveDatabase(datasourceUrl ?? process.env.DATABASE_URL);

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    // Omitted entirely when DATABASE_URL is unset, so Prisma still raises its
    // own (clearer) missing-configuration error rather than one from here.
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
