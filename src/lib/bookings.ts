import { Prisma } from "@/generated/prisma/client";
import { TRIAL_PRICE } from "@/lib/config";
import { charge, refund, type PaymentOutcome } from "@/lib/payment";
import { prisma } from "@/lib/prisma";

export type CreateBookingResult =
  | { ok: true; bookingId: string }
  | { ok: false; code: "DUPLICATE" | "CLASS_FULL" | "NOT_FOUND"; message: string };

export type ConfirmBookingResult =
  | { ok: true; status: "CONFIRMED"; bookingId: string }
  | {
      ok: false;
      status: "PAYMENT_FAILED" | "SEAT_UNAVAILABLE";
      bookingId: string;
      message: string;
    }
  | { ok: false; status: "INVALID"; bookingId: string; message: string };

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Create a PENDING_PAYMENT booking.
 *
 * Deliberately does NOT touch confirmedCount — no seat is reserved here. Two
 * parents are both allowed to reach the payment step for one remaining seat;
 * the seat is claimed at confirmation time. See docs/PRD.md §5.3.
 */
export async function createBooking(
  studentId: string,
  classId: string,
): Promise<CreateBookingResult> {
  const trialClass = await prisma.trialClass.findUnique({ where: { id: classId } });
  if (!trialClass) {
    return { ok: false, code: "NOT_FOUND", message: "That class does not exist." };
  }

  // Soft UX check only. This is NOT load-bearing: it can race under concurrent
  // double-clicks, and the class can fill between here and confirmation. The
  // authoritative guards are the partial unique index (duplicates) and the
  // atomic UPDATE in confirmBooking (seats).
  if (trialClass.confirmedCount >= trialClass.capacity) {
    return {
      ok: false,
      code: "CLASS_FULL",
      message: "This class is already full.",
    };
  }

  try {
    const booking = await prisma.booking.create({
      data: { studentId, classId, status: "PENDING_PAYMENT" },
    });
    return { ok: true, bookingId: booking.id };
  } catch (error) {
    // The authoritative duplicate guard: the partial unique index
    // booking_active_unique rejects a second live booking for this
    // (student, class) pair. See docs/PRD.md §6.
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        code: "DUPLICATE",
        message: "This student already has a booking for this class.",
      };
    }
    throw error;
  }
}

/**
 * Take payment for a PENDING_PAYMENT booking and, if it succeeds, atomically
 * claim a seat.
 *
 * This is the core of the project. The seat claim is a single conditional
 * UPDATE whose WHERE clause and write are evaluated atomically by Postgres
 * against the row's current committed value. There is no application-level
 * "is there room?" check anywhere in this path — that would be a check-then-act
 * race. See docs/PRD.md §5.
 */
export async function confirmBooking(
  bookingId: string,
  forcedOutcome?: PaymentOutcome,
): Promise<ConfirmBookingResult> {
  // The charge happens OUTSIDE the transaction on purpose: a real gateway call
  // is slow network I/O, and holding a database transaction open across it
  // would pin a connection and widen the window for lock contention.
  const existing = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!existing) {
    return {
      ok: false,
      status: "INVALID",
      bookingId,
      message: "Booking not found.",
    };
  }
  if (existing.status !== "PENDING_PAYMENT") {
    return {
      ok: false,
      status: "INVALID",
      bookingId,
      message: `Booking is ${existing.status}, not payable.`,
    };
  }

  const payment = await charge(bookingId, forcedOutcome);

  const result = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction. Guards against two concurrent
    // confirmBooking calls for the SAME booking (a double-clicked pay button)
    // both getting past the pre-charge check above.
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (booking.status !== "PENDING_PAYMENT") {
      return {
        ok: false as const,
        status: "INVALID" as const,
        bookingId,
        message: `Booking is ${booking.status}, not payable.`,
      };
    }

    await tx.paymentAttempt.create({
      data: {
        bookingId,
        amount: payment.amount,
        status: payment.outcome === "succeed" ? "SUCCEEDED" : "FAILED",
      },
    });

    if (payment.outcome === "fail") {
      // No seat is claimed, so confirmedCount is untouched — a failed payment
      // can never add anyone to the roster.
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "PAYMENT_FAILED" },
      });
      return {
        ok: false as const,
        status: "PAYMENT_FAILED" as const,
        bookingId,
        message: "Payment failed. No seat was taken — you can try again.",
      };
    }

    // ---- The atomic seat claim ----------------------------------------
    // Postgres evaluates this UPDATE's WHERE clause and its write as one
    // atomic unit against the row's current committed value. Two concurrent
    // transactions racing for the last seat serialize here: the second one
    // re-checks the predicate against the first's committed value, sees
    // confirmedCount == capacity, and matches zero rows. No explicit lock,
    // no elevated isolation level, no deadlock risk.
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "TrialClass"
      SET "confirmedCount" = "confirmedCount" + 1
      WHERE id = ${booking.classId} AND "confirmedCount" < capacity
      RETURNING id
    `;

    if (claimed.length === 0) {
      // Payment succeeded but the seat is gone. Money moved; the seat did not.
      // This is a genuinely different outcome from PAYMENT_FAILED and is kept
      // separate on purpose. See docs/PRD.md §4.
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "SEAT_UNAVAILABLE" },
      });
      return {
        ok: false as const,
        status: "SEAT_UNAVAILABLE" as const,
        bookingId,
        message:
          "Payment went through, but the last seat was taken first. " +
          "A refund has been queued.",
      };
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: { status: "CONFIRMED" },
    });
    return { ok: true as const, status: "CONFIRMED" as const, bookingId };
  });

  if (result.status === "SEAT_UNAVAILABLE") {
    refund(bookingId, payment.amount);
  }
  return result;
}

/**
 * Cancel a CONFIRMED booking and release its seat.
 *
 * The decrement is guarded by `confirmedCount > 0` and runs in the same
 * transaction as the status change, so the counter can never drift below zero
 * or be decremented twice for one booking.
 */
export async function cancelBooking(
  bookingId: string,
): Promise<{ ok: boolean; message: string }> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });

    if (booking.status === "PENDING_PAYMENT") {
      // No seat was ever claimed, so nothing to give back.
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      });
      return { ok: true, message: "Pending booking cancelled." };
    }

    if (booking.status !== "CONFIRMED") {
      return { ok: false, message: `Booking is ${booking.status}, not cancellable.` };
    }

    // Conditionally scope the status change to CONFIRMED so two concurrent
    // cancels of the same booking cannot both release a seat.
    const released = await tx.$executeRaw`
      UPDATE "Booking" SET "status" = 'CANCELLED', "updatedAt" = NOW()
      WHERE id = ${bookingId} AND "status" = 'CONFIRMED'
    `;
    if (released === 0) {
      return { ok: false, message: "Booking was already cancelled." };
    }

    await tx.$executeRaw`
      UPDATE "TrialClass"
      SET "confirmedCount" = "confirmedCount" - 1
      WHERE id = ${booking.classId} AND "confirmedCount" > 0
    `;
    return { ok: true, message: "Booking cancelled and the seat released." };
  });
}

/** Convenience for the demo: create a booking and immediately pay for it. */
export async function bookAndPay(
  studentId: string,
  classId: string,
  forcedOutcome?: PaymentOutcome,
): Promise<CreateBookingResult | ConfirmBookingResult> {
  const created = await createBooking(studentId, classId);
  if (!created.ok) return created;
  return confirmBooking(created.bookingId, forcedOutcome);
}

export { TRIAL_PRICE };
