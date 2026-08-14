import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { BookForm } from "./book-form";
import { PayForm } from "./pay-form";
import { SeatMeter, StatusBadge, accentVars, subjectEmoji } from "./ui";

export const dynamic = "force-dynamic";

const fmt = (d: Date) =>
  d.toLocaleString("en-SG", {
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Parent-facing booking page.
 *
 * Identity is a `?parentId=` query-param stub — there is no auth. See
 * docs/PRD.md §9.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ parentId?: string }>;
}) {
  const { parentId } = await searchParams;

  const parents = await prisma.parent.findMany({
    orderBy: { name: "asc" },
    include: { students: true },
  });

  if (parents.length === 0) {
    return (
      <>
        <h1>Nothing here yet 🌱</h1>
        <p className="sub">
          Run <code>make setup</code> to create and seed the database, then refresh.
        </p>
      </>
    );
  }

  const parent = parents.find((p) => p.id === parentId) ?? parents[0];

  const classes = await prisma.trialClass.findMany({ orderBy: { startsAt: "asc" } });

  const myBookings = await prisma.booking.findMany({
    where: { student: { parentId: parent.id } },
    orderBy: { createdAt: "desc" },
    include: { student: true, class: true },
  });

  const firstName = parent.name.split(" ")[0];

  return (
    <>
      <h1>Hello, {firstName} 👋</h1>
      <p className="sub">
        Pick a trial class for your child. Seats are confirmed once payment goes
        through — you&apos;ll see the result straight away.
      </p>

      <div className="card switcher">
        <span className="label">Viewing as</span>
        {parents.map((p) => (
          <Link
            key={p.id}
            href={`/?parentId=${p.id}`}
            className="chip"
            aria-current={p.id === parent.id}
          >
            {p.name}
          </Link>
        ))}
      </div>

      <h2>
        Upcoming trial classes <span className="count">{classes.length} available</span>
      </h2>

      {classes.map((c, i) => {
        const full = c.capacity - c.confirmedCount <= 0;
        return (
          <div className="card accented" key={c.id} style={accentVars(i)}>
            <div className="card-head">
              <div>
                <div className="subject">
                  <span className="subject-emoji" aria-hidden="true">
                    {subjectEmoji(c.subject)}
                  </span>
                  {c.subject}
                </div>
                <div className="when">{fmt(c.startsAt)}</div>
              </div>
              <SeatMeter confirmed={c.confirmedCount} capacity={c.capacity} />
            </div>
            <BookForm classId={c.id} students={parent.students} full={full} />
          </div>
        );
      })}

      <h2>
        Your bookings <span className="count">{myBookings.length} total</span>
      </h2>

      {myBookings.length === 0 ? (
        <p className="empty">No bookings yet — pick a class above to get started.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th>Class</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {myBookings.map((b) => (
                <tr key={b.id}>
                  <td>{b.student.name}</td>
                  <td>{b.class.subject}</td>
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                  <td>
                    {b.status === "PENDING_PAYMENT" ? (
                      <PayForm bookingId={b.id} />
                    ) : (
                      <span className="empty">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="subtle-note">
        Demo build — no sign-in. Identity is a <code>?parentId=</code> stub, and the
        payment step is mocked so outcomes can be forced.
      </p>
    </>
  );
}
