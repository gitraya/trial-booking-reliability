import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cancelBooking, confirmBooking, createBooking } from "@/lib/bookings";
import { isUuid } from "@/lib/ids";
import { prisma } from "@/lib/prisma";
import { makeClass, makeStudent, resetDb } from "./helpers";

/**
 * Regression guard for the cuid -> UUIDv7 switch.
 *
 * The id columns are Postgres `uuid`, not text. A malformed id therefore does
 * not simply fail to match — Postgres rejects it and Prisma throws. Without an
 * explicit shape check, a typo in a URL or a tampered form field turns into a
 * 500 instead of a clean "not found".
 */
describe("malformed ids", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  const junk = ["not-a-uuid", "", "123", "0199-bad", "'; DROP TABLE x; --"];

  it("recognises real UUIDs and rejects junk", async () => {
    const student = await makeStudent("Shape check");
    expect(isUuid(student.id)).toBe(true);
    for (const value of junk) expect(isUuid(value)).toBe(false);
  });

  it("createBooking returns NOT_FOUND instead of throwing", async () => {
    const trialClass = await makeClass({ capacity: 4, confirmedCount: 0 });
    const student = await makeStudent("Valid student");

    for (const bad of junk) {
      const byClass = await createBooking(student.id, bad);
      expect(byClass.ok).toBe(false);
      if (!byClass.ok) expect(byClass.code).toBe("NOT_FOUND");

      const byStudent = await createBooking(bad, trialClass.id);
      expect(byStudent.ok).toBe(false);
      if (!byStudent.ok) expect(byStudent.code).toBe("NOT_FOUND");
    }
  });

  it("confirmBooking returns INVALID instead of throwing", async () => {
    for (const bad of junk) {
      const result = await confirmBooking(bad, "succeed");
      expect(result.ok).toBe(false);
      expect(result.status).toBe("INVALID");
    }
  });

  it("cancelBooking reports not found instead of throwing", async () => {
    for (const bad of junk) {
      const result = await cancelBooking(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("a well-formed but unknown UUID is still a clean miss", async () => {
    const absent = "019fff00-0000-7000-8000-000000000000";
    expect(isUuid(absent)).toBe(true);

    const created = await createBooking(absent, absent);
    expect(created.ok).toBe(false);

    const confirmed = await confirmBooking(absent, "succeed");
    expect(confirmed.status).toBe("INVALID");
  });
});
