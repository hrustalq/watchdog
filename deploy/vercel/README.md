# Temporary Vercel deployment

This is the free split deployment: **web on Vercel**, **Postgres on Supabase**, and the **worker
with Obscura on a machine that stays awake** (the Mac mini). Vercel cannot run the worker: it is a
long-running process with a pg-boss poller, and Vercel Functions have no always-on process. Web and
worker talk only through Postgres, so the split changes nothing in the product.

It is meant to be temporary. When the self-hosted stack gets its own host, this becomes the same
five containers as `compose.yaml`, and the database moves with `pg_dump`/`pg_restore`.

## What is free

| Piece | Plan | Limits that matter |
| --- | --- | --- |
| Web | Vercel Hobby | $0, **non-commercial only**, 100 GB bandwidth and 1M function invocations a month, 300 s per function, cold starts. |
| Postgres | Supabase Free | $0, 500 MB database, shared CPU, 5 GB egress, pauses after a week without activity (the worker keeps it active). |
| Worker + Obscura | This machine | $0 beyond the machine you already run. It must stay awake; a reboot pauses polling and sending until it comes back. |
| Mail (optional) | Resend Free or none | Without SMTP, magic links go to the Vercel function log. Resend's free tier is 3,000 mails a month. |
| Domain | `*.vercel.app` | $0. A custom domain is optional. |

Vercel's Hobby plan forbids commercial use. If this deployment stops being a demo, move to a paid
Vercel plan or finish the self-hosted migration.

## 1. Create the database

1. Create a Supabase project in **Central EU (Frankfurt)** (`eu-central-1`), the same region as the
   Vercel functions (`fra1` in `apps/web/vercel.json`). Save the database password.
2. Open **Connect**. Copy two connection strings, both with `?sslmode=require`:
   - **Session pooler**, port **5432** — for the worker. Its pg-boss pool is a long-lived client that
     expects a persistent session (advisory locks, and LISTEN/NOTIFY if a queue enables it), which
     transaction mode cannot hold.
   - **Transaction pooler**, port **6543** — for web on Vercel, where each function instance opens a
     few short-lived connections.

   The user is `postgres.<project-ref>` on both. Copy the host exactly from **Connect**; its
   `aws-0-…` or `aws-1-…` prefix varies by region. If the database password contains any of `@ : /
   ? # %`, percent-encode it in the URL. Do not use the direct connection: Supabase's direct
   endpoint is IPv6-only, and this machine has no IPv6 route.

Supabase Free is 500 MB. Watchdog keeps Items for 90 days by default, so a busy install can reach
that; the Settings screen's retention is the first knob to lower.

## 2. Configure and start the worker

From the repo root:

```bash
cd deploy/vercel
cp .env.example .env
# Fill in DATABASE_URL (session pooler), BETTER_AUTH_URL and the generated secrets.
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs -f worker
```

`.env` in `deploy/vercel/` is ignored by git (the root `.gitignore` covers `.env*`); the filled file
stays on this machine. Compose loads it twice: for `${OBSCURA_CDP_TOKEN}` interpolation, and as the
worker's environment.

The worker applies the pending migrations on boot, so the first start writes the public schema and
pg-boss's own schema to Supabase. Wait for both lines:

```text
Migrations applied
Worker ready (self-hosted): pg-boss started
```

The worker is the only process that migrates, as in the full Compose stack. If you restart it, it
skips applied migrations. To apply them by hand instead:

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' deploy/vercel/.env)" \
  pnpm --filter @watchdog/db db:migrate
```

## 3. Create the Vercel project

1. In Vercel, **Add New → Project**, import `hrustalq/watchdog`.
2. Set **Root Directory** to `apps/web`. Leave the framework as Next.js; `apps/web/vercel.json`
   supplies the install and build commands, and `engines.node` in `apps/web/package.json` pins
   Node 26 (`26.x`).
3. Add the variables from `deploy/vercel/vercel.env.example`. The three secrets must be **identical**
   to the worker's `.env`:
   - `BETTER_AUTH_SECRET` — sessions and unsubscribe links.
   - `WATCHDOG_ENCRYPTION_KEY` — every stored secret; changing it later makes them unreadable.
   - `OBSCURA_CDP_TOKEN` — shared with Obscura.
4. Set `BETTER_AUTH_URL` to the project's production address (`https://<project>.vercel.app`) or
   your custom domain. Magic links, OAuth callbacks and alert links are built on it.
5. Deploy.

