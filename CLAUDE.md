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

Tests and the seed both wipe the database, so **`make test` destroys seed data** — run `make seed` afterwards before demoing. Prefer `make seed` over `make reset`; the latter calls `prisma migrate reset`, which is blocked for AI agents without explicit user consent.

## Stack

Next.js 16 (App Router) + React 19 + TypeScript 7 + Prisma 7 + PostgreSQL 18. Mutations go through Server Actions in `src/app/actions.ts`; the one REST endpoint is `GET /api/classes/[id]/roster`. Payments are a mock module accepting a forced outcome (`'succeed' | 'fail'`) so the race and failure paths are deterministic; unforced calls succeed ~85% of the time.

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
- **Never mutate `Booking.status` to or from `CONFIRMED` outside this transaction.** Any path that does silently drifts `confirmedCount` from reality. Cancellation must decrement.
- The seat is claimed at **payment-confirmation time, not booking-creation time**. Booking creation deliberately never touches `confirmedCount`; two users are allowed to both reach the payment step for one seat. Overbooking prevention and the last-seat race are therefore the same mechanism, not two features.
- `ReadCommitted` (Prisma's default) is sufficient — atomicity comes from the UPDATE's WHERE clause, not the isolation level. Don't add explicit locks or bump isolation.

### Booking statuses

`PENDING_PAYMENT → CONFIRMED | PAYMENT_FAILED | SEAT_UNAVAILABLE`, plus `CANCELLED` from `CONFIRMED`.

`SEAT_UNAVAILABLE` means *payment succeeded but the seat was gone* — money moved, seat didn't. Keep it distinct from `PAYMENT_FAILED`; collapsing them hides the case the project is graded on. It should log a refund intent (real refund execution is out of scope).

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

**The two-payer race test is not sufficient on its own.** Verified empirically: swapping the atomic UPDATE for a naive read-then-update leaves the two-payer test green while the ten-payer test in `tests/last-seat-race.test.ts` catches it (7 confirmed in a 2-seat class). Don't delete the ten-payer test, and don't trust a green suite here without re-checking it against a deliberately broken implementation.

Every seat-touching test calls `assertNoDrift` from `tests/helpers.ts`, which asserts both `confirmedCount == COUNT(*) WHERE CONFIRMED` and `confirmedCount <= capacity`. New tests that touch seats should do the same.

Seed fixtures are shaped for these tests: Class A (room to spare, plus the duplicate fixture), Class B (`confirmedCount = 3` — the race fixture), Class C (full — the overbooking fixture).

## Scope

Auth is a `?parentId=` / `?role=admin` query-param stub — intentionally not real. Also deliberately cut: seat holds/payment timers, real payment or refund integration, notifications, waitlists, visual polish. Don't add these; `docs/PRD.md` §9 lists them as documented omissions and the README is expected to call them out. If time pressure forces a cut, the PRD's instruction is to cut admin UI before cutting any test.

Deliverables include a `README.md` and an `AI_USAGE.md` (see PRD §14).
