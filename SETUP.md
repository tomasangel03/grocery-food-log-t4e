# FoodLog setup

The app runs as an Express server. Locally it talks to PostgreSQL in Docker. The same schema and `DATABASE_URL` are what you will point at Supabase, and the same server is what Vercel will host.

## Localhost

`.env` should contain:

```
PORT=3000
DATABASE_URL=postgres://foodlog:foodlog@localhost:5432/foodlog
JWT_SECRET=change-me-to-a-long-random-string
```

Copy `.env.example` to `.env` if you do not already have one. Then install dependencies:

```bash
npm install
```

If `npm install` fails with a certificate error, run `npm install --strict-ssl=false`.

### Without Docker

This machine can start PostgreSQL from the binaries in the `embedded-postgres` dev dependency. In one terminal, leave this process running:

```bash
npm run db:local
```

The first run creates a data directory at `%LOCALAPPDATA%\foodlog-pg` and applies `migrations/001_schema.sql`. In a second terminal:

```bash
npm run seed
npm start
```

### With Docker

If Docker Desktop is installed, you can use that instead of `npm run db:local`:

```bash
docker compose up -d
npm run seed
npm start
```

The first start creates the `foodlog` database and applies the migration. If port 5432 is already taken, stop the other Postgres or change the host port in `docker-compose.yml` and in `DATABASE_URL` together.

### Check that it works

Open http://localhost:3000 and sign in as `tomas` / `ChangeMe123!`. `GET http://localhost:3000/health` should return `{ "status": "ok", "db": "connected" }`.

## Supabase (do this after localhost works)

1. Create a project at [supabase.com](https://supabase.com). Save the database password when it is shown. You cannot view it again later; you can reset it.
2. Open the SQL Editor and paste the full contents of `migrations/001_schema.sql`. Run it once.
3. Open Project Settings, then Database. Copy the **Session pooler** connection string. The host looks like `aws-0-<region>.pooler.supabase.com` and the port is **5432**.
4. Use that string as `DATABASE_URL`. Put the database password in the URI, not the anon key and not the service role key. Those keys are for the Supabase HTTP API. This app connects with the Postgres driver.
5. The URI needs SSL. Append `?sslmode=require` if it is not already there. `db.js` turns SSL on for any host that is not localhost.
6. Do not use the transaction pooler on port **6543**. That mode drops the session state this Node pool expects.

From your machine you can point `.env` at that URI and run `node scripts/seed.js` again to create the admin user in Supabase. Then `node scripts/smoke-db.js` should print the Supabase database name.

## Vercel (do this after the database is on Supabase)

1. Push this repo to GitHub. `.env` is gitignored. Do not commit it.
2. At [vercel.com](https://vercel.com), import the GitHub repo. Framework preset: **Other**.
3. `vercel.json` already sends every path to `server.js`. On Vercel the file exports the Express app and does not call `listen`.
4. In the Vercel project, set these environment variables:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Supabase session pooler URI, with `sslmode=require` |
| `JWT_SECRET` | A long random string, different from the localhost default |
| `GOOGLE_CLIENT_ID` | From Google Cloud, when you turn Google sign-in on |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud |
| `GOOGLE_OAUTH_REDIRECT_URL` | `https://<your-app>.vercel.app/v1/auth/google/callback` |

5. Deploy. Open `https://<your-app>.vercel.app/health`. A working deploy returns `{ "status": "ok", "db": "connected" }`.
6. In Google Cloud, add that same callback URL to the OAuth client's authorized redirect URIs before testing Google sign-in.

The monthly rollup in `jobs/monthlyStats.js` uses a process scheduler. It runs while `npm start` keeps the process up on your machine. A Vercel function does not stay running, so that job will not fire there. Replacing it with a Vercel Cron is a later change.
