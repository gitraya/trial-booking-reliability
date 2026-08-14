/**
 * IDs are UUIDv7 and the columns are Postgres `uuid`, not text. That means a
 * malformed id does not simply fail to match — Postgres rejects it outright
 * ("invalid input syntax for type uuid"), which Prisma surfaces as a thrown
 * error rather than an empty result.
 *
 * So anywhere an id arrives from outside (a URL segment, a form field), check
 * the shape first, or a typo in the address bar becomes a 500 instead of a 404.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
