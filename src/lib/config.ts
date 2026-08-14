/** Trial class price in minor units (cents). SGD 25.00. */
export const TRIAL_PRICE = 2500;

/** Probability a non-forced mock payment succeeds. See docs/PRD.md §2. */
export const PAYMENT_SUCCESS_RATE = 0.85;

/**
 * Largest capacity the admin form will accept for a new trial class.
 *
 * Lives here rather than in lib/classes.ts because the client-side form needs
 * it too, and lib/classes.ts imports Prisma — pulling that into a client
 * component would drag the database client into the browser bundle. Keeping
 * one constant means the input's `max` and the server-side check cannot drift
 * apart.
 */
export const MAX_CLASS_CAPACITY = 10;
