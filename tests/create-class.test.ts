import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { confirmBooking, createBooking } from "@/lib/bookings";
import { createTrialClass } from "@/lib/classes";
import { prisma } from "@/lib/prisma";
import { assertNoDrift, makeStudent, resetDb, seatCount } from "./helpers";

const validInput = {
  subject: "Primary 5 Science",
  startsAt: "2026-09-01T16:00",
  capacity: "4",
};

describe("creating a trial class", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it("creates an empty class", async () => {
    const result = await createTrialClass(validInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const created = await prisma.trialClass.findUniqueOrThrow({
      where: { id: result.classId },
    });
    expect(created.subject).toBe("Primary 5 Science");
    expect(created.capacity).toBe(4);
    expect(created.confirmedCount).toBe(0);
    await assertNoDrift(created.id);
  });

  it("always starts the seat counter at zero", async () => {
    // The counter is not an input. Even if something smuggles one in, it must
    // not land in the row — a class whose counter disagrees with its bookings
    // is exactly the drift the reconciliation check exists to catch.
    const result = await createTrialClass({
      ...validInput,
      ...({ confirmedCount: 3 } as object),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await seatCount(result.classId)).toBe(0);
    await assertNoDrift(result.classId);
  });

  it("trims the subject and rejects a blank one", async () => {
    const padded = await createTrialClass({ ...validInput, subject: "  Art Trial  " });
    expect(padded.ok).toBe(true);
    if (padded.ok) expect(padded.subject).toBe("Art Trial");

    for (const subject of ["", "   "]) {
      const result = await createTrialClass({ ...validInput, subject });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects capacities that are not a sensible whole number", async () => {
    for (const capacity of ["0", "-3", "2.5", "abc", "", "   ", "51"]) {
      const result = await createTrialClass({ ...validInput, capacity });
      expect(result.ok, `capacity ${JSON.stringify(capacity)} should be rejected`).toBe(
        false,
      );
    }
    expect(await prisma.trialClass.count()).toBe(0);
  });

  it("rejects a missing or unparseable start time", async () => {
    for (const startsAt of ["", "   ", "not-a-date"]) {
      const result = await createTrialClass({ ...validInput, startsAt });
      expect(result.ok).toBe(false);
    }
  });

  it("a capacity-1 class is a complete last-seat race fixture", async () => {
    // The reason the form defaults to 1: no setup needed, two reservations are
    // immediately racing for the only seat.
    const created = await createTrialClass({ ...validInput, capacity: "1" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const a = await makeStudent("Racer A");
    const b = await makeStudent("Racer B");
    const bookingA = await createBooking(a.id, created.classId);
    const bookingB = await createBooking(b.id, created.classId);
    if (!bookingA.ok || !bookingB.ok) throw new Error("setup failed");

    const results = await Promise.all([
      confirmBooking(bookingA.bookingId, "succeed"),
      confirmBooking(bookingB.bookingId, "succeed"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "CONFIRMED",
      "SEAT_UNAVAILABLE",
    ]);
    expect(await seatCount(created.classId)).toBe(1);
    await assertNoDrift(created.classId);
  });
});
