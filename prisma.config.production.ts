import { defineConfig } from "prisma/config";

/**
 * Prisma config for the runtime container (copied in as prisma.config.ts by the
 * Dockerfile).
 *
 * Identical to the development prisma.config.ts except that it does NOT import
 * "dotenv/config": in a container the environment is supplied by Coolify, there
 * is no .env file, and dotenv is not present in the runtime image.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
