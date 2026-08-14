import { prisma } from "@/lib/prisma";
import { CancelButton } from "../cancel-button";

export const dynamic = "force-dynamic";

/**
 * Admin roster view. Shows the confirmed roster per class alongside the
 * reconciliation check from docs/PRD.md §10 — if the denormalized
 * confirmedCount ever disagrees with COUNT(*) of confirmed bookings, it says so
 * loudly rather than quietly serving a wrong number.
 *
 * No auth: this page is reachable by anyone. See docs/PRD.md §9.
 */
export default async function Admin() {
  const classes = await prisma.trialClass.findMany({
    orderBy: { startsAt: "asc" },
    include: {
      bookings: {
        orderBy: { createdAt: "asc" },
        include: { student: { include: { parent: true } } },
      },
    },
  });

  return (
    <>
      <h1>Admin — rosters</h1>
      <p className="sub">
        Roster = CONFIRMED bookings only. Also available as JSON at{" "}
        <code>GET /api/classes/[id]/roster</code>.
      </p>

      {classes.map((c) => {
        const confirmed = c.bookings.filter((b) => b.status === "CONFIRMED");
        const others = c.bookings.filter((b) => b.status !== "CONFIRMED");
        const inSync = confirmed.length === c.confirmedCount;

        return (
          <div className="card" key={c.id}>
            <div className="card-head">
              <div>
                <strong>{c.subject}</strong>
                <div className="seats">
                  <code>{c.id}</code>
                </div>
              </div>
              <span className="seats">
                {c.confirmedCount}/{c.capacity} confirmed
              </span>
            </div>

            <p className={inSync ? "insync" : "drift"}>
              {inSync
                ? `✓ reconciled — counter ${c.confirmedCount} matches ${confirmed.length} confirmed bookings`
                : `⚠ DRIFT — counter says ${c.confirmedCount}, actual confirmed bookings ${confirmed.length}`}
            </p>

            {confirmed.length === 0 ? (
              <p className="sub">No one confirmed yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Parent</th>
                    <th>Email</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {confirmed.map((b) => (
                    <tr key={b.id}>
                      <td>{b.student.name}</td>
                      <td>{b.student.parent.name}</td>
                      <td>{b.student.parent.email}</td>
                      <td>
                        <CancelButton bookingId={b.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {others.length > 0 && (
              <>
                <h2>Non-confirmed attempts</h2>
                <table>
                  <tbody>
                    {others.map((b) => (
                      <tr key={b.id}>
                        <td>{b.student.name}</td>
                        <td>
                          <span className={`badge ${b.status}`}>{b.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
