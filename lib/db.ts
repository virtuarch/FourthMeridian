import { PrismaClient } from "@prisma/client";

// Prevent multiple Prisma Client instances in Next.js dev (hot-reload creates
// new module instances; without this guard you'd exhaust the connection pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
