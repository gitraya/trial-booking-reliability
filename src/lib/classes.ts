import { MAX_CLASS_CAPACITY } from "@/lib/config";
import { prisma } from "@/lib/prisma";

export type CreateClassInput = {
  subject: string;
  startsAt: string;
  capacity: string | number;
};

export type CreateClassResult =
  | { ok: true; classId: string; subject: string }
  | { ok: false; message: string };

const MAX_SUBJECT = 80;

/**
 * Create an empty trial class.
 *
 * `confirmedCount` is deliberately NOT an input and always starts at 0. It is
 * the denormalized seat counter, and the invariant the whole project rests on
 * is that it equals COUNT(*) of CONFIRMED bookings. Letting an admin type a
 * starting value would manufacture drift on purpose — the exact failure the
 * reconciliation check exists to detect. To test a nearly-full class, create a
 * small capacity and fill it through the booking flow.
 */
export async function createTrialClass(
  input: CreateClassInput,
): Promise<CreateClassResult> {
  const subject = String(input.subject ?? "").trim();
  if (!subject) {
    return { ok: false, message: "Subject is required." };
  }
  if (subject.length > MAX_SUBJECT) {
    return { ok: false, message: `Subject must be ${MAX_SUBJECT} characters or fewer.` };
  }

  // Number("") is 0 and Number(" ") is 0, so reject blanks before converting.
  const rawCapacity = String(input.capacity ?? "").trim();
  if (!rawCapacity) {
    return { ok: false, message: "Capacity is required." };
  }
  const capacity = Number(rawCapacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CLASS_CAPACITY) {
    return {
      ok: false,
      message: `Capacity must be a whole number between 1 and ${MAX_CLASS_CAPACITY}.`,
    };
  }

  const rawStartsAt = String(input.startsAt ?? "").trim();
  if (!rawStartsAt) {
    return { ok: false, message: "Start time is required." };
  }
  const startsAt = new Date(rawStartsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return { ok: false, message: "Start time is not a valid date." };
  }

  const created = await prisma.trialClass.create({
    data: { subject, startsAt, capacity, confirmedCount: 0 },
  });

  return { ok: true, classId: created.id, subject: created.subject };
}
