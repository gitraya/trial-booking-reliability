# PRD — Ottodot Trial Booking Reliability

**Stack:** Next.js (App Router) + TypeScript + Prisma + PostgreSQL
**Timebox:** 3–4 hours · **Scope:** trial booking only, no regular enrollment

---

## 1. Goal

Ship the smallest slice that gets the roster right under concurrency and payment failure — not the smallest slice that looks the most finished. Every design choice below optimizes for **correctness of the confirmed-seat count**, since that's the one thing the eval explicitly stress-tests (duplicate bookings, overbooking, the last-seat race, payment failure).

## 2. Tech decisions & why

| Decision | Choice | Why |
|---|---|---|
| DB | PostgreSQL (Docker Compose, one `docker compose up`) | The last-seat race needs a database with real row-level atomicity. SQLite technically single-writer-serializes too, but Postgres is what an evaluator expects for "production-realistic," and `docker-compose.yml` keeps setup to one command. |
| Mutations | Next.js Server Actions | Fewer files than hand-rolled route handlers for a 3–4h box; still shows backend judgment since the actions *are* the backend. |
| Roster | One REST route handler: `GET /api/classes/[id]/roster` | The brief explicitly asks for "a simple roster API/output" — worth having one real HTTP endpoint that's easy to `curl` in the walkthrough video. |
| Auth | None — `?parentId=` / `?role=admin` query param stub | Out of scope per the brief; call this out explicitly as a cut. |
| Payment | Mock module with a forced outcome param (`succeed` \| `fail`) for tests/demo, random ~85% success otherwise | Need deterministic control to prove the race and the failure path on camera. |

## 3. Data model

```prisma
// schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Parent {
  id       String    @id @default(cuid())
  name     String
  email    String    @unique
  students Student[]
}

model Student {
  id       String    @id @default(cuid())
  parentId String
  parent   Parent    @relation(fields: [parentId], references: [id])
  name     String
  bookings Booking[]
}

model TrialClass {
  id             String    @id @default(cuid())
  subject        String
  startsAt       DateTime
  capacity       Int       @default(4)
  confirmedCount Int       @default(0) // denormalized — see §5, this is the source of truth for seat math
  bookings       Booking[]
}

enum BookingStatus {
  PENDING_PAYMENT
  CONFIRMED
  PAYMENT_FAILED
  SEAT_UNAVAILABLE // payment succeeded but the seat was gone — see §5
  CANCELLED
}

model Booking {
  id        String          @id @default(cuid())
  studentId String
  student   Student         @relation(fields: [studentId], references: [id])
  classId   String
  class     TrialClass      @relation(fields: [classId], references: [id])
  status    BookingStatus   @default(PENDING_PAYMENT)
  createdAt DateTime        @default(now())
  updatedAt DateTime        @updatedAt
  payments  PaymentAttempt[]

  // Partial unique index — added by hand in the migration SQL (see §5.2),
  // NOT via Prisma's `partialIndexes` preview feature. That feature is real
  // now but still has open migration-drift bugs as of early 2026; not worth
  // the risk in a 3–4h box when three lines of raw SQL do the same job.
  @@index([classId, status])
}

enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
}

model PaymentAttempt {
  id        String        @id @default(cuid())
  bookingId String
  booking   Booking       @relation(fields: [bookingId], references: [id])
  status    PaymentStatus
  amount    Int
  createdAt DateTime      @default(now())
}
```

