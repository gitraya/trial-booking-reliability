import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle so the runtime Docker image doesn't
  // need node_modules. Required by the Dockerfile used for the Coolify deploy.
  output: "standalone",

  // Pin the workspace root; otherwise Turbopack walks up and picks up an
  // unrelated lockfile in a parent directory.
  turbopack: { root: import.meta.dirname },

  // The generated Prisma client is TypeScript source, not a prebuilt package.
  // Keep it out of the server bundle trace rewrite so it resolves normally.
  serverExternalPackages: ["@prisma/adapter-pg"],
};

export default nextConfig;
