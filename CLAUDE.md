# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

A `Makefile` wraps the npm scripts; `make` alone lists every target. The npm scripts in `package.json` are the source of truth — the Makefile adds the ordering for `make setup` (install → db up → migrate → seed) and a `make verify` (typecheck → build → test → reseed).

Node floor is `^20.19 || ^22.12 || >=24` (Prisma 7, stricter than Next's `>=20.9`), and Docker must be running. `make preflight` checks both plus ports 5432/3000; `make setup` runs it first.

```bash
make setup           # clean checkout to running, seeded DB
make up              # Postgres 18 via Docker Compose, waits for healthy
make migrate         # prisma migrate dev
make seed            # truncates and reseeds the fixture classes
make dev             # http://localhost:3000
make test            # full suite (brings the DB up first)
make demo            # live last-seat race against the seeded DB
make psql            # psql shell against the local database
```

Run one test file: `npx vitest run tests/last-seat-race.test.ts`. One test by name: `npx vitest run -t "never overbooks"`.

There is no lint script — `next lint` was removed in Next 16 and no ESLint config was set up in its place. CI runs typecheck, build and tests.

## Deployment

**Nothing is deployed.** The container is built and verified locally (builds, migrates on start, serves, health check returns 200/503 correctly); the Coolify walkthrough in `docs/DEPLOYMENT.md` has never been executed against a real instance. Don't describe the app as live, and don't let the README drift back into implying it is.

Single container from `Dockerfile`. Things that will bite:

- `docker-entrypoint.sh` runs `prisma migrate deploy` on every start. Never `migrate dev` or `migrate reset` there.
- The runtime image gets a **separately installed** Prisma CLI (its own build stage), because the CLI's dependency closure is hoisted and cannot be cherry-picked out of the build stage's `node_modules`. Do not try to slim it by deleting `@prisma/studio-core` or `@prisma/dev` — `prisma/build/cli.js` requires both eagerly at load, and removing either breaks every deploy.
- The runtime uses `prisma.config.production.ts` (copied in as `prisma.config.ts`) because the dev config imports `dotenv`, which isn't in the image.
- The seed script refuses to run against a non-local `DATABASE_URL` without `ALLOW_DESTRUCTIVE_SEED=yes`, since it deletes every row first.

Tests and the seed both wipe the database, so **`make test` destroys seed data** — run `make seed` afterwards before demoing. Prefer `make seed` over `make reset`; the latter calls `prisma migrate reset`, which is blocked for AI agents without explicit user consent.

## Stack

Next.js 16 (App Router) + React 19 + TypeScript 7 + Prisma 7 + PostgreSQL 18. Mutations go through Server Actions in `src/app/actions.ts`; the REST endpoints are `GET /api/classes/[id]/roster` and `GET /api/health`. Payments are a mock module accepting a forced outcome (`'succeed' | 'fail'`) so the race and failure paths are deterministic; unforced calls succeed ~85% of the time.

Correctness lives in `src/lib` (`bookings.ts`, `classes.ts`, `payment.ts`, `ids.ts`). Server actions, routes and components are thin callers — put logic in `src/lib` so it can be tested without an HTTP layer.

**Prisma 7 conventions differ from older ones** — don't apply Prisma 5/6 habits here: the generator is `prisma-client` (not `prisma-client-js`) and emits TypeScript source to `src/generated/prisma`, the connection URL lives in `prisma.config.ts` (not `schema.prisma`), and a driver adapter (`@prisma/adapter-pg`) is required when constructing the client.

`docs/PRD.md` is the design rationale; the implementation follows it except where `AI_USAGE.md` documents a deliberate departure (notably: the payment charge happens outside the transaction, not inside as the PRD sketch showed).

## Architecture: the one invariant that matters

The whole project exists to keep the confirmed-seat count correct under concurrency. Everything else is scaffolding around that.

**`TrialClass.confirmedCount` is the source of truth for seat math** — a denormalized counter, not `COUNT(*)` over bookings. It is only ever mutated by a single atomic conditional UPDATE inside `confirmBooking`'s transaction:

```sql
UPDATE "TrialClass" SET "confirmedCount" = "confirmedCount" + 1
WHERE id = $1 AND "confirmedCount" < capacity RETURNING id
```

Zero rows returned means the seat was claimed by someone else between payment and confirmation. Consequences for anyone writing code here:

- **Never do check-then-act.** Reading `confirmedCount`, comparing to `capacity` in TypeScript, then updating is the exact bug this design eliminates. Application-level "is there room?" checks are UX only and must never gate the write.
- **A plain re-read inside a transaction is not a lock.** Under READ COMMITTED an unlocked `SELECT` is a snapshot read, so N concurrent callers all see the same pre-state and all proceed. `confirmBooking` therefore claims the booking row with `SELECT ... FOR UPDATE ... WHERE status = 'PENDING_PAYMENT'` before touching a seat. Removing that reintroduces one booking consuming N seats and N charges — it was a real bug, not a precaution.
- **Never mutate `Booking.status` to or from `CONFIRMED` outside this transaction.** Any path that does silently drifts `confirmedCount` from reality. Cancellation must decrement.
- The seat is claimed at **payment-confirmation time, not booking-creation time**. Booking creation deliberately never touches `confirmedCount`; two users are allowed to both reach the payment step for one seat. Overbooking prevention and the last-seat race are therefore the same mechanism, not two features.
- `ReadCommitted` (Prisma's default) is sufficient — atomicity comes from the UPDATE's WHERE clause, not the isolation level. Don't add explicit locks or bump isolation.

### The two-step booking flow

`bookingAction` serves both buttons on the booking form. Which one was pressed rides on the submit button's own `name="intent"` / `value`, not on separate actions:

- `intent=book` — create then pay in one go.
- `intent=reserve` — stop at `PENDING_PAYMENT`. The pending row then gets a **Pay now** control (`payBookingAction`) in "Your bookings".

The split exists so the last-seat race is reproducible in the browser: reserve as two parents, then pay both. Don't collapse it back into one step.

### Lock ordering (why there is no deadlock)

`confirmBooking` and `cancelBooking` both touch the `Booking` row **before** the `TrialClass` row. That consistent order is the only reason cancellation racing payment cannot deadlock — `tests/cancel-during-booking.test.ts` fires six of each simultaneously and asserts zero rejected promises. If you add a path that takes these two rows in the opposite order, you will get deadlocks under load.

### Booking statuses

`PENDING_PAYMENT → CONFIRMED | PAYMENT_FAILED | SEAT_UNAVAILABLE`, plus `CANCELLED` from `CONFIRMED`.

`SEAT_UNAVAILABLE` means *payment succeeded but the seat was gone* — money moved, seat didn't. Keep it distinct from `PAYMENT_FAILED`; collapsing them hides the case the project is graded on. It should log a refund intent (real refund execution is out of scope).

### IDs

UUIDv7 (`@default(uuid(7))`) in native Postgres `uuid` columns — not cuid, not text. v7 is time-ordered, so inserts stay at the hot end of the index.

The trap: a `uuid` column **throws** on a malformed value rather than failing to match. Any id arriving from outside (URL segment, form field) must pass `isUuid()` from `src/lib/ids.ts` before it reaches Prisma, or a typo becomes a 500 instead of a 404. `createBooking`, `confirmBooking`, `cancelBooking` and the roster route all guard; new entry points must too. Pinned by `tests/malformed-ids.test.ts`.

### Creating classes

`src/lib/classes.ts` backs the admin create-class form. `confirmedCount` is **not** an input and always starts at 0 — an admin-settable counter would manufacture drift by design. If asked to add a "pre-filled class" shortcut, push back: create a small capacity and fill it through the booking flow instead.

`MAX_CLASS_CAPACITY` lives in `src/lib/config.ts`, not `classes.ts`, and must stay there: the client-side form reads it for the input's `max`, and `classes.ts` imports Prisma — importing it into a client component would pull the database client into the browser bundle. One constant keeps the input and the server-side check from drifting apart.

### Duplicate prevention

The authoritative guard is a **partial unique index hand-written into the generated migration SQL** (not expressible in `schema.prisma`, and deliberately not using Prisma's `partialIndexes` preview feature):

```sql
CREATE UNIQUE INDEX "booking_active_unique"
ON "Booking" ("studentId", "classId")
WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED');
```

If a migration is ever regenerated, this statement must be re-added by hand. `createBooking` catches Prisma `P2002` and converts it to a friendly message. Only terminal statuses fall outside the index, so a student may retry after a failure or cancellation.

## Testing

Concurrency tests must run against a **real Postgres instance**, never a mock — the guarantee under test is Postgres's row-level write atomicity.

**Concurrency tests need enough contenders.** This has bitten twice: two racers left both the seat-claim regression and the double-click regression undetected. When adding a concurrency test, use ~8 concurrent operations, and verify it fails against deliberately broken code before trusting it.

**The two-payer race test is not sufficient on its own.** Verified empirically: swapping the atomic UPDATE for a naive read-then-update leaves the two-payer test green while the ten-payer test in `tests/last-seat-race.test.ts` catches it (7 confirmed in a 2-seat class). Don't delete the ten-payer test, and don't trust a green suite here without re-checking it against a deliberately broken implementation.

Every seat-touching test calls `assertNoDrift` from `tests/helpers.ts`, which asserts both `confirmedCount == COUNT(*) WHERE CONFIRMED` and `confirmedCount <= capacity`. New tests that touch seats should do the same.

Seed fixtures are shaped for these tests: Class A (room to spare, plus the duplicate fixture), Class B (`confirmedCount = 3` — the race fixture), Class C (full — the overbooking fixture).

**The suite covers `src/lib` only.** The routes, server actions and components have no automated tests — they were verified by hand against a running server. That gap is real: the malformed-id 500 regression should have been caught automatically and instead was found by manually re-checking endpoints. If you add HTTP-layer tests, that is the highest-value place to start.

## Scope

Auth is a `?parentId=` query-param stub — intentionally not real. Also deliberately cut: seat holds/payment timers, real payment or refund integration, notifications, waitlists, and a live deployment. Don't add these; `docs/PRD.md` §9 lists them as documented omissions and the README calls them out. If time pressure forces a cut, the PRD's instruction is to cut admin UI before cutting any test.

Visual polish was listed as a cut in the PRD but **that was revisited** — the UI is deliberately styled now (light, warm, parent-facing). Don't strip it back. Status colors come from a reserved four-role palette and every status renders an icon *and* a text label, so meaning never rests on hue alone; keep that property when adding states. Shared bits live in `src/app/ui.tsx`.

This is a take-home submission judged on correctness and scope control, not feature breadth. Adding infrastructure the problem doesn't need (Redis locks, queues, waiting rooms) makes it worse, not better — the invariant already lives in the strongest available layer.

Deliverables include a `README.md` and an `AI_USAGE.md` (see PRD §14).
