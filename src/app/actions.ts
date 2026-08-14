"use server";

import { revalidatePath } from "next/cache";
import { cancelBooking, confirmBooking, createBooking } from "@/lib/bookings";
import { createTrialClass } from "@/lib/classes";
import type { PaymentOutcome } from "@/lib/payment";

/**
 * Server actions are the backend for the booking UI. They orchestrate; the
 * correctness guarantees live in src/lib/bookings.ts and the database.
 *
 * No auth: identity comes from a query-param stub. See docs/PRD.md §9.
 */

export type ActionState = { message: string; tone: "ok" | "error" } | null;

function forcedOutcome(value: FormDataEntryValue | null): PaymentOutcome | undefined {
  return value === "succeed" || value === "fail" ? value : undefined;
}

/**
 * Handles both halves of the booking flow, selected by the `intent` field —
 * which is carried by the submit button's own name/value.
 *
 * `reserve` stops at PENDING_PAYMENT without paying. That is what makes the
 * last-seat race reproducible from the UI: reserve as two different parents,
 * then pay both. `book` is the one-step convenience path.
 */
export async function bookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const studentId = String(formData.get("studentId") ?? "");
  const classId = String(formData.get("classId") ?? "");
  const reserveOnly = formData.get("intent") === "reserve";

  if (!studentId || !classId) {
    return { message: "Pick a student and a class.", tone: "error" };
  }

  const created = await createBooking(studentId, classId);
  if (!created.ok) {
    return { message: created.message, tone: "error" };
  }

  if (reserveOnly) {
    revalidatePath("/");
    revalidatePath("/admin");
    return {
      message:
        "Reserved — awaiting payment. No seat is held yet; it is claimed when you pay.",
      tone: "ok",
    };
  }

  const confirmed = await confirmBooking(
    created.bookingId,
    forcedOutcome(formData.get("outcome")),
  );
  revalidatePath("/");
  revalidatePath("/admin");

  return confirmed.ok
    ? { message: "Booking confirmed — the seat is yours.", tone: "ok" }
    : { message: confirmed.message, tone: "error" };
}

/** Pay for a booking that is already sitting in PENDING_PAYMENT. */
export async function payBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return { message: "Missing booking.", tone: "error" };

  const result = await confirmBooking(bookingId, forcedOutcome(formData.get("outcome")));
  revalidatePath("/");
  revalidatePath("/admin");

  return result.ok
    ? { message: "Payment taken — seat confirmed.", tone: "ok" }
    : { message: result.message, tone: "error" };
}

/**
 * Admin: create an extra trial class for testing, on top of the seed fixtures.
 * Capacity is settable; the seat counter is not — see createTrialClass.
 */
export async function createClassAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await createTrialClass({
    subject: String(formData.get("subject") ?? ""),
    startsAt: String(formData.get("startsAt") ?? ""),
    capacity: String(formData.get("capacity") ?? ""),
  });

  if (!result.ok) {
    return { message: result.message, tone: "error" };
  }

  revalidatePath("/");
  revalidatePath("/admin");
  return { message: `Created "${result.subject}" — it now appears for parents.`, tone: "ok" };
}

export async function cancelBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return { message: "Missing booking.", tone: "error" };

  const result = await cancelBooking(bookingId);
  revalidatePath("/");
  revalidatePath("/admin");
  return { message: result.message, tone: result.ok ? "ok" : "error" };
}
