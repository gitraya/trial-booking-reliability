import "dotenv/config";

// These tests truncate tables. Refuse to run against anything that is not the
// local Docker Compose database.
const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1|db):/.test(url)) {
  throw new Error(
    `Refusing to run destructive tests against a non-local DATABASE_URL (${url}). ` +
      "Run `npm run db:up` and use the .env in the repo root.",
  );
}
