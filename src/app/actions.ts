"use server";

import { revalidatePath } from "next/cache";
import { cancelBooking, confirmBooking, createBooking } from "@/lib/bookings";
import type { PaymentOutcome } from "@/lib/payment";

/**
 * Server actions are the backend for the booking UI. They orchestrate; the
 * correctness guarantees live in src/lib/bookings.ts and the database.
 *
 * No auth: identity comes from a query-param stub. See docs/PRD.md §9.
 */

export type ActionState = { message: string; tone: "ok" | "error" } | null;

export async function bookAndPayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const studentId = String(formData.get("studentId") ?? "");
  const classId = String(formData.get("classId") ?? "");
  const outcome = formData.get("outcome");
  const forced: PaymentOutcome | undefined =
    outcome === "succeed" || outcome === "fail" ? outcome : undefined;

  if (!studentId || !classId) {
    return { message: "Pick a student and a class.", tone: "error" };
  }

  const created = await createBooking(studentId, classId);
  if (!created.ok) {
    return { message: created.message, tone: "error" };
  }

  const confirmed = await confirmBooking(created.bookingId, forced);
  revalidatePath("/");
  revalidatePath("/admin");

  if (confirmed.ok) {
    return { message: "Booking confirmed — the seat is yours.", tone: "ok" };
  }
  return { message: confirmed.message, tone: "error" };
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
