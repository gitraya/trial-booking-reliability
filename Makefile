# Quick setup and everyday tasks. Run `make` for the list.
#
# The npm scripts in package.json remain the source of truth; these targets are
# thin wrappers plus the ordering you need to go from a clean checkout to a
# running, seeded app in one command (`make setup`).

.DEFAULT_GOAL := help
.PHONY: help preflight setup install up down dev build start migrate seed reset test test-watch demo typecheck psql logs verify docker-build docker-run docker-stop clean nuke

## help: show this list
help:
	@echo "Trial Booking Reliability"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /' | awk -F': ' '{printf "%-22s %s\n", $$1, $$2}'
	@echo ""
	@echo "First time here?  make setup"

# --- setup -----------------------------------------------------------------

## preflight: check Node, Docker and ports before doing anything
preflight:
	@echo "Checking prerequisites..."
	@command -v node >/dev/null 2>&1 || { echo "  FAIL  node not found — install Node ^20.19, ^22.12 or >=24."; exit 1; }
	@# No '$' anywhere in this script: make would expand it as a variable.
	@node -e 'var v=process.versions.node, p=v.split(".").map(Number); \
	  var ok=(p[0]===20&&p[1]>=19)||(p[0]===22&&p[1]>=12)||p[0]>=24; \
	  if(!ok){console.error("  FAIL  Node "+v+" - need ^20.19, ^22.12 or >=24 (Prisma 7 sets this floor).");process.exit(1);} \
	  console.log("  ok    Node "+v)'
	@command -v docker >/dev/null 2>&1 || { echo "  FAIL  docker not found — install Docker Desktop or Docker Engine."; exit 1; }
	@docker compose version >/dev/null 2>&1 || { echo "  FAIL  'docker compose' (v2) not available. The hyphenated docker-compose v1 will not work."; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "  FAIL  Docker is installed but not running — start it and retry."; exit 1; }
	@echo "  ok    Docker $$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
	@docker compose ps --status running --services 2>/dev/null | grep -q '^db$$' \
	  && echo "  ok    port 5432 (already ours)" \
	  || { lsof -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1 \
	       && { echo "  FAIL  port 5432 is in use by something else — stop it or change the host port in docker-compose.yml."; exit 1; } \
	       || echo "  ok    port 5432 free"; }
	@lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 \
	  && echo "  warn  port 3000 in use — 'make dev' will pick another port" \
	  || echo "  ok    port 3000 free"

## setup: clean checkout -> running, seeded database (start here)
setup: preflight install up migrate seed
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

# --- deployment ------------------------------------------------------------

## docker-build: build the production image Coolify will build
docker-build:
	docker build -t trial-booking:local .

## docker-run: run that image against the local Postgres on :3100
docker-run: docker-build up
	@docker rm -f trial-booking-app >/dev/null 2>&1 || true
	docker run -d --name trial-booking-app \
	  --network trial-booking-reliability_default \
	  -p 3100:3000 \
	  -e DATABASE_URL="postgresql://trial:trial@db:5432/trial_booking?schema=public" \
	  trial-booking:local
	@echo "Started on http://localhost:3100 — logs: docker logs -f trial-booking-app"

## docker-stop: stop and remove that container
docker-stop:
	@docker rm -f trial-booking-app >/dev/null 2>&1 && echo "stopped" || echo "not running"

# --- cleanup ---------------------------------------------------------------

## clean: remove build output
clean:
	rm -rf .next

## nuke: remove build output, node_modules, generated client and the DB volume
nuke: down clean
	rm -rf node_modules src/generated
