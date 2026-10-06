# Deploy

Four commands (§20). Migrations run as their own step, with the migrate role,
before the new code serves traffic.

```sh
git pull
docker compose build
docker compose run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## On the shared host, first

stenth-engine also runs the `/opt/stenth` stack — the existing Caddy and two
n8n instances, one of them production for a paying client. **Nothing under
`/opt/stenth` is ours to modify, restart or redeploy.**

Operator lives in its own directory (`/opt/stenth-operator`), its own Compose
project (`stenth-operator`, set by `name:` in the compose file) and its own
network (`stenth-operator_internal`). Always run the commands above from
Operator's own directory, so `docker compose down` can only ever reach
Operator's containers.

Every Operator container carries a `mem_limit`: postgres 1 GiB, web 512 MiB,
worker 384 MiB, and the migration step 256 MiB while it runs. Steady state is
1.875 GiB. The box has roughly 2.7 GB free of 4 GB, so an Operator container
that balloons hits its own ceiling instead of starving the client's n8n.

A cold image build needs about another 850 MiB (measured, not estimated), so
**build with the stack down, or at least with web and worker stopped** — on a
redeploy, 1.875 GiB resident plus a build does not leave comfortable headroom.
Check before and after:

```sh
free -m
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'
```

Ports 80 and 443 belong to the existing Caddy and Operator publishes neither.
How the public `/optout` route and the private dashboard get served is an open
decision — see ops/deviations.md.

Rollback is the previous image tag plus a forward-fix migration — never a
down-migration (§3, §20).

## Checks after a deploy

```sh
# Over Tailscale, never from the public internet (§20).
curl -fsS http://<tailscale-ip>:3000/api/health | jq .
```

`status` must be `ok`. The report also carries queue depth, the age of the last
successful job, the age of the last scheduler tick, and month-to-date spend
against the $50 ceiling (§2, §16, §20).

## If the app cannot authenticate to Postgres after a deploy

`password authentication failed for user "operator_app"` almost always means the
database volume predates the `.env` it is being given. `POSTGRES_PASSWORD` is
read by the postgres image **only when it initialises an empty data directory**,
so rotating passwords in `.env` does not change the ones already in the
database. The roles that Operator uses are a separate matter — the migration
step resets those on every run — but the `postgres` superuser password in
`ADMIN_DATABASE_URL` is not.

Rotating the superuser password therefore means changing it in the database, not
just in the file:

```sh
docker compose exec postgres psql -U postgres -c "ALTER ROLE postgres PASSWORD '<new value from .env>';"
```

Never reach for `docker compose down -v` on the VPS to resolve this. That
deletes the volume and every prospect, assessment and approval in it. It is the
right move only on a throwaway local stack.

## The worker

Day 2 adds the `worker` container: the claim loop with four handlers in-process,
plus one timer running the scheduler and the reaper (§6). It publishes no host
port and talks only to Postgres over the internal network.

It needs **two** connection strings, and that is deliberate (§17):

| Variable | Role | Why |
|---|---|---|
| `DATABASE_URL` | `operator_app` | Claims jobs, records attempts, writes events |
| `SCHED_DATABASE_URL` | `operator_sched` | Reads and advances schedules, inserts jobs, writes the heartbeat. Cannot read a contact, a draft, or even a job's payload |

A missing `SCHED_DATABASE_URL` stops the worker at startup with an explanation.
It is intentionally not marked required in the compose file: `${VAR:?...}` makes
every compose command fail when the variable is absent — `down` and `logs`
included — which would leave the stack un-stoppable over one missing line.

After a deploy, confirm the scheduler is alive rather than merely running:

```sh
curl -fsS http://<tailscale-ip>:3000/api/health | jq .last_scheduler_tick_age_seconds
```

A number under ~120 means the timer ticked. `null` means it never has, which is
what a dead scheduler looks like — and the reason migration 003 exists, since
`schedules.last_run_at` stays null when nothing is due.

## The database roles

The migration step creates the five roles of §17 and sets their passwords from
`.env`. It needs `ADMIN_DATABASE_URL`; the web and worker containers do not have
it, and must not.

| Role | Holds |
|---|---|
| `operator_app` | DML on application tables. The web app and the worker |
| `operator_fetch` | Insert into `web_snapshots`, maintain `robots_cache`. Nothing else — the fetcher service only |
| `operator_sched` | Read and update `schedules`, insert into `jobs` |
| `operator_migrate` | DDL. The migration step only; owns every table |
| `operator_ro` | Read-only, for ad-hoc queries |
