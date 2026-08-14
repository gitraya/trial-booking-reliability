import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/classes/[id]/roster
 *
 * The roster is derived from CONFIRMED bookings only — a pending, failed, or
 * seat-unavailable booking never appears here.
 *
 * The response also reports `reconciliation`, comparing the denormalized
 * confirmedCount against an actual COUNT(*) of confirmed bookings. That is the
 * drift check from docs/PRD.md §10, surfaced on the endpoint so it is trivial
 * to verify the invariant by hand (or from a monitor).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const trialClass = await prisma.trialClass.findUnique({
    where: { id },
    include: {
      bookings: {
        where: { status: "CONFIRMED" },
        orderBy: { createdAt: "asc" },
        include: { student: { include: { parent: true } } },
      },
    },
  });

  if (!trialClass) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }

  const actualConfirmed = trialClass.bookings.length;

  return NextResponse.json({
    class: {
      id: trialClass.id,
      subject: trialClass.subject,
      startsAt: trialClass.startsAt,
      capacity: trialClass.capacity,
      confirmedCount: trialClass.confirmedCount,
      seatsRemaining: trialClass.capacity - trialClass.confirmedCount,
    },
    roster: trialClass.bookings.map((booking) => ({
      bookingId: booking.id,
      studentId: booking.student.id,
      studentName: booking.student.name,
      parentName: booking.student.parent.name,
      parentEmail: booking.student.parent.email,
      confirmedAt: booking.updatedAt,
    })),
    reconciliation: {
      confirmedCount: trialClass.confirmedCount,
      actualConfirmedBookings: actualConfirmed,
      inSync: trialClass.confirmedCount === actualConfirmed,
    },
  });
}
