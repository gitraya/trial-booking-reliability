# Deploying to Coolify

The app ships as a single container built from the repo's `Dockerfile`. Coolify builds it from source on each deploy; there is no registry in the loop.

Coolify's UI wording shifts between releases, so treat the labels below as "find the field that does this" rather than exact strings. Everything specific to this app — the port, the health path, the one required variable — is exact.

---

## 1. Create the database first

**New Resource → Database → PostgreSQL.** Use **PostgreSQL 18** to match local development and CI.

Put it in the **same Coolify project** as the application. That is what puts both containers on one internal network so the app can reach the database by service name.

Once it starts, copy its **internal** connection URL — the one using the service hostname, not the public host/port. It looks like:

```
postgresql://postgres:SOME_PASSWORD@abcdef123456:5432/postgres
```

Use the internal URL. The public one routes out and back through the host for no reason, and exposing Postgres publicly is not something this app needs.

## 2. Create the application

**New Resource → Application → Private (or Public) Repository.**

| Setting | Value |
|---|---|
| Branch | `main` |
| Build Pack | **Dockerfile** |
| Dockerfile location | `/Dockerfile` |
| Port | `3000` |
| Health check path | `/api/health` |

Coolify may default to Nixpacks — switch it to Dockerfile, or it will try to infer the build and miss the `prisma generate` step.

## 3. Set the environment variable

Under the application's **Environment Variables**, add one:

```
DATABASE_URL=postgresql://postgres:SOME_PASSWORD@abcdef123456:5432/postgres
```

That is the only variable the app requires. `NODE_ENV`, `PORT` and `HOSTNAME` are already set in the image.

If `DATABASE_URL` is missing the container exits immediately with `FATAL: DATABASE_URL is not set` rather than starting and failing obscurely later.

## 4. Deploy

Hit **Deploy**. The first build takes a few minutes; later ones reuse layer cache.

On every container start, before the server accepts traffic:

```
==> Applying database migrations
...
==> Starting server on 0.0.0.0:3000
```

The entrypoint runs `prisma migrate deploy`, which only applies pending migrations. It never resets, never generates SQL, never prompts, and takes an advisory lock so concurrent starts serialize instead of racing. A schema change ships by committing a migration — no manual step on the VPS.

If a migration fails the container exits and Coolify keeps the previous version running.

## 5. Verify

```bash
curl https://your-domain/api/health
# {"status":"ok","database":"up"}
```

The health check deliberately queries the database, so a container that cannot reach Postgres reports `503` and Coolify will not route to it. Then open the site — the class list should render with the "Nothing here yet" empty state, since a fresh database has no data.

---

## Seeding a fresh deployment

**The seed script deletes every row before inserting.** It is demo data, not migration data.

It refuses to run when `NODE_ENV=production` unless you also set `ALLOW_DESTRUCTIVE_SEED=yes`, specifically so it cannot be triggered by accident against real data.

The seed is also **not in the runtime image** — it is TypeScript run through `tsx`, and neither is installed there. That is deliberate: the container has no way to wipe its own database.

So for a demo instance, run it from your machine against the deployed database. Expose the database's public endpoint temporarily (or tunnel to it), then:

```bash
DATABASE_URL="postgresql://postgres:PASSWORD@your-vps:5432/postgres" \
ALLOW_DESTRUCTIVE_SEED=yes npm run seed
```

Close the public endpoint afterwards. For anything with real users, don't seed at all — let the app start empty and create data through the UI.

## Auto-deploy on push

Enable **Auto Deploy** on the application and Coolify installs a webhook on the repo, redeploying on every push to the tracked branch.

Worth pairing with a branch protection rule requiring the **CI** workflow to pass, so a red build cannot auto-deploy. CI builds this exact `Dockerfile`, so a broken image is caught before it reaches the VPS.

## Resource notes

- **Image size is ~740 MB.** Most of it is the Prisma CLI's dependency closure, which is in the runtime image because migrations run at container start. It cannot be trimmed much — `prisma/build/cli.js` eagerly requires both `@prisma/studio-core` and `@prisma/dev` at module load, so those apparently-dead packages break every deploy if removed. Both were tried; see the comments in the `Dockerfile`.
- **Memory:** comfortable in 512 MB; 1 GB gives headroom for builds. Building on a 1 GB VPS is tight — if the build OOMs, build elsewhere and deploy the image instead.
- The container runs as a non-root user (`nextjs`, uid 1001) and uses `tini` as PID 1 so signals are forwarded and it stops promptly.

## Backups

Coolify can schedule Postgres backups from the database resource — turn them on. The application container holds no state; everything lives in Postgres.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container exits with `FATAL: DATABASE_URL is not set` | Variable missing or set on the wrong resource. |
| Migrations hang, then time out | App and database are in different Coolify projects, so the internal hostname does not resolve. |
| Health check fails but the site loads | The database went away after boot; `/api/health` is doing its job. |
| Build fails on `prisma generate` | `.dockerignore` is excluding `prisma/` — it must not. |
| Deploy succeeds but shows no classes | Expected on a fresh database. See seeding above. |
