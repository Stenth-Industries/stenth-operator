# Deploy

Four steps (§20): update the working tree, build, migrate as its own step, then
start. Migrations run with the migrate role before the new code serves traffic.

## 1. Update the working tree, safely

`git pull` on its own is not safe enough here. It can create a merge commit on
a production box, it can leave the tree on a revision nobody chose, and it says
nothing about whether the result is the revision that was reviewed. This block
refuses to do any of that: it stays on main, fast-forwards or stops, and
verifies the exact commit afterwards.

Set `TARGET` to the reviewed commit. It runs in a subshell, so an abort ends the
block and not your SSH session.

```sh
cd /opt/stenth-operator

( set -eu
  TARGET=<the reviewed commit SHA>

  # The read-only deploy key is configured per-repository. Without it the fetch
  # would fall back to whatever key ssh-agent happens to offer, or hang on a
  # prompt.
  git config --local --get core.sshCommand >/dev/null 2>&1 \
    || { echo "ABORT: no local core.sshCommand - the deploy key is not configured"; exit 1; }

  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  [ "$BRANCH" = "main" ] || { echo "ABORT: on '$BRANCH', not main. Run: git checkout main"; exit 1; }

  # Modified tracked files are the dangerous case: a pull could clobber them.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "ABORT: tracked files are modified - investigate before deploying:"
    git status --short --untracked-files=no
    exit 1
  fi

  # Untracked files are usually harmless, but on this box they are unexpected,
  # so they stop the deploy rather than riding along. .env is ignored and does
  # not appear here.
  UNTRACKED="$(git ls-files --others --exclude-standard)"
  if [ -n "$UNTRACKED" ]; then
    echo "ABORT: untracked files present:"; echo "$UNTRACKED"; exit 1
  fi

  BEFORE="$(git rev-parse HEAD)"
  echo "   remote : $(git remote get-url origin)"
  echo "   before : $BEFORE"

  git fetch --quiet origin main

  # Say why a fast-forward is impossible, instead of leaving pull to guess.
  git merge-base --is-ancestor HEAD origin/main \
    || { echo "ABORT: HEAD is not an ancestor of origin/main - no clean fast-forward"; exit 1; }

  git pull --quiet --ff-only origin main

  AFTER="$(git rev-parse HEAD)"
  [ "$AFTER" = "$TARGET" ] || { echo "ABORT: HEAD is $AFTER, expected $TARGET"; exit 1; }

  echo "   OK     : $BEFORE -> $AFTER"
  git --no-pager log --oneline -1
)
```

Rerunning it when the tree is already at `TARGET` is a no-op that still verifies
the SHA. If it aborts on the branch check, the tree is probably on a detached
HEAD from an earlier rollback: `git checkout main`, then rerun.

## 2. Verify the shell and the file modes before building

A release once reached production with its source copied in at mode 600. The
cause was an earlier `umask 077`, left set in the interactive shell after
creating `.env`, so every file `git pull` then wrote was 600 and every directory
700.

That breaks the build in a way nothing reports at build time, because the Docker
daemon reads the build context as root. Host modes are carried into the image,
and `migrate` and `worker` both run as the non-root `node` user:

| On the host | Inside the image | Result as `node` |
|---|---|---|
| `src/db/migrate.ts` 600 | 600, owned by root | `Permission denied` |
| `src/db/` 700 (nested) | 700 | cannot traverse or list |
| `src/` 755 (the COPY target) | 755 — the destination is normalised | fine |

Only the destination directory gets normalised. Everything nested inside keeps
what the host gave it, which is exactly where `src/db`, `src/jobs`, `src/worker`
and `migrations` live.

Run this before every build. It aborts rather than letting a broken image get
built:

```sh
cd /opt/stenth-operator

( set -eu
  FAIL=0

  CUR="$(umask)"
  case "$CUR" in
    0022|022|0002|002) echo "   umask            $CUR" ;;
    *) echo "   umask            $CUR   <-- not a normal umask"; FAIL=1 ;;
  esac

  if [ -f .env ]; then
    MODE="$(stat -c '%a' .env)"
    if [ "$MODE" = "600" ]; then echo "   .env             600"
    else echo "   .env             $MODE   <-- must stay 600"; FAIL=1; fi
  else
    echo "   .env             MISSING"; FAIL=1
  fi

  # Files keep their host mode inside the image, and migrate and worker run as
  # the non-root 'node' user. The last octal digit must carry read.
  BAD_FILES="$(git ls-files -z | xargs -0 stat -c '%a %n' \
    | awk '{ last = substr($1, length($1)); if (last !~ /^[4-7]$/) print substr($0, index($0, " ") + 1) }')"
  if [ -z "$BAD_FILES" ]; then echo "   tracked files    all readable"
  else
    echo "   tracked files    NOT readable by a non-root user:"
    echo "$BAD_FILES" | sed 's/^/                      /'; FAIL=1
  fi

  # Nested directories keep their host mode too, so they must be traversable
  # and listable: last octal digit 5 or 7.
  BAD_DIRS="$(git ls-files -z | xargs -0 -n1 dirname | sort -u | xargs stat -c '%a %n' \
    | awk '{ last = substr($1, length($1)); if (last !~ /^[57]$/) print substr($0, index($0, " ") + 1) }')"
  if [ -z "$BAD_DIRS" ]; then echo "   tracked dirs     all traversable"
  else
    echo "   tracked dirs     NOT traversable by a non-root user:"
    echo "$BAD_DIRS" | sed 's/^/                      /'; FAIL=1
  fi

  [ "$FAIL" -eq 0 ] || { echo "   ABORT: fix the above before building"; exit 1; }
  echo "   OK: safe to build"
)
```

