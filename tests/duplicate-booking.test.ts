import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cancelBooking, confirmBooking, createBooking } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";
import { assertNoDrift, makeClass, makeStudent, resetDb } from "./helpers";

/** docs/PRD.md §12.2 and §6. */
describe("duplicate booking prevention", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it("rejects a second live booking for the same student and class", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Repeat booker");

    const first = await createBooking(student.id, trialClass.id);
    expect(first.ok).toBe(true);

    const second = await createBooking(student.id, trialClass.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("DUPLICATE");

    expect(
      await prisma.booking.count({ where: { studentId: student.id } }),
    ).toBe(1);
  });

  it("rejects a duplicate even when both requests land simultaneously", async () => {
    // The soft pre-check in createBooking cannot catch this — the partial
    // unique index is what actually holds. This is the double-clicked
    // submit button.
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Double clicker");

    const results = await Promise.all([
      createBooking(student.id, trialClass.id),
      createBooking(student.id, trialClass.id),
      createBooking(student.id, trialClass.id),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && r.code === "DUPLICATE"),
    ).toHaveLength(2);
    expect(
      await prisma.booking.count({ where: { studentId: student.id } }),
    ).toBe(1);
  });

  it("blocks a duplicate against an already CONFIRMED booking", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Confirmed already");

    const first = await createBooking(student.id, trialClass.id);
    if (!first.ok) throw new Error("setup failed");
    await confirmBooking(first.bookingId, "succeed");

    const second = await createBooking(student.id, trialClass.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("DUPLICATE");
  });

  it("allows a retry after payment failed", async () => {
    // PAYMENT_FAILED falls outside the partial index predicate, so the student
    // is free to try again — the whole point of making the index partial.
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Retrier");

    const first = await createBooking(student.id, trialClass.id);
    if (!first.ok) throw new Error("setup failed");
    const failed = await confirmBooking(first.bookingId, "fail");
    expect(failed.status).toBe("PAYMENT_FAILED");

    const retry = await createBooking(student.id, trialClass.id);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    const paid = await confirmBooking(retry.bookingId, "succeed");
    expect(paid.status).toBe("CONFIRMED");
    await assertNoDrift(trialClass.id);
  });

  it("allows a rebooking after a cancellation", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Rebooker");

    const first = await createBooking(student.id, trialClass.id);
    if (!first.ok) throw new Error("setup failed");
    await confirmBooking(first.bookingId, "succeed");
    await cancelBooking(first.bookingId);

    const again = await createBooking(student.id, trialClass.id);
    expect(again.ok).toBe(true);
    await assertNoDrift(trialClass.id);
  });
});
