import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { confirmBooking, createBooking } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";
import { assertNoDrift, makeClass, makeStudent, resetDb, seatCount } from "./helpers";

/** docs/PRD.md §12.3 — a failed payment must never reach the roster. */
describe("payment failure", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it("marks the booking PAYMENT_FAILED and leaves the seat count untouched", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 1 });
    const student = await makeStudent("Declined card");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");

    const result = await confirmBooking(created.bookingId, "fail");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("PAYMENT_FAILED");
    expect(await seatCount(trialClass.id)).toBe(1);
    await assertNoDrift(trialClass.id);
  });

  it("keeps a failed booking off the roster", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Not on roster");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");
    await confirmBooking(created.bookingId, "fail");

    const roster = await prisma.booking.findMany({
      where: { classId: trialClass.id, status: "CONFIRMED" },
    });
    expect(roster).toHaveLength(0);
  });

  it("records a FAILED payment attempt for the audit trail", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Audit trail");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");
    await confirmBooking(created.bookingId, "fail");

    const attempts = await prisma.paymentAttempt.findMany({
      where: { bookingId: created.bookingId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("FAILED");
  });

  it("refuses to pay for a booking that is not PENDING_PAYMENT", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Already paid");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");
    await confirmBooking(created.bookingId, "succeed");

    const again = await confirmBooking(created.bookingId, "succeed");
    expect(again.status).toBe("INVALID");
    expect(await seatCount(trialClass.id)).toBe(1); // not double-counted
    await assertNoDrift(trialClass.id);
  });

  // Two concurrent calls do NOT reproduce the bug this guards against — they
  // usually serialize by luck. Eight against a class with room to spare does,
  // reliably: before the FOR UPDATE claim in confirmBooking, this produced 8
  // confirmations, 8 seats and 8 charges for ONE booking. Keep the count high
  // and the capacity above it, or the test goes back to passing for the wrong
  // reason.
  it("counts a seat and a charge only once when the pay button is spammed", async () => {
    const trialClass = await makeClass({ capacity: 10, confirmedCount: 0 });
    const student = await makeStudent("Impatient");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => confirmBooking(created.bookingId, "succeed")),
    );

    const confirmed = results.filter(
      (r) => r.status === "fulfilled" && r.value.status === "CONFIRMED",
    );
    expect(confirmed).toHaveLength(1);
    expect(await seatCount(trialClass.id)).toBe(1);

    // One booking must never accumulate multiple payment records.
    expect(
      await prisma.paymentAttempt.count({ where: { bookingId: created.bookingId } }),
    ).toBe(1);

    await assertNoDrift(trialClass.id);
  });

  it("keeps the seat count right when a full class is spammed", async () => {
    // Same spam, but every payer loses: the booking claim must hold even when
    // the seat claim would fail anyway.
    const trialClass = await makeClass({ capacity: 2, confirmedCount: 2 });
    const student = await makeStudent("Too late but persistent");

    const booking = await prisma.booking.create({
      data: {
        studentId: student.id,
        classId: trialClass.id,
        status: "PENDING_PAYMENT",
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => confirmBooking(booking.id, "succeed")),
    );

    expect(
      results.filter(
        (r) => r.status === "fulfilled" && r.value.status === "SEAT_UNAVAILABLE",
      ),
    ).toHaveLength(1);
    expect(await seatCount(trialClass.id)).toBe(2);
    expect(
      await prisma.paymentAttempt.count({ where: { bookingId: booking.id } }),
    ).toBe(1);
    await assertNoDrift(trialClass.id);
  });
});
