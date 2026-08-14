import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Wipe every table, respecting foreign keys. */
export async function resetDb() {
  await prisma.paymentAttempt.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.student.deleteMany();
  await prisma.trialClass.deleteMany();
  await prisma.parent.deleteMany();
}

/** Create a parent with one student and return the student. */
export async function makeStudent(name: string) {
  const parent = await prisma.parent.create({
    data: { name: `${name}'s parent`, email: `${randomUUID()}@example.com` },
  });
  return prisma.student.create({ data: { name, parentId: parent.id } });
}

/**
 * Create a class already holding `confirmedCount` real CONFIRMED bookings, so
 * the counter and the booking rows agree — the same invariant production is
 * expected to hold.
 */
export async function makeClass(opts: {
  capacity: number;
  confirmedCount: number;
  subject?: string;
}) {
  const trialClass = await prisma.trialClass.create({
    data: {
      subject: opts.subject ?? "Test Class",
      startsAt: new Date(Date.now() + 86_400_000),
      capacity: opts.capacity,
      confirmedCount: opts.confirmedCount,
    },
  });

  for (let i = 0; i < opts.confirmedCount; i++) {
    const filler = await makeStudent(`Filler ${i}`);
    await prisma.booking.create({
      data: {
        studentId: filler.id,
        classId: trialClass.id,
        status: "CONFIRMED",
      },
    });
  }
  return trialClass;
}

/** Re-read a class's seat counter. */
export async function seatCount(classId: string) {
  const row = await prisma.trialClass.findUniqueOrThrow({ where: { id: classId } });
  return row.confirmedCount;
}

/**
 * The reconciliation check from docs/PRD.md §10: the denormalized counter must
 * equal the number of CONFIRMED bookings. Any drift means the invariant broke.
 */
export async function assertNoDrift(classId: string) {
  const row = await prisma.trialClass.findUniqueOrThrow({ where: { id: classId } });
  const actual = await prisma.booking.count({
    where: { classId, status: "CONFIRMED" },
  });
  if (row.confirmedCount !== actual) {
    throw new Error(
      `confirmedCount drift on class ${classId}: counter=${row.confirmedCount}, ` +
        `actual CONFIRMED bookings=${actual}`,
    );
  }
  if (row.confirmedCount > row.capacity) {
    throw new Error(
      `OVERBOOKED class ${classId}: ${row.confirmedCount} confirmed > capacity ${row.capacity}`,
    );
  }
}
