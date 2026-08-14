#!/bin/sh
# Container entrypoint: apply pending migrations, then hand off to the server.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  echo "Set it in the Coolify application's Environment Variables." >&2
  exit 1
fi

echo "==> Applying database migrations"
# `migrate deploy` only applies pending migrations. It never resets, never
# generates SQL, and never prompts — the only migrate command safe against a
# database with real data in it. It takes an advisory lock, so concurrent
# container starts serialize rather than racing.
# Invoked via node directly rather than node_modules/.bin/prisma — the image
# copies the package but not npm's symlink farm.
node ./node_modules/prisma/build/index.js migrate deploy

echo "==> Starting server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec "$@"
