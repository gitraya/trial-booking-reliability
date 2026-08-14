import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { BookForm } from "./book-form";

export const dynamic = "force-dynamic";

const fmt = (d: Date) =>
  d.toLocaleString("en-SG", {
    weekday: "short",
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
        <h1>No data yet</h1>
        <p className="sub">
          Run <code>npm run db:up &amp;&amp; npm run db:reset</code> to create and seed
          the database.
        </p>
      </>
    );
  }

  const parent = parents.find((p) => p.id === parentId) ?? parents[0];

  const classes = await prisma.trialClass.findMany({
    orderBy: { startsAt: "asc" },
  });

  const myBookings = await prisma.booking.findMany({
    where: { student: { parentId: parent.id } },
    orderBy: { createdAt: "desc" },
    include: { student: true, class: true },
  });

  return (
    <>
      <h1>Book a trial class</h1>
      <p className="sub">
        Signed in as <strong>{parent.name}</strong> — no auth, identity is a{" "}
        <code>?parentId=</code> stub.
      </p>

      <div className="card">
        <strong>Switch parent:</strong>{" "}
        {parents.map((p) => (
          <span key={p.id}>
            <Link href={`/?parentId=${p.id}`}>
              {p.id === parent.id ? <strong>{p.name}</strong> : p.name}
            </Link>{" "}
          </span>
        ))}
      </div>

      <h2>Available classes</h2>
      {classes.map((c) => {
        const remaining = c.capacity - c.confirmedCount;
        const full = remaining <= 0;
        return (
          <div className="card" key={c.id}>
            <div className="card-head">
              <div>
                <strong>{c.subject}</strong>
                <div className="seats">{fmt(c.startsAt)}</div>
              </div>
              <span className={`seats ${full ? "full" : ""}`}>
                {c.confirmedCount}/{c.capacity} confirmed ·{" "}
                {full ? "FULL" : `${remaining} seat${remaining === 1 ? "" : "s"} left`}
              </span>
            </div>
            <BookForm classId={c.id} students={parent.students} full={full} />
          </div>
        );
      })}

      <h2>Your bookings</h2>
      {myBookings.length === 0 ? (
        <p className="sub">Nothing booked yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Class</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {myBookings.map((b) => (
              <tr key={b.id}>
                <td>{b.student.name}</td>
                <td>{b.class.subject}</td>
                <td>
                  <span className={`badge ${b.status}`}>{b.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
