# AI Usage

## Tools

- **Claude Code (Opus 5)** — used for the whole build: scaffolding, schema, the booking library, tests, UI, and these docs.
- The PRD in `docs/PRD.md` was written first, with AI as a thinking partner, and then used as the spec the implementation was held to.

## Where AI clearly sped things up

**Scaffolding and boilerplate.** The Docker Compose file, Prisma schema translation, seed script, Next.js layout/CSS, and the roster route were near-instant. None of it is interesting work, and all of it was correct on the first or second pass.

**Test breadth.** The PRD specified four test scenarios. The implementation ended up with 23, because it was cheap to ask for the adjacent cases that matter: the double-clicked pay button, the double cancel, rebooking after a cancellation, the audit-trail assertion. Several of those found nothing — but the double-click-pay case is a real concurrency hole that the PRD's original four tests would not have covered.

**Writing the adversarial test.** The "bypass the soft check by inserting a `PENDING_PAYMENT` row directly, then pay" test is the kind of thing that is easy to describe and tedious to write. It took one prompt.

## Where AI's output was corrected or rejected

**1. The PRD held a database transaction open across the payment call.** The PRD's `confirmBooking` sketch (§5.2) took a `paymentOutcome` parameter and did everything — payment record, seat claim, status update — inside `prisma.$transaction`. That is fine when payment is a mock, and bad when it isn't: a real gateway call is slow network I/O, and holding a transaction open across it pins a connection and widens the lock-contention window. The implementation charges **before** opening the transaction, then re-reads and re-validates the booking status **inside** it. The re-read is what makes it safe: it is what stops two concurrent confirmations of the same booking from both getting through.

**2. Two racers is not enough to catch the bug.** The PRD's headline test (§12.1) uses two concurrent payers. I checked whether that test actually has teeth by temporarily replacing the atomic `UPDATE` with the naive read-then-update the PRD warns against, and re-running. **The two-payer test still passed.** The ten-payer test I had added caught it immediately — 7 confirmed bookings in a 2-seat class. The narrow race is real but not reliably reproducible on demand; only the wide one is. Both tests are kept, and the ten-payer one carries a comment explaining why it must not be deleted.

This is the single most useful thing I did in the whole build, and it is worth being blunt about it: I would otherwise have shipped a test suite that was green against a broken implementation.

**3. Version conventions could not be taken from the model's memory.** Prisma 7 changed enough to invalidate the patterns the model reaches for by default — the generator is `prisma-client` (not `prisma-client-js`), it emits TypeScript source rather than a prebuilt package into `node_modules`, the connection URL lives in `prisma.config.ts` rather than the schema, and a driver adapter (`@prisma/adapter-pg`) is now required. I checked the actual installed tooling instead of trusting the first draft.

**4. Postgres 18 changed its data directory convention.** The generated `docker-compose.yml` mounted the volume at `/var/lib/postgresql/data`, which is correct for Postgres ≤17 and makes the 18 image crash-loop on startup. Caught immediately because `docker compose up --wait` reported the container unhealthy rather than silently continuing.

**5. Rejected: `SELECT ... FOR UPDATE` for the seat claim.** An early instinct was to lock the class row before checking capacity. It works, but it is strictly worse than the conditional `UPDATE`: more round trips, a lock held for the duration of the transaction, and deadlock potential once more than one row is involved. The single-statement version needs no lock at all.

Worth being precise, given correction #7 below: this rejection is about the **class** row. The **booking** row does use `FOR UPDATE`, because there the claim has to be held across later statements in the same transaction rather than expressed as one conditional write. Different problems, different tools.

**6. Switching cuid to UUIDv7 introduced a 500 that no test would have caught.** Making the id columns native Postgres `uuid` changed the failure mode of a bad id: with text keys `not-a-uuid` was a lookup that found nothing, but a `uuid` column rejects it as a syntax error before matching, so Prisma throws. The roster endpoint went from returning 404 to returning 500, and I only found it because I re-ran the endpoint checks against the running app after the migration rather than trusting a green suite. Fixed with a shape check at every entry point that takes an id from outside, and pinned by `tests/malformed-ids.test.ts`.

**7. The double-click guard did not actually work.** `confirmBooking` re-read the booking inside its transaction and checked the status, with a comment claiming this stopped concurrent payments for the same booking. It did not: under READ COMMITTED an unlocked SELECT is a snapshot read, so all concurrent callers see PENDING_PAYMENT and all proceed. Firing 8 concurrent payments at one booking produced **8 confirmations, 8 seats and 8 payment records**. The existing test used two concurrent calls and passed — the same "not enough racers" trap as #2, in the same codebase, which I had already been burned by once. Fixed by claiming the booking row with `SELECT ... FOR UPDATE` before touching a seat; the test now uses eight and was verified to fail against the old code.

Note this is the second time a green test was hiding a real concurrency bug here. Concurrency tests need enough contenders to make the interleaving likely, and the only way to know is to break the code deliberately and watch them fail.

## How the implementation was verified

Not by reading it and agreeing with it.

1. **`npm test`** — 29 tests against real Postgres, not a mock. The property under test is Postgres's row-level write atomicity; a mocked database would only test my beliefs about it.
2. **Deliberate regression.** Replaced the atomic `UPDATE` with the naive implementation and confirmed the suite goes red (documented above). A test that never fails proves nothing.
3. **Invariant assertion everywhere.** Every seat-touching test calls `assertNoDrift`, checking both that `confirmedCount == COUNT(*) WHERE CONFIRMED` and that the count never exceeds capacity.
4. **Ran the real app.** Built it, started the production server, seeded it, and verified the roster endpoint's JSON, its 404 path, the booking page, and the admin page's reconciliation output against live data.
5. **Verified the index in the database, not the schema.** Ran `\d "Booking"` in psql to confirm the partial unique index exists with the right predicate — it is hand-written SQL, so the Prisma schema is not evidence that it landed.
6. **Adversarial concurrency probing.** Beyond the suite, I ran ad-hoc stress scripts firing 8 concurrent operations at a single row, repeated over several rounds. That is what surfaced correction #7 — the suite was green at the time.
7. **`npm run demo:race`** against the seeded database, reproducing the PRD's exact scenario end to end.

## What I would change next time

- **Write the deliberate-regression check first.** Confirming that a test fails against a known-broken implementation should be part of writing the test, not a step at the end. It was luck that I did it at all, and it changed the test suite.
- **Pin the invariant in the database, not in convention.** `confirmedCount` is currently protected by "every code path goes through these two functions." A trigger would make that unbreakable, and would have been maybe twenty minutes.
- **Check framework/library conventions before generating, not after.** Several of the corrections above were version-drift issues found by running the code. Both were cheap here because the feedback loop was fast; on a larger surface they would not have been.
- **Be more skeptical of a green test suite generally.** The one that mattered was passing for the wrong reason.
