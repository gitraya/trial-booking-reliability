# Trial Booking Reliability

A trial-class booking slice built around one question: **is the confirmed roster still correct when two parents pay for the last seat at the same millisecond?**

Everything here optimizes for the correctness of the confirmed-seat count under concurrency and payment failure. The UI is deliberately plain.

Stack: Next.js 16 (App Router) · React 19 · TypeScript 7 · Prisma 7 · PostgreSQL 18.

---

## Run it

Requires Docker and Node 20+.

```bash
make setup     # install, start Postgres, migrate, seed — clean checkout to ready
make dev       # http://localhost:3000
```

Then:

```bash
make test      # 17 tests against real Postgres
make demo      # live last-seat race, prints the outcome
make           # list every target
```

`.env` is committed on purpose — it holds only the local Docker Compose credentials, so the above works with zero configuration.

`make test` and `make demo` both consume seed data (the tests truncate; the demo takes Class B's last seat). Run `make seed` to restore the fixtures. `make verify` runs typecheck, build and tests, then reseeds for you.

Every target is a thin wrapper over the npm scripts in `package.json`, which remain the source of truth — use those directly if you prefer.

### Roster API

```bash
curl "http://localhost:3000/api/classes/<classId>/roster" | jq
```

Returns the confirmed roster plus a `reconciliation` block comparing the denormalized counter against an actual `COUNT(*)` — the drift check, exposed so the invariant can be verified by hand.

---

## The core problem and the solution

**What does not work.** Read `confirmedCount`, compare it to `capacity` in application code, then write. Two requests both read 3, both decide there's room, both write — five kids in a four-seat class. This is a check-then-act race and no amount of careful TypeScript fixes it.

**What does.** A single conditional `UPDATE`, run at payment-confirmation time:

```sql
UPDATE "TrialClass"
SET "confirmedCount" = "confirmedCount" + 1
WHERE id = $1 AND "confirmedCount" < capacity
RETURNING id
```

Postgres evaluates the predicate and the write as one atomic unit against the row's current committed value. Zero rows returned means the seat was taken first. No explicit locks, no elevated isolation level, no deadlock risk — `ReadCommitted` (the default) is sufficient, because the atomicity comes from the statement, not the isolation level.

Walking the exact scenario: A and B both hold `PENDING_PAYMENT` bookings against a class at `confirmedCount = 3, capacity = 4`. B commits first — `3 < 4` matches, counter becomes 4, B is `CONFIRMED`. A runs the same statement — `4 < 4` is false, zero rows, A becomes `SEAT_UNAVAILABLE`.

The whole thing lives in `src/lib/bookings.ts`.

### Seats are claimed at payment, not at booking

Booking creation never touches `confirmedCount`. Both parents are *allowed* to reach the payment step for one remaining seat — that is the brief's own scenario, and pretending otherwise would just move the race earlier. As a consequence, overbooking prevention and the last-seat race are the same mechanism, not two features.

### `SEAT_UNAVAILABLE` is its own status

Payment succeeded but the seat was gone: money moved, the seat didn't. That is a genuinely different outcome from `PAYMENT_FAILED`, and collapsing the two would hide exactly the case this project is about. It triggers a logged refund intent (real refund execution is out of scope).

```
PENDING_PAYMENT ──pay succeeds, seat available──▶ CONFIRMED
      ├──pay fails───────────────────────────────▶ PAYMENT_FAILED
      └──pay succeeds, seat taken meanwhile──────▶ SEAT_UNAVAILABLE (refund logged)

CONFIRMED ──cancel──▶ CANCELLED (releases the seat, decrements the counter)
```

### Duplicate bookings

Two layers, and only one of them matters:

- **Soft pre-check** in `createBooking` — pure UX. It can race under double-clicks.
- **Partial unique index** — authoritative:

```sql
CREATE UNIQUE INDEX "booking_active_unique"
ON "Booking" ("studentId", "classId")
WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED');
```

A student holds at most one *live* booking per class. Terminal statuses fall outside the predicate, so a retry after a failure or a cancellation is allowed — that is the point of making it partial. Prisma's schema language can't express a partial index, so it is **hand-written into the migration SQL** and must be re-added if migrations are ever regenerated.

### Where each check lives

| Check | UI | Server action | DB |
|---|---|---|---|
| Class shown as full | soft | | |
| Duplicate booking | | soft pre-check | **partial unique index** |
| Overbooking / last-seat race | | orchestrates the transaction | **atomic conditional UPDATE** |
| Payment failure → no roster add | | ✅ | transaction never reaches the claim |

The bold cells are the ones that actually hold. Everything else is convenience.

---

## Tests

17 tests, all against real Postgres — the guarantee under test is Postgres's row-level write atomicity, which a mocked database cannot reproduce.

| File | Covers |
|---|---|
| `tests/last-seat-race.test.ts` | 2-payer race, 10-payer race, seat release on cancel, double-cancel |
| `tests/duplicate-booking.test.ts` | duplicates incl. simultaneous, retry after failure, rebook after cancel |
| `tests/payment-failure.test.ts` | failure leaves the counter untouched, audit trail, double-clicked pay |
| `tests/overbooking.test.ts` | full class blocked, **and blocked with the soft check bypassed** |

Two of these are worth calling out:

- **The soft-check bypass test** inserts a `PENDING_PAYMENT` booking directly into the database, skipping `createBooking`'s capacity check entirely, then pays. It still gets `SEAT_UNAVAILABLE`. This proves the application-level check is not load-bearing.
- **The 10-payer race is the test that actually catches regressions.** I verified this by swapping the atomic `UPDATE` for a naive read-then-update: the 2-payer test still passed, while the 10-payer test confirmed 7 bookings into a 2-seat class. The narrow version of the race is not reliably reproducible; the wide one is.

Every test that touches seats also asserts **no drift** — that `confirmedCount` still equals `COUNT(*) WHERE status = 'CONFIRMED'`.

---

## Time spent

<!-- TODO: fill in actual wall-clock time before submitting. Budget was 3.5h (docs/PRD.md §11). -->

## Assumptions

- One trial booking per student per class is the correct business rule.
- A parent losing a seat after a successful payment is acceptable if the refund is automatic and the message is honest. A seat-hold timer would be better; see below.
- Trial classes are small (capacity ~4), so a denormalized counter never becomes a write-contention hotspot.
- Cancellation frees a seat immediately, with no cutoff window.

## Deliberately cut

- **Auth** — identity is a `?parentId=` query-param stub. Both pages are open to anyone.
- **Seat holds with a payment-window timer** — the first thing I'd add. Reaching payment reserves nothing.
- **Real payment provider and real refund execution** — `src/lib/payment.ts` is a mock with a forced-outcome parameter so the race and the failure path are deterministic on camera.
- **Notifications and waitlists.**

The UI is styled — light and warm, since parents are the audience — but it is still two plain pages. `docs/PRD.md` §9 listed visual polish as a cut; that was revisited, and the styling was added afterwards without touching the booking logic. Status colors use a reserved four-role palette (good/warning/serious/critical), validated for colorblind separation and contrast, and every status ships an icon and a text label so meaning never rests on hue alone.

## Known gaps

- **Stale `PENDING_PAYMENT` bookings are never cleaned up.** An abandoned booking silently occupies that student's slot in the partial unique index, blocking them from rebooking that class until it is resolved. A sweeper job marking them `CANCELLED` after N minutes is the fix.
- **The denormalized counter can drift** if any future code path mutates `Booking.status` to or from `CONFIRMED` outside `confirmBooking`/`cancelBooking`. Nothing in the schema enforces this — it is an invariant held by convention plus the reconciliation check. A database trigger would enforce it properly.

## Monitoring

- **`confirmedCount` vs `COUNT(*) WHERE CONFIRMED`, per class.** Any drift means the invariant broke. Already exposed on the roster endpoint (`reconciliation.inSync`) and on the admin page.
- **Rate of `SEAT_UNAVAILABLE`.** A direct proxy for how often real users hit the race. A rising rate is the signal to build seat holds.
- **`PENDING_PAYMENT` bookings older than N minutes** with no payment attempt — abandoned bookings blocking index slots.
- **Payment failure rate**, to separate gateway problems from application bugs.

## Next steps

1. Seat holds with a short expiry, so reaching payment reserves the seat.
2. A sweeper for stale `PENDING_PAYMENT` bookings.
3. Real auth, replacing the query-param stub.
4. A database trigger maintaining `confirmedCount`, making the invariant unbreakable rather than conventional.
5. Waitlist, fed by `SEAT_UNAVAILABLE` and cancellations.

See `docs/PRD.md` for the full design rationale and `AI_USAGE.md` for how AI was used.
