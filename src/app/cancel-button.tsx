"use client";

import { useActionState } from "react";
import { cancelBookingAction, type ActionState } from "./actions";

export function CancelButton({ bookingId }: { bookingId: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    cancelBookingAction,
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <button type="submit" disabled={pending}>
        {pending ? "…" : "Cancel"}
      </button>
      {state?.tone === "error" && (
        <span className="msg error">{state.message}</span>
      )}
    </form>
  );
}
