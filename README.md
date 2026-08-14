# Trial Booking Reliability

A trial-class booking slice built around one question: **is the confirmed roster still correct when two parents pay for the last seat at the same millisecond?**

Everything here optimizes for the correctness of the confirmed-seat count under concurrency and payment failure. The UI is functional rather than a showcase.

Stack: Next.js 16 (App Router) · React 19 · TypeScript 7 · Prisma 7 · PostgreSQL 18.

---

## What I built

A working trial-booking slice: parents pick a child and a class, submit a booking, go through a mock payment, and see the resulting status; an admin sees the roster.

The whole thing is built around one invariant — **the confirmed seat count is always correct** — and everything else is scaffolding around proving that.

- **Parent flow** (`/`): choose a child, choose a class, book. Either **Book & pay** in one step, or **Reserve only** to stop at `PENDING_PAYMENT` and pay later — which is what makes the last-seat race reproducible by hand.
- **Payment**: mocked, with a forced outcome selector (succeeds / fails / random) so the failure path and the race are deterministic on camera.
- **Admin** (`/admin`): per-class roster, seat meter, cancel a seat, create extra classes for testing. Each class shows a live reconciliation check.
- **Roster API**: `GET /api/classes/[id]/roster`, returning the confirmed roster plus that reconciliation block.
- **34 tests** against real Postgres, covering every edge case in the brief plus the ones I found while probing.

---

## Requirements

| Need | Version | Why |
|---|---|---|
| **Node.js** | `^20.19` · `^22.12` · `>=24` | Prisma 7 sets the floor — it is stricter than Next 16's `>=20.9`. Node 20.0–20.18 will fail. |
| **npm** | 10+ | Ships with Node. |
| **Docker** | Engine 24+ with **Compose v2** | Runs Postgres 18. Invoked as `docker compose` (space, not hyphen). Docker Desktop covers both. |
| **GNU Make** | any | Only for the `make` shortcuts. Preinstalled on macOS and Linux — see the Windows note below. |

Also needed:

- **Free ports `5432` and `3000`.** Postgres publishes 5432 to the host so tests and scripts can reach it. If you already run Postgres locally, stop it or change the host-side port in `docker-compose.yml`.
- **~1.5 GB disk** for `node_modules` and the Postgres image.
- **Docker must be running** before `make setup` — `make up` waits for the container to report healthy and will otherwise hang until it times out.

Check all of it in one go — `make setup` runs this first and stops with a specific message rather than a confusing failure later:

```bash
make preflight
```

```
Checking prerequisites...
  ok    Node 24.12.0
  ok    Docker 28.4.0
  ok    port 5432 free
  ok    port 3000 free
```

Verified on macOS 15 (Apple Silicon) with Node 24.12.0, npm 11.6.2, Docker 28.4.0 and Compose v2.39.2.

**Windows:** everything works, but `make` is not installed by default. Either run under WSL2, or skip the Makefile and use the npm scripts directly — they are the source of truth, and each `make` target maps to one. `make setup` is just the preflight check followed by `npm install && npm run db:up && npm run db:migrate && npm run seed`.

`jq` in the roster example below is optional — it only pretty-prints the JSON.

No database, Postgres client, or Prisma CLI needs to be installed on the host — Postgres runs in the container, and the Prisma CLI comes in as a dev dependency.

## Run it

```bash
make setup     # install, start Postgres, migrate, seed — clean checkout to ready
make dev       # http://localhost:3000
```

Then:

```bash
make test      # 34 tests against real Postgres
make demo      # live last-seat race, prints the outcome
make           # list every target
```

`.env` is committed on purpose — it holds only the local Docker Compose credentials, so the above works with zero configuration.

