# STENTH Operator V1

Discovers, researches, qualifies and ranks Australian law-firm prospects, and
prepares personalised outreach for a human to approve.

**It cannot send mail.** Not by policy — by construction. There is no mail
credential in the environment, no mail-capable package in the dependency tree,
and no table for a token. Approval writes an immutable record of exactly what a
human authorised; the human then opens their own Gmail and presses send.

The specification is frozen and authoritative:
[`docs/SPEC.md` in Website-Change](https://github.com/Stenth-Industries/Website-Change/blob/main/docs/SPEC.md)
at commit `0bd3b16`. Build from it; raise a concrete blocker rather than
redesigning.

## Status

Day 1 of 10 complete. See `ops/deviations.md` for the two open questions about
the target host.

| Day | State |
|---|---|
| 1 — repo, config, Compose with Postgres, migration 001, five DB roles, `/api/health`, pino with trace ids, CI | Done and deployed |
| 2 — job engine: enqueue, claim, retries, backoff, reaper, `job_runs`, events, and the in-process scheduler under an advisory lock | Done |
| 3 — the fetcher as its own service: SSRF guard, caps, robots, politeness, HTML to text, `web_snapshots`, narrow role, authenticated internal endpoint | Done |
| 4 — isolated extraction and the Tier A scanner | Not started |

Day 3 registers one handler, `web.fetch`. The worker never opens a socket to
the public internet: it asks the fetcher, which is the only process that
touches hostile input and the only one that can store a snapshot.

## Local development

Needs Node 22 and Docker.

```sh
cp .env.example .env     # then set real values; chmod 600
npm install
npm run lint             # no mail capability (SPEC.md §23)
npm run typecheck
npm test                 # set TEST_ADMIN_DATABASE_URL for the reliability suite
```

To bring the stack up:

```sh
docker compose build
docker compose run --rm migrate
docker compose up -d web
curl -fsS http://127.0.0.1:3000/api/health | jq .
```

`status` must be `ok`. The report carries database connectivity, queue depth,
the age of the last successful job, the age of the last scheduler tick, and
month-to-date spend against the $50 ceiling.

On a network that terminates TLS on an inspecting proxy, pass its CA bundle for
the install step: `NPM_CA_FILE=/path/to/ca.crt docker compose build`.

## Layout

Flat, deliberately (§19). Directories arrive on the day that needs them.

```
migrations/   numbered SQL, forward-only, never edited once applied
src/
  app/        Next.js: api/health today; the approval queue on Day 8
  db/         client, schema, the migration runner, the health report
  jobs/       kinds and dedupe keys, enqueue, the queue's transitions
  worker/     the claim loop, scheduler, reaper, cron, handlers
  fetch/      the SSRF guard, policy, robots, html-to-text, politeness
  fetcher/    server.ts — the internal fetch service, and its contract
  obs/        trace ids, logging
  config.ts   zod-validated env, fails fast on boot
ops/          deploy, Tailscale, open deviations
tests/        unit/, reliability/
```

## The trust boundary

`src/fetch/` and `src/fetcher/` run in their own container, as the only process
that opens a connection to the public internet. It holds no model key, no mail
credential, no application or scheduler database role, and no host port. Its
database role can add a snapshot and maintain the robots cache it obeys — it
cannot read back the page text it just stored, let alone a contact or a draft.

Everything that crosses back into the privileged zone is parsed with Zod first.
Page content stays untrusted all the way to Day 4's isolated model call.

## The rules that keep it this shape

1. No new top-level directory without a written reason in the commit message.
2. No abstraction, interface or base class with a single caller.
3. Migrations are forward-only and are never edited once applied. CI enforces
   this on pull requests, and the runner refuses a file whose checksum moved.
4. `src/ai/isolated.ts` imports nothing that holds a credential.
5. Nothing in `package.json` can send mail. A dependency that could is a
   blocker, not a convenience.
