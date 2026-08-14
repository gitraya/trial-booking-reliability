import { prisma } from "@/lib/prisma";
import { CancelButton } from "../cancel-button";
import { NewClassForm } from "../new-class-form";
import { SeatMeter, StatusBadge, accentVars, subjectEmoji } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Default for the datetime-local input: a week out, on the hour. Formatted as
 * local time without a timezone suffix, which is what the input expects.
 */
function defaultStartsAt() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(16, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
      <h1>Class rosters 📋</h1>
      <p className="sub">
        Confirmed students only. The same data is available as JSON at{" "}
        <code>GET /api/classes/[id]/roster</code>.
      </p>

      <NewClassForm defaultStartsAt={defaultStartsAt()} />

      <h2 style={{ marginTop: "2rem" }}>
        All classes <span className="count">{classes.length}</span>
      </h2>

      {classes.map((c, i) => {
        const confirmed = c.bookings.filter((b) => b.status === "CONFIRMED");
        const others = c.bookings.filter((b) => b.status !== "CONFIRMED");
        const inSync = confirmed.length === c.confirmedCount;

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
                <div className="when">
                  <code>{c.id}</code>
                </div>
              </div>
              <SeatMeter confirmed={c.confirmedCount} capacity={c.capacity} />
            </div>

            <div className={`recon ${inSync ? "insync" : "drift"}`}>
              <span aria-hidden="true">{inSync ? "✓" : "⚠"}</span>
              {inSync
                ? `Reconciled — counter ${c.confirmedCount} matches ${confirmed.length} confirmed booking${confirmed.length === 1 ? "" : "s"}`
                : `DRIFT — counter says ${c.confirmedCount}, actual confirmed bookings ${confirmed.length}`}
            </div>

            {confirmed.length === 0 ? (
              <p className="empty">No one has confirmed a seat yet.</p>
            ) : (
              <div className="table-wrap">
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
                        <td style={{ textAlign: "right" }}>
                          <CancelButton bookingId={b.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {others.length > 0 && (
              <>
                <h2>
                  Other attempts <span className="count">{others.length}</span>
                </h2>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {others.map((b) => (
                        <tr key={b.id}>
                          <td>{b.student.name}</td>
                          <td style={{ textAlign: "right" }}>
                            <StatusBadge status={b.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
