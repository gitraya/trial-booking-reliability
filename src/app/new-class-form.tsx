"use client";

import { useActionState } from "react";
import { MAX_CLASS_CAPACITY } from "@/lib/config";
import { createClassAction, type ActionState } from "./actions";

/**
 * Admin form for creating an extra trial class beyond the seed fixtures.
 *
 * There is no field for the seat counter on purpose: it always starts at 0 and
 * only moves through the booking flow. To rehearse the last-seat race, create a
 * class with capacity 1 — then two parents reserving it are racing for the only
 * seat, with no setup needed.
 */
export function NewClassForm({ defaultStartsAt }: { defaultStartsAt: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createClassAction,
    null,
  );

  return (
    <div className="card">
      <div className="subject" style={{ marginBottom: ".2rem" }}>
        <span className="subject-emoji" aria-hidden="true">
          ➕
        </span>
        Create a trial class
      </div>
      <p className="when" style={{ marginBottom: ".9rem" }}>
        For testing beyond the seed data. Capacity <strong>1</strong> makes the
        last-seat race a two-click demo.
      </p>

      <form action={formAction} className="new-class">
        <label>
          <span>Subject</span>
          <input
            name="subject"
            type="text"
            required
            maxLength={80}
            placeholder="Primary 5 Science"
            defaultValue=""
          />
        </label>

        <label>
          <span>Starts at</span>
          <input
            name="startsAt"
            type="datetime-local"
            required
            defaultValue={defaultStartsAt}
          />
        </label>

        <label className="narrow">
          <span>Capacity</span>
          <input
            name="capacity"
            type="number"
            min={1}
            max={MAX_CLASS_CAPACITY}
            required
            defaultValue={1}
          />
        </label>

        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create class"}
        </button>
      </form>

      {state && (
        <p className={`msg ${state.tone}`}>
          <span className="icon" aria-hidden="true">
            {state.tone === "ok" ? "✓" : "!"}
          </span>
          {state.message}
        </p>
      )}
    </div>
  );
}