If it reports bad modes, repair them and rerun it. `git ls-files` is the
selector, which is what keeps `.env` out of reach — it is untracked, so this
cannot weaken it:

```sh
( set -eu
  chmod o+rx,g+rx .
  git ls-files -z | xargs -0 -n1 dirname | sort -u | xargs chmod o+rx,g+rx
  git ls-files -z | xargs -0 chmod o+r,g+r
  echo "   repaired tracked file and directory modes; .env untouched"
)
```

If the umask itself is wrong, restore it in the shell you are deploying from —
`umask 022` — and then repair the modes, because the files are already written.

**Never leave a deploy shell at `umask 077`.** Every block in this runbook that
needs a tight umask sets it inside a subshell, `( umask 077; ... )`, so it
cannot escape into the session. If you ever need it at the prompt, restore it in
the same breath:

```sh
OLD_UMASK="$(umask)"; umask 077; : do the thing; umask "$OLD_UMASK"
```

## 3. Build — including the profile-gated migrate image

```sh
docker compose --profile migrate build
```

**Not plain `docker compose build`.** `migrate` sits behind a Compose profile so
it never starts with `up`, and a profile that is not enabled is not built
either. Plain `docker compose build` exits 0, reports success, and silently
builds only `web` and `worker` — measured on this stack:

```text
$ docker compose build
Image stenth-operator-web     Built
Image stenth-operator-worker  Built
# migrate image: absent
```

`docker compose run` does not save you. It builds the image when it is
**missing**, but never because the source moved: with a previous release's
migrate image already present, `run` reuses it — same image id, no "Building"
line, no warning. That is how a release once ran the *previous* version's
migration step. `docker compose --profile migrate build` makes it a non-event;
`docker compose build migrate web worker` works too, by naming every service.

This matters most for exactly the releases where it is most dangerous: any
release that adds or changes a migration.

## 4-5. Migrate, then start

```sh
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

The build command is `docker compose --profile migrate build`, for the reason in
step 3 above. Check the headroom before and after:

```sh
free -m
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'
```

Ports 80 and 443 belong to the existing Caddy and Operator publishes neither.
How the public `/optout` route and the private dashboard get served is an open
decision — see ops/deviations.md.

## Rollback

Rolling back the source is not enough once a release has added a **container**.
Reverting the revision changes what the next build produces; it does nothing to
a service that is already running. A rollback that only rebuilds web would leave
the newer worker and its scheduler running against the older application — so
the containers the release added come down **first**, while the compose file
that defines them is still checked out.

The order matters, and so does what it never touches:

```sh
cd /opt/stenth-operator

# 1. Stop and remove the containers this release added, BEFORE reverting the
#    source. Only the compose file currently checked out knows these services
#    exist; revert first and you cannot address them by name any more.
docker compose stop worker
docker compose rm -f worker

# 2. Free the build headroom. Postgres stays up throughout.
docker compose stop web
free -m

# 3. Revert the application revision. Ignored files, .env included, are
#    untouched by a checkout.
git -c advice.detachedHead=false checkout <previous release SHA>
git --no-pager log --oneline -1

# 4. Rebuild and start what that revision defines. The profile flag keeps the
#    migrate image in step with the reverted source, and is harmless on a
#    revision that has no such service.
docker compose --profile migrate build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 5. Verify.
docker compose ps                      # web healthy; no worker container at all
docker ps -a --filter 'name=stenth-operator-worker' --format '{{.Names}}'
                                       # must print nothing
docker compose exec web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"

