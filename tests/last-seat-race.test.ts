import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { confirmBooking, createBooking } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";
import { assertNoDrift, makeClass, makeStudent, resetDb, seatCount } from "./helpers";

/**
 * The test the whole project exists to pass (docs/PRD.md §12.1).
 *
 * Runs against real Postgres — the guarantee under test is Postgres's
 * row-level write atomicity, which a mocked database cannot reproduce.
 */
describe("the last-seat race", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it("gives the last seat to exactly one of two simultaneous payers", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 3 });
    const userA = await makeStudent("User A");
    const userB = await makeStudent("User B");

    // Both parents legitimately reach the payment step — no seat is held at
    // booking-creation time, by design.
    const bookingA = await createBooking(userA.id, trialClass.id);
    const bookingB = await createBooking(userB.id, trialClass.id);
    expect(bookingA.ok).toBe(true);
    expect(bookingB.ok).toBe(true);
    if (!bookingA.ok || !bookingB.ok) return;

    expect(await seatCount(trialClass.id)).toBe(3); // still 3: creation claims nothing

    // Both payments succeed. Only one seat exists.
    const [resultA, resultB] = await Promise.all([
      confirmBooking(bookingA.bookingId, "succeed"),
      confirmBooking(bookingB.bookingId, "succeed"),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(["CONFIRMED", "SEAT_UNAVAILABLE"]);

    expect(await seatCount(trialClass.id)).toBe(4);
    await assertNoDrift(trialClass.id);
  });

  // This one, not the two-payer test above, is what actually catches a
  // check-then-act regression. Verified by swapping the atomic UPDATE for a
  // read-then-update: the two-payer test still passed, while this one
  // confirmed 7 bookings into a 2-seat class. Don't delete it.
  it("never overbooks with ten simultaneous payers and two seats", async () => {
    const trialClass = await makeClass({ capacity: 10, confirmedCount: 8 });

    const bookingIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const student = await makeStudent(`Racer ${i}`);
      const created = await createBooking(student.id, trialClass.id);
      expect(created.ok).toBe(true);
      if (created.ok) bookingIds.push(created.bookingId);
    }

    const results = await Promise.all(
      bookingIds.map((id) => confirmBooking(id, "succeed")),
    );

    const confirmed = results.filter((r) => r.status === "CONFIRMED");
    const lostRace = results.filter((r) => r.status === "SEAT_UNAVAILABLE");

    expect(confirmed).toHaveLength(2); // exactly the two remaining seats
    expect(lostRace).toHaveLength(8);
    expect(await seatCount(trialClass.id)).toBe(10);
    await assertNoDrift(trialClass.id);
  });

  it("releases the seat back when a confirmed booking is cancelled", async () => {
    const { cancelBooking } = await import("@/lib/bookings");
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 3 });
    const student = await makeStudent("Canceller");

    const created = await createBooking(student.id, trialClass.id);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await confirmBooking(created.bookingId, "succeed");
    expect(await seatCount(trialClass.id)).toBe(4);

    await cancelBooking(created.bookingId);
    expect(await seatCount(trialClass.id)).toBe(3);
    await assertNoDrift(trialClass.id);
  });

  it("does not double-release a seat when the same booking is cancelled twice", async () => {
    const { cancelBooking } = await import("@/lib/bookings");
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 2 });
    const student = await makeStudent("Double canceller");

    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) throw new Error("setup failed");
    await confirmBooking(created.bookingId, "succeed");
    expect(await seatCount(trialClass.id)).toBe(3);

    const outcomes = await Promise.allSettled([
      cancelBooking(created.bookingId),
      cancelBooking(created.bookingId),
    ]);
    // One cancel wins; the other either reports "already cancelled" or aborts
    // on a write conflict. Either way the seat is released exactly once.
    expect(outcomes.some((o) => o.status === "fulfilled" && o.value.ok)).toBe(true);

    expect(await seatCount(trialClass.id)).toBe(2);
    await assertNoDrift(trialClass.id);
  });
});