`make test` and `make demo` both consume seed data (the tests truncate; the demo takes Class B's last seat). Run `make seed` to restore the fixtures. `make verify` runs typecheck, build and tests, then reseeds for you.

Every target is a thin wrapper over the npm scripts in `package.json`, which remain the source of truth — use those directly if you prefer.

### Reproducing the race in the browser

The admin page has a **Create a trial class** form for testing beyond the seed fixtures. Capacity defaults to **1**, which makes the race a two-click demo: two parents reserving that class are immediately racing for the only seat, with no setup.

Note what the form deliberately does *not* offer: a field for the seat counter. `confirmedCount` only ever moves through the booking flow — letting an admin type a starting value would manufacture exactly the drift the reconciliation check exists to detect.

The booking form has two buttons. **Book & pay** does both steps at once; **Reserve only** stops at `PENDING_PAYMENT` without paying, and a pending booking gets a **Pay now** control in "Your bookings". That split is what makes the PRD's scenario reproducible by hand:

1. Pick a class with one seat left (Class B in the seed) and **Reserve only**.
2. Switch parent in the "Viewing as" row, and **Reserve only** the same class again. The seat counter has not moved — reserving claims nothing.
3. Pay both. One gets **Confirmed**, the other **Seat taken — refunding**, and the class lands exactly at capacity.

### Roster API

```bash
curl "http://localhost:3000/api/classes/<classId>/roster" | jq
```

Returns the confirmed roster plus a `reconciliation` block comparing the denormalized counter against an actual `COUNT(*)` — the drift check, exposed so the invariant can be verified by hand.

### Deployment — built, but not deployed

**There is no live URL.** I ran out of time before putting this on a server, so treat this section as deployment-*ready*, not deployed. What exists is real and verified locally; what is missing is a running instance.

Verified: the image builds, `prisma migrate deploy` runs at container start, the app serves from the container against Postgres, and the health check returns `200` with the database up and `503` with it down. Not verified: anything on an actual VPS. The Coolify walkthrough in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** is written from the container's actual requirements, but I have never executed it end to end against a real Coolify instance.

The shape of it:

- One required variable: `DATABASE_URL`. Port `3000`, health check `/api/health`.
- `prisma migrate deploy` runs on every container start, before the server accepts traffic. A schema change ships by committing a migration.
- The health check queries the database, so a container that can't reach Postgres reports `503` instead of quietly serving errors.
- The seed script is **not** in the runtime image and refuses to run against a non-local database — it deletes every row before inserting.

Run the production image locally — this is what I actually verified:

```bash
make docker-build
make docker-run     # http://localhost:3100, against the local Postgres
```

### CI

`.github/workflows/ci.yml` runs on every push and PR: typecheck, build, and the full suite against a real Postgres 18 service container. It also asserts that **`booking_active_unique` exists in the database with the right predicate** — that index is hand-written into the migration SQL, so it is the one piece of the schema that could silently disappear when migrations are regenerated. A second job builds the production image, so a broken `Dockerfile` is caught in CI.

---
---

## Backend design

### Data model

Five tables, deliberately small. Full definitions in [`prisma/schema.prisma`](prisma/schema.prisma).

| Model | Purpose | Notable fields |
|---|---|---|
| `Parent` | Account holder | `email` unique |
| `Student` | The child being booked | `parentId` |
| `TrialClass` | A bookable session | `capacity` (default 4), **`confirmedCount`** |
| `Booking` | One child's attempt at one class | `status`, partial unique index on `(studentId, classId)` |
| `PaymentAttempt` | Audit trail of every charge | `status`, `amount` (minor units) |

Primary keys are UUIDv7 in native Postgres `uuid` columns.

**`TrialClass.confirmedCount` is the only source of truth for seat math.** It is denormalized on purpose — that is what makes the seat claim a single atomic statement. The cost is that it can drift if anything mutates `Booking.status` outside the two functions allowed to, which is why the reconciliation check is exposed on the roster endpoint and the admin page.

### Booking statuses

| Status | Meaning |
|---|---|
| `PENDING_PAYMENT` | Booked, not paid. **Holds no seat.** |
| `CONFIRMED` | Paid and seated. The only status on the roster. |
| `PAYMENT_FAILED` | Payment declined. No seat taken; the parent may retry. |
| `SEAT_UNAVAILABLE` | Payment succeeded but the seat was gone. Money moved, seat didn't — refund logged. |
| `CANCELLED` | Seat released, counter decremented. |

`SEAT_UNAVAILABLE` is the one status not suggested in the brief. It is added because "payment succeeded but you can't have the seat" is a genuinely different outcome from a declined card, and collapsing the two would hide exactly the case this exercise is about.

### Backend surface

The correctness lives in `src/lib`; server actions and routes are thin callers.

| Function (`src/lib/bookings.ts`) | Does |
|---|---|
| `createBooking(studentId, classId)` | Creates `PENDING_PAYMENT`. **Never touches `confirmedCount`.** Duplicates rejected by the DB index (`P2002`). |
| `confirmBooking(bookingId, outcome?)` | Charges, then claims the booking row (`FOR UPDATE`), then claims a seat atomically. Returns `CONFIRMED` / `PAYMENT_FAILED` / `SEAT_UNAVAILABLE`. |
| `cancelBooking(bookingId)` | Releases a confirmed seat and decrements, both conditionally. |

| Server action (`src/app/actions.ts`) | Does |
|---|---|
| `bookingAction` | Book-and-pay, or reserve only (`intent` field) |
| `payBookingAction` | Pay an existing `PENDING_PAYMENT` booking |
| `cancelBookingAction` | Admin cancels a seat |
| `createClassAction` | Admin creates a test class |

| HTTP | Does |
|---|---|
| `GET /api/classes/[id]/roster` | Confirmed roster + reconciliation block |
| `GET /api/health` | Liveness + database reachability (for the deploy) |

### How payment failure is handled

The charge happens **before** the transaction opens, because a real gateway is slow network I/O and holding a transaction across it pins a connection. Inside the transaction, a `PaymentAttempt` row is always written — success or failure — so the audit trail exists either way.

On failure the booking becomes `PAYMENT_FAILED` and the transaction **returns before reaching the seat claim**. There is no code path where a failed payment can increment `confirmedCount`, which is the property the brief asks for. `PAYMENT_FAILED` sits outside the duplicate-booking index predicate, so the parent can immediately try again.


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

### Two serialization points, not one

The seat claim above stops different bookings from overrunning capacity. It does **not** stop *one* booking from being paid several times at once — a double-clicked pay button. A plain re-read inside the transaction is not enough there: under READ COMMITTED an unlocked `SELECT` takes a snapshot, so every concurrent call reads `PENDING_PAYMENT`, passes the check, and goes on to claim its own seat.

So `confirmBooking` claims the booking row first:

```sql
SELECT id, "classId" FROM "Booking"
WHERE id = $1 AND status = 'PENDING_PAYMENT'
FOR UPDATE
```

The first transaction locks the row; the rest block, and when it commits they re-evaluate the predicate against the new committed version, no longer match, and bail out before touching a seat. One booking, one seat, one charge.

This was a real bug, not a hypothetical: firing 8 concurrent payments at one booking produced 8 confirmations, 8 seats and 8 payment records. Two concurrent calls did not reproduce it, which is why the test now uses eight.

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

### IDs

Primary keys are **UUIDv7** in native Postgres `uuid` columns (16 bytes, not a 36-char string). v7 embeds a millisecond timestamp in its leading bits, so new rows sort to the end of the index instead of scattering across it the way v4 or cuid2 would — inserts stay in a hot page rather than dirtying the whole B-tree.

One consequence worth knowing, because it is not obvious: a `uuid` column does not *miss* on a malformed id, it **throws** — Postgres rejects `not-a-uuid` as a syntax error before any row matching happens. With text keys a bad id was just a lookup that found nothing. So every entry point that takes an id from outside (URL segment, form field) checks the shape via `isUuid()` first, or a typo in the address bar returns 500 instead of 404. `tests/malformed-ids.test.ts` pins that behaviour.

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

34 tests, all against real Postgres — the guarantee under test is Postgres's row-level write atomicity, which a mocked database cannot reproduce.

| File | Covers |
|---|---|
| `tests/last-seat-race.test.ts` | 2-payer race, 10-payer race, seat release on cancel, double-cancel |
| `tests/duplicate-booking.test.ts` | duplicates incl. simultaneous, retry after failure, rebook after cancel |
| `tests/payment-failure.test.ts` | failure leaves the counter untouched, audit trail, **spammed pay button (8 concurrent)** |
| `tests/overbooking.test.ts` | full class blocked, **and blocked with the soft check bypassed** |
| `tests/malformed-ids.test.ts` | malformed ids return not-found rather than throwing (see IDs above) |
| `tests/create-class.test.ts` | admin class creation: validation, and that the seat counter always starts at 0 |
| `tests/cancel-during-booking.test.ts` | cancellation racing payment — the only place the counter moves both ways at once |

Two of these are worth calling out:

- **The soft-check bypass test** inserts a `PENDING_PAYMENT` booking directly into the database, skipping `createBooking`'s capacity check entirely, then pays. It still gets `SEAT_UNAVAILABLE`. This proves the application-level check is not load-bearing.
- **The 10-payer race is the test that actually catches regressions.** I verified this by swapping the atomic `UPDATE` for a naive read-then-update: the 2-payer test still passed, while the 10-payer test confirmed 7 bookings into a 2-seat class. The narrow version of the race is not reliably reproducible; the wide one is.

**What is not covered:** these tests exercise `src/lib`, not the HTTP layer. The roster route, the health endpoint, the server actions and the React components have no automated tests — they were verified by hand against a running server. A route-level test would have caught the malformed-id 500 automatically instead of by manual re-checking.

Every test that touches seats also asserts **no drift** — that `confirmedCount` still equals `COUNT(*) WHERE status = 'CONFIRMED'`.

---

## Time spent

**3 hours 30 minutes**, against a 4-hour cap.

Most of it went where the brief said it should: the data model, the atomic seat claim, and the tests. The two most valuable stretches were not writing code — they were deliberately breaking the implementation to check the tests actually failed, which caught two real concurrency bugs (see `AI_USAGE.md`).

What the budget did not stretch to: deploying anywhere, and the gaps listed under Known gaps and Next steps.

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
- **A live deployment.** The container and CI are done and verified locally; putting it on a server is what the clock ran out on. See the deployment section above.

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
6. **Actually deploy it.** The container and the Coolify walkthrough are ready and verified locally; only a running instance is missing.
7. Tests at the HTTP layer. Everything automated today targets `src/lib`; the routes and server actions were checked by hand.

See `docs/PRD.md` for the full design rationale and `AI_USAGE.md` for how AI was used.
