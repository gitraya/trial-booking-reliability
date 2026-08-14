# Quick setup and everyday tasks. Run `make` for the list.
#
# The npm scripts in package.json remain the source of truth; these targets are
# thin wrappers plus the ordering you need to go from a clean checkout to a
# running, seeded app in one command (`make setup`).

.DEFAULT_GOAL := help
.PHONY: help setup install up down dev build start migrate seed reset test test-watch demo typecheck psql logs verify clean nuke

## help: show this list
help:
	@echo "Trial Booking Reliability"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /' | awk -F': ' '{printf "%-22s %s\n", $$1, $$2}'
	@echo ""
	@echo "First time here?  make setup"

# --- setup -----------------------------------------------------------------

## setup: clean checkout -> running, seeded database (start here)
setup: install up migrate seed
	@echo ""
	@echo "Ready. Next:"
	@echo "  make dev        # http://localhost:3000"
	@echo "  make test       # 17 tests against real Postgres"
	@echo "  make demo       # live last-seat race"

## install: install npm dependencies
install:
	npm install

## up: start Postgres in Docker and wait until it is healthy
up:
	npm run db:up

## down: stop Postgres and DELETE its volume
down:
	npm run db:down

# --- app -------------------------------------------------------------------

## dev: run the dev server on http://localhost:3000
dev:
	npm run dev

## build: production build
build:
	npm run build

## start: run the production server (needs `make build` first)
start:
	npm start

# --- database --------------------------------------------------------------

## migrate: apply migrations (incl. the hand-written partial unique index)
migrate:
	npm run db:migrate

## seed: truncate and reseed the fixture classes
seed:
	npm run seed

## reset: drop, re-migrate and reseed. Destroys all local data.
reset:
	npx prisma migrate reset --force
	npm run seed

## psql: open a psql shell against the local database
psql:
	docker compose exec db psql -U trial -d trial_booking

## logs: tail the Postgres container logs
logs:
	docker compose logs -f db

# --- checks ----------------------------------------------------------------

## test: run the full suite against real Postgres (wipes seed data)
test: up
	npm test

## test-watch: run the suite in watch mode
test-watch: up
	npm run test:watch

## typecheck: tsc --noEmit
typecheck:
	npm run typecheck

## verify: typecheck + build + tests, then restore the seed data
verify: typecheck build test seed

## demo: live last-seat race against the seeded database
demo:
	npm run demo:race

# --- cleanup ---------------------------------------------------------------

## clean: remove build output
clean:
	rm -rf .next

## nuke: remove build output, node_modules, generated client and the DB volume
nuke: down clean
	rm -rf node_modules src/generated
