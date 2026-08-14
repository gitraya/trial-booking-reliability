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

  it("counts a seat only once when the pay button is double-clicked", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Impatient");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");

    const results = await Promise.allSettled([
      confirmBooking(created.bookingId, "succeed"),
      confirmBooking(created.bookingId, "succeed"),
    ]);

    const confirmed = results.filter(
      (r) => r.status === "fulfilled" && r.value.status === "CONFIRMED",
    );
    expect(confirmed).toHaveLength(1);
    expect(await seatCount(trialClass.id)).toBe(1);
    await assertNoDrift(trialClass.id);
  });
});