With Google or GitHub sign-in, register `<BETTER_AUTH_URL>/api/auth/callback/google` (an
authorized redirect URI) and `<BETTER_AUTH_URL>/api/auth/callback/github` (the OAuth app's callback
URL) before expecting the buttons to work. GitHub sign-in also gives GitHub Sources their token.

The first deploy may fail if `BETTER_AUTH_URL` is not known yet. Copy the production domain from the
project, set it, and redeploy. `BETTER_AUTH_URL` must be the address people actually open; preview
deployment URLs won't sign in correctly.

Optional but recommended: set the `SMTP_*` variables in both Vercel and `deploy/vercel/.env` (for
example Resend: `smtp.resend.com`, port 587, user `resend`, password = API key, a verified `From`
address). Without them, self-hosted prints each magic link to the Vercel function log and the worker
does not send alert mail.

## 4. Claim the install

The first-run admin link is printed by instrumentation at boot on a normal self-hosted install. On
Vercel, every cold start is a new boot, and every boot would rotate the token, so the Vercel build
skips that print. Run the setup command once instead:

```bash
pnpm --filter @watchdog/web setup-url
```

It reads `deploy/vercel/.env`, creates (or replaces) the setup token, and prints:

```text
https://<project>.vercel.app/setup?token=...
```

Open it, enter the admin's email, and follow the magic link. Without SMTP, that link is in the Vercel
project's **Logs** for the invocation that sent it; search for `Open this link to sign in`. Hobby
keeps runtime logs for one hour, so copy it then, or set the SMTP variables. The first sign-in makes
that user the instance admin and retires the token. Sign-up is closed afterwards by default; the
admin can open it on the Settings screen.

If the link says it is out of date, run `setup-url` again. Any run replaces the previous token.

## 5. Check it end to end

1. Sign in. The Feed is empty and says to add a Source.
2. Add an RSS Source. The web app only writes the row; the worker on this machine polls it. Within a
   minute or two, entries appear in the Feed as the Backfill.
3. Optional: add a model and a Classifier, then a Source, and check that Items are rated.
4. Check the worker log for poll errors if nothing arrives:
   `docker compose -f deploy/vercel/compose.yaml logs --tail=100 worker`.
5. Webhooks: the inbox URL is on the Source's Inbox screen. It posts to Vercel, which inserts the
   Item and its job into Supabase; the worker picks it up.

## Operating notes

- **Two URLs, one database.** Web uses the transaction pooler (6543), the worker the session pooler
  (5432). Swapping them breaks either pg-boss's session state or the function's connection budget.
- **Secrets must match.** `BETTER_AUTH_SECRET`, `WATCHDOG_ENCRYPTION_KEY` and `OBSCURA_CDP_TOKEN` are
  read by both halves. A mismatch surfaces as failed Agent calls, unreadable stored keys or sessions
  that don't stick.
- **Changing `BETTER_AUTH_URL`** changes every link already sent and every OAuth callback. Update
  Vercel, `deploy/vercel/.env`, then restart the worker.
- **Vercel cold starts** add a few hundred milliseconds to a page. The web process caps its Drizzle
  pool at three connections per instance (`config.serverless`); the inbox's pg-boss sender adds two
  at most.
- **No web access to the worker.** Vercel never calls this machine. If the Mac mini is off, the UI
  still works but no Source is polled and no alert or Digest is sent.
- **No Chromium fallback.** The split Compose file runs Obscura only. A Source that needs the
  Chromium renderer is unavailable until the full stack runs.
- **Migrations on deploy.** The worker applies them when it restarts, before web serves a request
  against the new schema. Deploy the worker first when a release has a migration, as the full stack's
  startup order does.
- **A release changes two places.** Vercel redeploys web from `main`; on this machine, pull and rebuild
  the worker: `git pull && docker compose -f deploy/vercel/compose.yaml up -d --build`. The worker
  applies any new migrations on that restart.

## Moving to self-hosted

When the host is ready:

1. Run the full `compose.yaml` there with the real `.env`, bound to the final domain.
2. Dump Supabase through the session pooler and restore into the Compose Postgres:
   `pg_dump "$DATABASE_URL" --no-owner --no-acl | psql "$SELF_HOSTED_DATABASE_URL"`.
3. Copy `BETTER_AUTH_SECRET`, `WATCHDOG_ENCRYPTION_KEY` and `OBSCURA_CDP_TOKEN` unchanged, so existing
   sessions, encrypted secrets and unsubscribe links keep working.
4. Set `BETTER_AUTH_URL` to the final domain; update OAuth callbacks and any webhook senders.
5. Stop the Vercel project and the `deploy/vercel` Compose stack, and delete the Supabase project
   after a backup.