# 6. Confirm the other stack is untouched, against the before-picture.
docker ps --format 'table {{.Names}}\t{{.Status}}'
free -m
```

If the source was already reverted before the worker was removed, the container
is an orphan of a service the current compose file no longer declares. Remove it
with `docker compose up -d --remove-orphans`, which is scoped by the
`stenth-operator` project name and therefore cannot reach `/opt/stenth`.

**Migrations are never rolled back.** They are forward-only (§3, §20), so a
reverted release runs against the newer schema, and that has to be safe by
construction rather than by luck: a migration only ever adds. An older release
simply does not use what it does not know about. Where a release genuinely has
to undo a schema change, the answer is a new forward migration, never a down
migration and never a restored volume.

**Never, on this box:** `docker compose down -v` or any other route to deleting
the Postgres volume — it holds every prospect, assessment and approval;
`docker system prune` or `docker volume prune`, which reach the other stack's
resources; and anything at all run from `/opt/stenth`.

Afterwards the tree is on a detached HEAD, which the deploy block in step 1
refuses to pull into. Return to the branch with `git checkout main` when rolling
forward again.

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

## The fetcher

Day 3 adds the `fetcher` container: the only process that opens a connection to
the public internet and the only one that handles hostile input. It publishes
**no host port** — the worker reaches it at `http://fetcher:8081` on the
project's own network.

It needs two values in `.env`:

| Variable | Why |
|---|---|
| `FETCHER_SHARED_SECRET` | The worker authenticates with it; the fetcher rejects anything else. `openssl rand -hex 32` |
| `FETCH_DATABASE_URL` | Its connection as `operator_fetch` |

And the worker needs `FETCHER_URL` plus the same shared secret. All three are in
`.env.example`.

The fetcher refuses to start if `MODEL_API_KEY` appears in its environment: it
holds no model credential, and that is enforced rather than documented.

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

`operator_sched` and its password already exist; migration 002 created the role
on Day 1. So the line is derived from what `.env` already holds rather than
generated afresh, and the block below can be rerun safely: it appends nothing
the second time, and it refuses to rewrite a credential that disagrees with
`OPERATOR_SCHED_PASSWORD` rather than guessing which one is right.

```sh
cd /opt/stenth-operator

( set -eu
  umask 077
  [ -f .env ] || { echo "ABORT: .env not found in $(pwd)"; exit 1; }

  SCHED_PW="$(sed -n 's/^OPERATOR_SCHED_PASSWORD=//p' .env | head -n1)"
  [ -n "$SCHED_PW" ] || { echo "ABORT: OPERATOR_SCHED_PASSWORD is not set in .env"; exit 1; }
  WANT="postgresql://operator_sched:${SCHED_PW}@postgres:5432/operator"

  COUNT="$(grep -cE '^SCHED_DATABASE_URL=' .env || true)"
  EXISTING="$(sed -n 's/^SCHED_DATABASE_URL=//p' .env | head -n1)"

  if [ "$COUNT" -gt 1 ]; then
    echo "ABORT: .env has $COUNT SCHED_DATABASE_URL lines. Remove the extras by hand."
    exit 1
  elif [ "$COUNT" -eq 1 ]; then
    if [ "$EXISTING" = "$WANT" ]; then
      echo "OK: SCHED_DATABASE_URL already present and correct - nothing to do"
    else
      echo "ABORT: SCHED_DATABASE_URL is present but does not match OPERATOR_SCHED_PASSWORD."
      echo "       Resolve by hand; this will not rewrite a credential for you."
      exit 1
    fi
  else
    # A .env with no trailing newline would otherwise get the new line glued on
    # to the last one.
    if [ -s .env ] && [ "$(tail -c1 .env | wc -l)" -eq 0 ]; then
      printf '\n' >> .env
    fi
    printf 'SCHED_DATABASE_URL=%s\n' "$WANT" >> .env
    echo "OK: SCHED_DATABASE_URL added"
  fi

  chmod 600 .env
  echo "   SCHED_DATABASE_URL lines: $(grep -cE '^SCHED_DATABASE_URL=' .env)"
)
```

The password never appears in a command line or in shell history: it is read
into a variable and written by bash's `printf` builtin, which spawns no process.

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

`ADMIN_DATABASE_URL` must be the bootstrap superuser (`postgres`), not merely a
role with `CREATEROLE`. Beyond creating the roles, the step takes the
`pg_advisory_*` functions away from `PUBLIC` and grants them to
`operator_sched` alone, so that a compromised fetcher cannot hold the
scheduler's lock key and stall every tick. PostgreSQL ignores a `REVOKE` issued
by a role that does not own `pg_catalog` — quietly, with only a warning — so the
step verifies the result and **fails the migration** rather than reporting
success on a control that did not apply. If you see
`The advisory-lock namespace is still executable by PUBLIC`, fix
`ADMIN_DATABASE_URL` and re-run; nothing has been half-applied.

| Role | Holds |
|---|---|
| `operator_app` | DML on application tables. The web app and the worker |
| `operator_fetch` | Insert into `web_snapshots` and read back only its `id`, `company_id`, `url` and `content_hash`; maintain `robots_cache`. Nothing else — the fetcher service only, and it cannot read the page text it writes |
| `operator_sched` | Read and update `schedules`, insert into `jobs`, and the advisory-lock namespace — no other role can take the scheduler's key |
| `operator_migrate` | DDL. The migration step only; owns every table |
| `operator_ro` | Read-only, for ad-hoc queries |
