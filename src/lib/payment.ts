import { PAYMENT_SUCCESS_RATE, TRIAL_PRICE } from "@/lib/config";

/**
 * Forced outcome for the mock payment gateway. Tests and the demo pass an
 * explicit outcome so the last-seat race and the failure path are
 * deterministic; passing nothing falls back to a random result.
 */
export type PaymentOutcome = "succeed" | "fail";

export type PaymentResult = {
  outcome: PaymentOutcome;
  amount: number;
  /** Stand-in for a gateway transaction reference. */
  reference: string;
};

/**
 * Mock payment gateway. There is no real provider integration — see
 * docs/PRD.md §9 for the deliberate cut.
 */
export async function charge(
  bookingId: string,
  forced?: PaymentOutcome,
): Promise<PaymentResult> {
  // Simulate a little gateway latency so the concurrency test exercises a real
  // interleaving rather than two calls that happen to serialize instantly.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const outcome: PaymentOutcome =
    forced ?? (Math.random() < PAYMENT_SUCCESS_RATE ? "succeed" : "fail");

  return {
    outcome,
    amount: TRIAL_PRICE,
    reference: `mock_${bookingId}_${Date.now()}`,
  };
}

/**
 * Stand-in for a refund. Real refund execution is out of scope; the log line
 * exists so it is obvious what a production system would trigger when a
 * booking lands in SEAT_UNAVAILABLE. See docs/PRD.md §5.3.
 */
export function refund(bookingId: string, amount: number): void {
  console.warn(
    `[REFUND REQUIRED] booking=${bookingId} amount=${amount} ` +
      `reason=SEAT_UNAVAILABLE (payment succeeded, seat was already taken)`,
  );
}
