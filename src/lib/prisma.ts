import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 talks to Postgres through a driver adapter.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env from the repo root, or run `npm run db:up` first.",
  );
}

const createClient = () =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Next.js dev-mode hot reload re-evaluates modules; without this the process
// accumulates connection pools until Postgres refuses new connections.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createClient>;
};

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
