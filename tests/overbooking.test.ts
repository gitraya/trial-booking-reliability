import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { confirmBooking, createBooking } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";
import { assertNoDrift, makeClass, makeStudent, resetDb, seatCount } from "./helpers";

/** docs/PRD.md §12.4 and §7. */
describe("overbooking a full class", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it("blocks booking a full class at the soft check", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 4 });
    const student = await makeStudent("Too late");

    const created = await createBooking(student.id, trialClass.id);
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("CLASS_FULL");
  });

  it("still refuses the seat when the soft check is bypassed entirely", async () => {
    // Proves the soft check is not load-bearing. Insert a PENDING_PAYMENT
    // booking directly, skipping createBooking's capacity check, then pay.
    // The atomic UPDATE is the only thing standing between this and an
    // overbooked class — and it holds.
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 4 });
    const student = await makeStudent("Bypasser");

    const booking = await prisma.booking.create({
      data: {
        studentId: student.id,
        classId: trialClass.id,
        status: "PENDING_PAYMENT",
      },
    });

    const result = await confirmBooking(booking.id, "succeed");

    expect(result.status).toBe("SEAT_UNAVAILABLE");
    expect(await seatCount(trialClass.id)).toBe(4); // still 4, never 5
    await assertNoDrift(trialClass.id);
  });

  it("records the successful payment even when the seat is refused", async () => {
    // Money moved. The PaymentAttempt row is what a refund process would key
    // off, and it must exist regardless of the seat outcome.
    const trialClass = await makeClass({ capacity: 2, confirmedCount: 2 });
    const student = await makeStudent("Owed a refund");

    const booking = await prisma.booking.create({
      data: {
        studentId: student.id,
        classId: trialClass.id,
        status: "PENDING_PAYMENT",
      },
    });
    await confirmBooking(booking.id, "succeed");

    const attempts = await prisma.paymentAttempt.findMany({
      where: { bookingId: booking.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("SUCCEEDED");

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe("SEAT_UNAVAILABLE");
  });
});
