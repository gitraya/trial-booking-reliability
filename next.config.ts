import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root; otherwise Turbopack walks up and picks up an
  // unrelated lockfile in a parent directory.
  turbopack: { root: import.meta.dirname },

  // The generated Prisma client is TypeScript source, not a prebuilt package.
  // Keep it out of the server bundle trace rewrite so it resolves normally.
  serverExternalPackages: ["@prisma/adapter-pg"],
};

export default nextConfig;
