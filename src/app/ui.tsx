import type { BookingStatus } from "@/generated/prisma/enums";

/**
 * Shared presentational pieces.
 *
 * Every status is rendered as an icon AND a text label — the reserved status
 * colors (good/warning/serious/critical) are a reinforcement, never the sole
 * carrier of meaning.
 */

const STATUS_META: Record<
  BookingStatus,
  { tone: string; icon: string; label: string }
> = {
  CONFIRMED: { tone: "good", icon: "✓", label: "Confirmed" },
  PENDING_PAYMENT: { tone: "warning", icon: "◷", label: "Awaiting payment" },
  SEAT_UNAVAILABLE: { tone: "serious", icon: "!", label: "Seat taken — refunding" },
  PAYMENT_FAILED: { tone: "critical", icon: "✕", label: "Payment failed" },
  CANCELLED: { tone: "neutral", icon: "–", label: "Cancelled" },
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`badge ${meta.tone}`}>
      <span className="icon" aria-hidden="true">
        {meta.icon}
      </span>
      {meta.label}
    </span>
  );
}

/**
 * Discrete seat meter — one mark per seat, filled marks first. The text
 * readout underneath always states the same numbers, so the marks never carry
 * the count on their own.
 */
export function SeatMeter({
  confirmed,
  capacity,
}: {
  confirmed: number;
  capacity: number;
}) {
  const remaining = Math.max(capacity - confirmed, 0);
  const full = remaining === 0;

  return (
    <div className="seat-block">
      <div
        className="seat-meter"
        role="img"
        aria-label={`${confirmed} of ${capacity} seats filled`}
      >
        {Array.from({ length: capacity }, (_, i) => (
          <span key={i} className={`seat ${i < confirmed ? "filled" : ""}`} />
        ))}
      </div>
      <div className={`seat-label ${full ? "full" : ""}`}>
        {full ? (
          <>Class full — {capacity} of {capacity} seats</>
        ) : (
          <>
            <strong>
              {remaining} seat{remaining === 1 ? "" : "s"} left
            </strong>{" "}
            · {confirmed} of {capacity} filled
          </>
        )}
      </div>
    </div>
  );
}

/** A cheerful, stable icon per subject — keyed off the subject name. */
export function subjectEmoji(subject: string): string {
  const s = subject.toLowerCase();
  if (s.includes("math")) return "🔢";
  if (s.includes("science")) return "🔬";
  if (s.includes("english")) return "📚";
  if (s.includes("art")) return "🎨";
  if (s.includes("music")) return "🎵";
  return "✏️";
}

/** Cycle the three validated categorical accent slots. */
export function accentVars(index: number) {
  const slot = (index % 3) + 1;
  const wash = ["#e8f1fd", "#fdeee7", "#e6f7f1"][index % 3];
  return {
    "--accent": `var(--accent-${slot})`,
    "--accent-wash": wash,
  } as React.CSSProperties;
}
