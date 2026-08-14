# Trial Booking Reliability

A trial-class booking slice built around one question: **is the confirmed roster still correct when two parents pay for the last seat at the same millisecond?**

Everything here optimizes for the correctness of the confirmed-seat count under concurrency and payment failure. The UI is deliberately plain.

Stack: Next.js 16 (App Router) · React 19 · TypeScript 7 · Prisma 7 · PostgreSQL 18.

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
make test      # 22 tests against real Postgres
make demo      # live last-seat race, prints the outcome
make           # list every target
```

`.env` is committed on purpose — it holds only the local Docker Compose credentials, so the above works with zero configuration.

`make test` and `make demo` both consume seed data (the tests truncate; the demo takes Class B's last seat). Run `make seed` to restore the fixtures. `make verify` runs typecheck, build and tests, then reseeds for you.

Every target is a thin wrapper over the npm scripts in `package.json`, which remain the source of truth — use those directly if you prefer.

### Reproducing the race in the browser

The booking form has two buttons. **Book & pay** does both steps at once; **Reserve only** stops at `PENDING_PAYMENT` without paying, and a pending booking gets a **Pay now** control in "Your bookings". That split is what makes the PRD's scenario reproducible by hand:

1. Pick a class with one seat left (Class B in the seed) and **Reserve only**.
2. Switch parent in the "Viewing as" row, and **Reserve only** the same class again. The seat counter has not moved — reserving claims nothing.
3. Pay both. One gets **Confirmed**, the other **Seat taken — refunding**, and the class lands exactly at capacity.

### Roster API

```bash
curl "http://localhost:3000/api/classes/<classId>/roster" | jq
```

Returns the confirmed roster plus a `reconciliation` block comparing the denormalized counter against an actual `COUNT(*)` — the drift check, exposed so the invariant can be verified by hand.

### Deploying

Ships as a single container from the repo's `Dockerfile`, built by Coolify from source. **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** has the full walkthrough; the short version:

- One required variable: `DATABASE_URL`. Port `3000`, health check `/api/health`.
- `prisma migrate deploy` runs on every container start, before the server accepts traffic. A schema change ships by committing a migration.
- The health check queries the database, so a container that can't reach Postgres reports `503` instead of quietly serving errors.
- The seed script is **not** in the runtime image and refuses to run against a non-local database — it deletes every row before inserting.

Build and run it locally the way production does:

```bash
make docker-build
make docker-run     # http://localhost:3100, against the local Postgres
```

### CI

`.github/workflows/ci.yml` runs on every push and PR: typecheck, build, and the full suite against a real Postgres 18 service container. It also asserts that **`booking_active_unique` exists in the database with the right predicate** — that index is hand-written into the migration SQL, so it is the one piece of the schema that could silently disappear when migrations are regenerated. A second job builds the production image, so a broken `Dockerfile` is caught before it reaches the VPS.

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

22 tests, all against real Postgres — the guarantee under test is Postgres's row-level write atomicity, which a mocked database cannot reproduce.

| File | Covers |
|---|---|
| `tests/last-seat-race.test.ts` | 2-payer race, 10-payer race, seat release on cancel, double-cancel |
| `tests/duplicate-booking.test.ts` | duplicates incl. simultaneous, retry after failure, rebook after cancel |
| `tests/payment-failure.test.ts` | failure leaves the counter untouched, audit trail, double-clicked pay |
| `tests/overbooking.test.ts` | full class blocked, **and blocked with the soft check bypassed** |
| `tests/malformed-ids.test.ts` | malformed ids return not-found rather than throwing (see IDs above) |

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
