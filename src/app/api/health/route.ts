import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness + database reachability.
 *
 * Used as the Coolify health check. It deliberately touches the database:
 * this app is useless without Postgres, so a container that cannot reach it
 * should not be reported healthy.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "up" });
  } catch (error) {
    console.error("[health] database unreachable:", error);
    return NextResponse.json(
      { status: "error", database: "down" },
      { status: 503 },
    );
  }
}