**Migration addendum** (hand-added to the generated migration's `.sql` file — this is the actual duplicate-booking guard, not the Prisma schema):

```sql
CREATE UNIQUE INDEX "booking_active_unique"
ON "Booking" ("studentId", "classId")
WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED');
```

This means a student can have at most one *live* (pending or confirmed) booking per class at a time, but a new attempt after `PAYMENT_FAILED`, `SEAT_UNAVAILABLE`, or `CANCELLED` is allowed — those states fall outside the index.

## 4. Booking lifecycle

```
PENDING_PAYMENT ──pay succeeds, seat available──▶ CONFIRMED
      │
      ├──pay fails───────────────────────────────▶ PAYMENT_FAILED
      │
      └──pay succeeds, seat taken meanwhile───────▶ SEAT_UNAVAILABLE (refund, logged)

CONFIRMED ──parent/admin cancels──▶ CANCELLED (frees the seat, decrements confirmedCount)
```

`SEAT_UNAVAILABLE` is the one status not in the brief's suggested list — it's added because "payment succeeded but you can't have the seat" is a distinct, honest outcome from `PAYMENT_FAILED` (money moved, seat didn't), and collapsing the two would hide exactly the case the eval cares about.

## 5. The last-seat race — approach

### 5.1 What does *not* solve it
A `SELECT confirmedCount FROM TrialClass WHERE id = ?` followed by an application-level `if (count < capacity)` check, then an `UPDATE`, is a classic check-then-act race: both User A's and User B's payment-confirmation requests can read `confirmedCount = 3` before either writes, and both proceed to confirm — 5 kids in a 4-seat class.

### 5.2 What does
A single atomic conditional `UPDATE`, run **at payment-confirmation time** (not at booking-creation time — both users are allowed to reach the payment step, per the brief's own scenario):

```ts
// lib/confirmBooking.ts
export async function confirmBooking(bookingId: string, paymentOutcome: 'succeed' | 'fail') {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new Error(`Booking is ${booking.status}, not payable`);
    }

    await tx.paymentAttempt.create({
      data: {
        bookingId,
        amount: TRIAL_PRICE,
        status: paymentOutcome === 'succeed' ? 'SUCCEEDED' : 'FAILED',
      },
    });

    if (paymentOutcome === 'fail') {
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 'PAYMENT_FAILED' },
      });
    }

    // The atomic seat claim. Postgres guarantees this UPDATE's WHERE clause
    // and its write are evaluated as one atomic unit against the row's
    // current committed value — no explicit lock needed, no deadlock risk.
    const claimed: { id: string }[] = await tx.$queryRaw`
      UPDATE "TrialClass"
      SET "confirmedCount" = "confirmedCount" + 1
      WHERE id = ${booking.classId} AND "confirmedCount" < capacity
      RETURNING id
    `;

    if (claimed.length === 0) {
      // Payment succeeded, but the seat is gone. Money moved — flag for refund.
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 'SEAT_UNAVAILABLE' },
      });
    }

    return tx.booking.update({
      where: { id: bookingId },
      data: { status: 'CONFIRMED' },
    });
  }, { isolationLevel: 'ReadCommitted' }); // default is enough — the UPDATE itself is what's atomic, not the isolation level
}
```

Walking through the brief's exact scenario: User A and User B both hold `PENDING_PAYMENT` bookings against a class with `confirmedCount = 3, capacity = 4`. B's `confirmBooking` transaction commits first: `UPDATE ... WHERE confirmedCount < 4` matches (3 < 4), row becomes 4, B's booking → `CONFIRMED`. A's transaction then runs the same `UPDATE`: `WHERE confirmedCount < 4` no longer matches (it's 4), zero rows affected, A's booking → `SEAT_UNAVAILABLE`. At most one confirmed booking for the last seat — guaranteed by Postgres's row-level write atomicity, not by application logic.

### 5.3 Trade-offs accepted
- **No seat hold/reservation timer.** Once a booking hits `PENDING_PAYMENT` it doesn't reserve a seat — it's first-committed-wins at confirm time. Simpler, but means a user who reaches payment can still lose the seat to someone faster, with no warning beforehand. Acceptable for a trial class (low stakes, `SEAT_UNAVAILABLE` + refund message is a fine UX for v1); listed under §9 as the first thing to add with more time.
- **Denormalized `confirmedCount` instead of `COUNT(*)` on bookings.** Faster and is what makes the single atomic `UPDATE` possible; the cost is it can drift from reality if a code path ever mutates `Booking.status` to/from `CONFIRMED` without going through this transaction. Mitigation: a periodic reconciliation check (§10) comparing `confirmedCount` against `COUNT(*) FROM Booking WHERE status='CONFIRMED'`.
- **Refund on `SEAT_UNAVAILABLE` is logged/mocked, not actually processed.** Real refund integration is out of scope for the box; the state and the log line exist so it's obvious what a production system would trigger.

## 6. Duplicate booking prevention

Two layers, one of them decorative:
- **UI/backend soft check** (decorative): before creating a `PENDING_PAYMENT` booking, query for an existing active booking for that (student, class) pair and reject with a friendly error. This is pure UX — it can itself race under concurrent double-clicks.
- **DB partial unique index** (authoritative, §3): `Booking(studentId, classId)` unique WHERE status is pending or confirmed. The `createBooking` server action wraps its insert in a `try/catch` for Prisma error `P2002` and turns it into a "you already have a booking for this class" response. This is the layer that's actually race-proof.

## 7. Overbooking prevention

Same atomic `UPDATE ... WHERE confirmedCount < capacity` from §5.2 is the only thing that matters here — booking creation itself never touches `confirmedCount`, only confirmation does, so overbooking and the last-seat race are the same mechanism, not two separate features.

## 8. Where each check lives

| Check | UI | Backend (server action) | DB | Background job |
|---|---|---|---|---|
| Class shown as "full" | ✅ cached/soft | | | |
| Duplicate booking | | ✅ soft pre-check | ✅ partial unique index (authoritative) | |
| Overbooking / last-seat race | | ✅ orchestrates the transaction | ✅ atomic conditional `UPDATE` (authoritative) | |
| Payment failure → no roster add | | ✅ | ✅ (transaction never reaches the `UPDATE` claim step) | |
| Stale `PENDING_PAYMENT` cleanup | | | | ⏳ not built — see §9 |
| `confirmedCount` drift reconciliation | | | | ⏳ not built — see §10 |

## 9. Deliberately cut (call out in README)
- Auth — query-param stub for parent/admin identity
- Seat holds with a payment-window timer
- Real payment provider / real refund execution
- Notifications (email/SMS on confirm or failure)
- Waitlist for full classes
- Any visual polish beyond functional forms/tables

## 10. What to monitor after release
- `confirmedCount` vs `COUNT(*) FROM Booking WHERE status='CONFIRMED'` per class — any drift means the invariant broke somewhere
- Rate of `SEAT_UNAVAILABLE` outcomes — a proxy for how often real users are hitting the race; rising rate is the signal to build seat holds
- `PENDING_PAYMENT` bookings older than N minutes with no payment attempt — abandoned carts silently blocking the partial-unique-index slot for that student
- Payment failure rate

## 11. Time budget (target: 3.5h, hard stop 4h)

| Block | Time |
|---|---|
| Schema, migration (incl. hand-added partial index), seed script | 30 min |
| Booking creation flow + duplicate guard | 45 min |
| Mock payment + atomic confirm (§5) — the core deliverable | 60 min |
| Roster route handler + minimal admin view | 30 min |
| Concurrency test (the race), payment-failure test, duplicate test | 45 min |
| README.md + AI_USAGE.md | 25 min |
| Record walkthrough video | 15 min |

If running long: cut the admin UI down to a plain rendered table before cutting any test.

## 12. Testing plan (priority order)

1. **The race, concurrently** — seed a class at `confirmedCount = 3, capacity = 4`, create two `PENDING_PAYMENT` bookings for two different students, fire both `confirmBooking(..., 'succeed')` calls via `Promise.all`. Assert: exactly one `CONFIRMED`, one `SEAT_UNAVAILABLE`, final `confirmedCount === 4`. This is the single test that proves the PRD's core claim — run it against the real Postgres instance, not a mock.
2. Duplicate booking attempt on the same (student, class) → second insert rejected via `P2002`.
3. Payment failure → booking `PAYMENT_FAILED`, `confirmedCount` unchanged.
4. Booking against an already-full class (`confirmedCount === capacity`) is blocked at the soft check, and — to prove the soft check isn't load-bearing — also fails correctly if forced past it straight into `confirmBooking`.

## 13. Seed data

- Class A — `capacity 4, confirmedCount 1` (plenty of room)
- Class B — `capacity 4, confirmedCount 3` (exactly 3 confirmed — the race fixture)
- Class C — `capacity 4, confirmedCount 4` (full — overbooking fixture)
- One existing `CONFIRMED` booking for Student X on Class A, to exercise the duplicate-booking case when Student X tries to book Class A again
- One `PENDING_PAYMENT` booking wired to a forced `fail` payment outcome, to exercise the failure path

## 14. Deliverables checklist (per the brief)

- [ ] Public GitHub repo — README.md, implementation, seed/setup, tests, `AI_USAGE.md`
- [ ] README covers: how to run, what was built, time spent, assumptions, architecture decisions, what was cut, monitoring plan, next steps (§9–§11 above feed this directly)
- [ ] `AI_USAGE.md` — tools used, a place AI sped things up, a place AI's output was corrected/rejected, what you'd change next time, how the final implementation was verified
- [ ] 5–8 min video: run the demo, show the race test passing, narrate the trade-offs in §5.3
