"use client";

import { useActionState } from "react";
import { bookAndPayAction, type ActionState } from "./actions";

type Student = { id: string; name: string };

/**
 * Booking form. The payment outcome selector exists so the failure path and
 * the last-seat race are demonstrable on camera — see docs/PRD.md §2.
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
    bookAndPayAction,
    null,
  );

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

        <button type="submit" disabled={pending || students.length === 0}>
          {pending ? "Processing…" : full ? "Book anyway (class is full)" : "Book & pay"}
        </button>
      </form>

      {state && <p className={`msg ${state.tone}`}>{state.message}</p>}
    </>
  );
}
