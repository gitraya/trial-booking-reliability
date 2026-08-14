"use client";

import { useActionState } from "react";
import { payBookingAction, type ActionState } from "./actions";

/**
 * Pay for a booking already sitting in PENDING_PAYMENT.
 *
 * Reserve two of these against a class with one seat left, then pay both, and
 * the roster still comes out right — one CONFIRMED, one SEAT_UNAVAILABLE.
 */
export function PayForm({ bookingId }: { bookingId: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    payBookingAction,
    null,
  );

  return (
    <>
      <form action={formAction} className="pay">
        <input type="hidden" name="bookingId" value={bookingId} />
        <select name="outcome" aria-label="Payment outcome" defaultValue="succeed">
          <option value="succeed">succeeds</option>
          <option value="fail">fails</option>
          <option value="random">random</option>
        </select>
        <button type="submit" disabled={pending}>
          {pending ? "Paying…" : "Pay now"}
        </button>
      </form>
      {state && (
        <span className={`msg ${state.tone} inline`}>
          <span className="icon" aria-hidden="true">
            {state.tone === "ok" ? "✓" : "!"}
          </span>
          {state.message}
        </span>
      )}
    </>
  );
}
