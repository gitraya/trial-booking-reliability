# Production image for Coolify. Multi-stage: the runtime layer carries only the
# Next.js standalone bundle plus what `prisma migrate deploy` needs at boot.

# ---------- deps ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The Prisma client is generated TypeScript source under src/generated and is
# gitignored, so it must be generated before the Next build can typecheck.
RUN npx prisma generate

# DATABASE_URL is not needed to build — no page is statically prerendered from
# the database (every route is force-dynamic). A placeholder keeps the client
# constructor's env check happy if any module is evaluated during the build.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- prisma CLI ----------
# `prisma migrate deploy` runs at container start, so the CLI needs to be in the
# runtime image. Cherry-picking node_modules/prisma out of the build stage does
# not work: its dependency closure (@prisma/config -> effect, ...) is hoisted to
# the top level. Installing it standalone here gets a complete, self-contained
# tree at the version pinned in package.json.
FROM node:24-alpine AS prisma-cli
WORKDIR /pcli
COPY package.json ./
RUN npm install --no-save --omit=optional \
      "prisma@$(node -p "require('./package.json').devDependencies.prisma")" \
 && rm package.json \
 # Only type definitions are safe to drop. Do NOT prune the CLI's Studio or
 # dev-server packages to save space, however dead they look in a runtime
 # image: prisma/build/cli.js eagerly requires '@prisma/studio-core/data/bff'
 # and '@prisma/dev/internal/state' at module load, so removing either breaks
 # every deploy. Both were tried and reverted; the entrypoint migrates on each
 # start, so a bad prune fails the deploy loudly rather than silently.
 && rm -rf node_modules/@types

# ---------- runtime ----------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache tini \
  && addgroup -g 1001 -S nodejs \
  && adduser -u 1001 -S nextjs -G nodejs

# CLI first, app second: where the two node_modules trees overlap, the
# application's traced copies must win.
COPY --from=prisma-cli --chown=nextjs:nodejs /pcli/node_modules ./node_modules

# The standalone bundle ships its own minimal node_modules plus server.js;
# static assets are not included in it and must be copied alongside.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Schema + migration SQL, needed by `migrate deploy` at boot.
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma

# The dev prisma.config.ts imports dotenv, which is not in this image. The
# production variant reads DATABASE_URL straight from the environment.
COPY --from=build --chown=nextjs:nodejs /app/prisma.config.production.ts ./prisma.config.ts

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs
EXPOSE 3000

# tini reaps zombies and forwards signals, so the container stops promptly.
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
