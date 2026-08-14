"use client";

import { useActionState } from "react";
import { bookingAction, type ActionState } from "./actions";

type Student = { id: string; name: string };

/**
 * Booking form.
 *
 * Two submit buttons share one action; the `intent` is carried by the button's
 * own name/value. "Reserve" stops at PENDING_PAYMENT so the payment step can be
 * triggered separately — that is what makes the last-seat race demonstrable
 * from the UI. The payment outcome selector exists so the failure path is
 * deterministic. See docs/PRD.md §2.
 */
export function BookForm({
  classId,
  students,
  full,
}: {
  classId: string;
  students: Student[];
  full: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    bookingAction,
    null,
  );
  const disabled = pending || students.length === 0;

  return (
    <>
      <form action={formAction} className="book">
        <input type="hidden" name="classId" value={classId} />

        <select name="studentId" aria-label="Student" defaultValue={students[0]?.id}>
          {students.map((student) => (
            <option key={student.id} value={student.id}>
              {student.name}
            </option>
          ))}
        </select>

        <select name="outcome" aria-label="Payment outcome" defaultValue="succeed">
          <option value="succeed">Payment succeeds</option>
          <option value="fail">Payment fails</option>
          <option value="random">Random (~85% success)</option>
        </select>

        <button type="submit" name="intent" value="book" className={full ? "secondary" : ""} disabled={disabled}>
          {pending ? "Processing…" : full ? "Join anyway (class is full)" : "Book & pay"}
        </button>

        <button type="submit" name="intent" value="reserve" className="ghost" disabled={disabled}>
          Reserve only
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
    </>
  );
}
