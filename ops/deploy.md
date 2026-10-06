# Deploy

Four commands (§20). Migrations run as their own step, with the migrate role,
before the new code serves traffic.

```sh
git pull
docker compose build
docker compose run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

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
