import "dotenv/config";
import { prisma } from "../src/lib/prisma.ts";

/**
 * Seed fixtures are shaped for the tests in docs/PRD.md §12/§13:
 *   Class A — room to spare, plus an existing booking for the duplicate case
 *   Class B — confirmedCount 3 of 4: the last-seat race fixture
 *   Class C — full: the overbooking fixture
 *
 * Every confirmedCount below is backed by real CONFIRMED bookings, so the
 * reconciliation invariant (confirmedCount == COUNT(*) WHERE CONFIRMED) holds
 * from a clean seed.
 */
async function main() {
  // This script DELETES EVERY ROW before seeding. Fine locally and in CI,
  // catastrophic against a deployed database.
  //
  // The guard keys off the target host rather than NODE_ENV, because the way
  // this actually goes wrong is someone running `npm run seed` on their laptop
  // with a production DATABASE_URL in the environment — where NODE_ENV is
  // still "development" and would wave it straight through.
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1|db):/.test(url);
  if (!isLocal && process.env.ALLOW_DESTRUCTIVE_SEED !== "yes") {
    throw new Error(
      `Refusing to seed a non-local database (${url.replace(/:[^:@/]*@/, ":***@")}). ` +
        "This script deletes every row first. If you really mean it, set " +
        "ALLOW_DESTRUCTIVE_SEED=yes.",
    );
  }

  // Order matters: PaymentAttempt -> Booking -> Student/TrialClass -> Parent.
  await prisma.paymentAttempt.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.student.deleteMany();
  await prisma.trialClass.deleteMany();
  await prisma.parent.deleteMany();

  const parentNames = [
    ["Mei Ling Tan", "meiling@example.com", "Student X"],
    ["Arjun Rao", "arjun@example.com", "Student Y"],
    ["Siti Rahman", "siti@example.com", "Student Z"],
    ["Daniel Wong", "daniel@example.com", "Student P"],
    ["Grace Lim", "grace@example.com", "Student Q"],
    ["Hassan Ali", "hassan@example.com", "Student R"],
    ["Nur Aisyah", "aisyah@example.com", "Student S"],
    ["Kevin Teo", "kevin@example.com", "Student T"],
  ] as const;

  const students = [];
  for (const [name, email, studentName] of parentNames) {
    const parent = await prisma.parent.create({ data: { name, email } });
    students.push(
      await prisma.student.create({
        data: { name: studentName, parentId: parent.id },
      }),
    );
  }
  const [x, y, z, p, q, r, s, t] = students;

  const day = (offset: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  const classA = await prisma.trialClass.create({
    data: { subject: "Primary 4 Math", startsAt: day(3, 16), capacity: 4 },
  });
  const classB = await prisma.trialClass.create({
    data: { subject: "Secondary 2 Science", startsAt: day(4, 17), capacity: 4 },
  });
  const classC = await prisma.trialClass.create({
    data: { subject: "Primary 6 English", startsAt: day(5, 15), capacity: 4 },
  });

  // Helper that keeps confirmedCount in step with the bookings it creates.
  const confirmSeats = async (classId: string, seatStudents: { id: string }[]) => {
    for (const student of seatStudents) {
      await prisma.booking.create({
        data: { studentId: student.id, classId, status: "CONFIRMED" },
      });
    }
    await prisma.trialClass.update({
      where: { id: classId },
      data: { confirmedCount: seatStudents.length },
    });
  };

  // Class A: 1 of 4. Student X's CONFIRMED booking here is the fixture for the
  // duplicate-booking case — booking Class A for X again must be rejected.
  await confirmSeats(classA.id, [x]);

  // Class B: 3 of 4. One seat left — the race fixture.
  await confirmSeats(classB.id, [y, z, p]);

  // Class C: 4 of 4. Full — the overbooking fixture.
  await confirmSeats(classC.id, [q, r, s, t]);

  // A live PENDING_PAYMENT booking to exercise the payment-failure path:
  // confirm it with a forced 'fail' outcome.
  const pending = await prisma.booking.create({
    data: { studentId: y.id, classId: classA.id, status: "PENDING_PAYMENT" },
  });

  console.log("Seeded:");
  console.log(`  Class A ${classA.id}  ${classA.subject}  1/4  (room to spare)`);
  console.log(`  Class B ${classB.id}  ${classB.subject}  3/4  (race fixture)`);
  console.log(`  Class C ${classC.id}  ${classC.subject}  4/4  (full)`);
  console.log(`  Student X ${x.id} — already booked into Class A (duplicate fixture)`);
  console.log(`  Pending booking ${pending.id} — confirm with 'fail' to see the failure path`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
