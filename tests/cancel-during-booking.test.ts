import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cancelBooking, confirmBooking, createBooking } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";
import { assertNoDrift, makeStudent, resetDb, seatCount } from "./helpers";

/**
 * Cancellation racing against payment.
 *
 * Not in the PRD's test list, but it is the one place where two different
 * operations move `confirmedCount` in opposite directions at the same time:
 * `cancelBooking` decrements, `confirmBooking` increments. Everything else in
 * the suite races operations of the same kind against each other.
 *
 * The ordering is allowed to go either way — that is business-visible timing,
 * not a bug. What must never happen is drift, a count above capacity, a count
 * below zero, or a deadlock.
 */

/** Fill a class through the real booking flow, so the counter is honest. */
async function fillClass(classId: string, seats: number) {
  const bookingIds: string[] = [];
  for (let i = 0; i < seats; i++) {
    const student = await makeStudent(`Seated ${i}`);
    const created = await createBooking(student.id, classId);
    if (!created.ok) throw new Error("setup failed");
    const confirmed = await confirmBooking(created.bookingId, "succeed");
    if (!confirmed.ok) throw new Error("setup failed");
    bookingIds.push(created.bookingId);
  }
  return bookingIds;
}

/** A student holding a PENDING_PAYMENT booking on a class that is already full. */
async function waitingBooking(classId: string, name: string) {
  const student = await makeStudent(name);
  const booking = await prisma.booking.create({
    data: { studentId: student.id, classId, status: "PENDING_PAYMENT" },
  });
  return booking.id;
}

describe("admin cancelling while someone else is paying", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it("never lets the freed seat be taken twice", async () => {
    const trialClass = await prisma.trialClass.create({
      data: { subject: "Race", startsAt: new Date(), capacity: 4, confirmedCount: 0 },
    });
    const seated = await fillClass(trialClass.id, 4);

    // Two parents are at the payment step for a class with no seats. The admin
    // frees exactly one seat at that instant.
    const waitingA = await waitingBooking(trialClass.id, "Waiting A");
    const waitingB = await waitingBooking(trialClass.id, "Waiting B");

    await Promise.all([
      cancelBooking(seated[0]),
      confirmBooking(waitingA, "succeed"),
      confirmBooking(waitingB, "succeed"),
    ]);

    // One seat was freed, so at most one of the two can end up confirmed.
    const count = await seatCount(trialClass.id);
    expect(count).toBeLessThanOrEqual(trialClass.capacity);
    await assertNoDrift(trialClass.id);
  });

  it("holds the invariant under heavy two-way contention", async () => {
    // Six cancellations and six payments fired at one class simultaneously.
    const trialClass = await prisma.trialClass.create({
      data: { subject: "Storm", startsAt: new Date(), capacity: 6, confirmedCount: 0 },
    });
    const seated = await fillClass(trialClass.id, 6);

    const waiting: string[] = [];
    for (let i = 0; i < 6; i++) {
      waiting.push(await waitingBooking(trialClass.id, `Waiting ${i}`));
    }

    const results = await Promise.allSettled([
      ...seated.map((id) => cancelBooking(id)),
      ...waiting.map((id) => confirmBooking(id, "succeed")),
    ]);

    // Both paths lock the Booking row before the TrialClass row, so they can
    // never deadlock against each other. A rejection here would mean that
    // ordering was broken and users are seeing 500s under load.
    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected,
      `deadlock or crash: ${rejected.map((r) => String((r as PromiseRejectedResult).reason)).join("; ")}`,
    ).toHaveLength(0);

    const count = await seatCount(trialClass.id);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(trialClass.capacity);
    await assertNoDrift(trialClass.id);
  });

  it("lets a waiting parent take a seat freed before they pay", async () => {
    // The sequential version of the same story: the cancellation lands first,
    // so the waiting parent gets in rather than hitting SEAT_UNAVAILABLE.
    const trialClass = await prisma.trialClass.create({
      data: { subject: "Freed", startsAt: new Date(), capacity: 2, confirmedCount: 0 },
    });
    const seated = await fillClass(trialClass.id, 2);
    const waiting = await waitingBooking(trialClass.id, "Patient parent");

    const cancelled = await cancelBooking(seated[0]);
    expect(cancelled.ok).toBe(true);
    expect(await seatCount(trialClass.id)).toBe(1);

    const confirmed = await confirmBooking(waiting, "succeed");
    expect(confirmed.status).toBe("CONFIRMED");
    expect(await seatCount(trialClass.id)).toBe(2);
    await assertNoDrift(trialClass.id);
  });

  it("cancelling a seat cannot push the counter below zero", async () => {
    // Every cancellation path is guarded by `confirmedCount > 0`; this is the
    // belt-and-braces check that no combination drives it negative.
    const trialClass = await prisma.trialClass.create({
      data: { subject: "Floor", startsAt: new Date(), capacity: 3, confirmedCount: 0 },
    });
    const seated = await fillClass(trialClass.id, 3);

    await Promise.allSettled([
      ...seated.map((id) => cancelBooking(id)),
      ...seated.map((id) => cancelBooking(id)), // each cancelled twice, at once
    ]);

    expect(await seatCount(trialClass.id)).toBe(0);
    await assertNoDrift(trialClass.id);
  });
});
