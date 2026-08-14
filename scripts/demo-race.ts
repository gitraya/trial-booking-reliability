import "dotenv/config";
import { confirmBooking, createBooking } from "../src/lib/bookings.ts";
import { prisma } from "../src/lib/prisma.ts";

/**
 * Live demonstration of the last-seat race against the seeded database.
 * Run with: npm run demo:race
 *
 * Uses Class B (3 of 4 confirmed — one seat left) from the seed.
 */
async function main() {
  const trialClass = await prisma.trialClass.findFirst({
    where: { subject: "Secondary 2 Science" },
  });
  if (!trialClass) {
    console.error("Seed data missing. Run `npm run seed` first.");
    process.exit(1);
  }

  console.log(
    `\nClass: ${trialClass.subject} — ${trialClass.confirmedCount}/${trialClass.capacity} confirmed, ` +
      `${trialClass.capacity - trialClass.confirmedCount} seat(s) left\n`,
  );

  // Two brand-new parents, each with one student, both going for the last seat.
  const contenders = await Promise.all(
    ["User A", "User B"].map(async (name) => {
      const parent = await prisma.parent.create({
        data: { name: `${name} parent`, email: `${name}-${Date.now()}@example.com` },
      });
      return prisma.student.create({ data: { name, parentId: parent.id } });
    }),
  );

  const bookings = [];
  for (const student of contenders) {
    const created = await createBooking(student.id, trialClass.id);
    if (!created.ok) {
      console.error(`${student.name}: could not book — ${created.message}`);
      process.exit(1);
    }
    bookings.push({ name: student.name, id: created.bookingId });
    console.log(`${student.name}: booking created, PENDING_PAYMENT (no seat held yet)`);
  }

  const after = await prisma.trialClass.findUniqueOrThrow({
    where: { id: trialClass.id },
  });
  console.log(
    `\nconfirmedCount after both bookings: ${after.confirmedCount} — unchanged, ` +
      `booking creation never claims a seat.\n`,
  );

  console.log("Both pay at the same instant...\n");
  const results = await Promise.all(
    bookings.map(async (b) => ({
      name: b.name,
      result: await confirmBooking(b.id, "succeed"),
    })),
  );

  for (const { name, result } of results) {
    console.log(`  ${name}: ${result.status}`);
    if (!result.ok && "message" in result) console.log(`      ${result.message}`);
  }

  const final = await prisma.trialClass.findUniqueOrThrow({
    where: { id: trialClass.id },
  });
  const actual = await prisma.booking.count({
    where: { classId: trialClass.id, status: "CONFIRMED" },
  });

  console.log(
    `\nFinal: confirmedCount=${final.confirmedCount}, capacity=${final.capacity}, ` +
      `actual CONFIRMED bookings=${actual}`,
  );
  console.log(
    final.confirmedCount === final.capacity && actual === final.confirmedCount
      ? "✓ Exactly one seat awarded. No overbooking, no drift.\n"
      : "✗ INVARIANT BROKEN\n",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
