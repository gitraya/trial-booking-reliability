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
      <button type="submit" className="ghost" disabled={pending}>
        {pending ? "…" : "Cancel seat"}
      </button>
      {state?.tone === "error" && (
        <span className="msg error">
          <span className="icon" aria-hidden="true">
            !
          </span>
          {state.message}
        </span>
      )}
    </form>
  );
}
