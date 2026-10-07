# Day 3 acceptance run — 16 real law-firm sites

SPEC.md §25 exits Day 3 on **20 real law-firm sites fetched and stored**. Five
have been attempted on the VPS: four are accepted, one (Doogue + George)
returned 403. This directory takes sixteen more through the same path, with nine
verified reserves held back for a shortfall.

| File | What it is |
|---|---|
| `sites.json` | 16 primaries + 9 reserves, each with the evidence URL its name and domain came from. **Review this first.** |
| `run.ts` | `plan` (writes nothing), `enqueue`, `reserve`, `report`. |
| `verify.sql` | Thirteen read-only queries. SELECT only — no INSERT, UPDATE, DELETE or DDL. |
| `findings.md` | Finding 1 (error pages stored as evidence): **fixed**, with what changed. Finding 2 (off-domain redirects): open by decision, reported and not filtered. |

**Counts.** 4 accepted already + 16 primaries = 20 if every primary is accepted.
Realistically some are refused, which is what the 9 reserves are for. The
reserves are never fetched as a matter of course: `reserve` refuses to run once
the accepted count reaches 20, and caps each batch at the size of the shortfall.

**What the script does not do.** It opens no socket to the public internet: it
inserts companies and enqueues `web.fetch` jobs, and the running worker and the
fetcher service do the rest, through §8's controls, exactly as production will.
Its entire write surface is two INSERTs, both `ON CONFLICT DO NOTHING`. No
UPDATE, no DELETE, nothing already in the database is modified, and a second run
of the same batch on the same day is a no-op.

---

## A. Before you start

Read `sites.json`. Three entries (`jamesonlaw.com.au`, `gardewilson.com.au`,
`mklawfirm.com.au`) are marked `"name_evidence": "domain"`: the domain turned up
in a criminal/traffic-lawyer search but no result spelled out the trading name,
so the name is read off the domain. The domain is the identity that matters
(`companies.canonical_domain` is the unique key), and a name can be corrected
later without affecting the acceptance result — but if you would rather not
register a provisional name at all, delete those three entries now and the run
becomes thirteen sites.

Nothing in this directory can be verified from the development container against
the live sites, by design: the only machine that should be making those requests
is the VPS, through the fetcher.

---

## B. Exact VPS execution instructions

Run everything from `/opt/stenth-operator`. Nothing here touches `/opt/stenth`,
Caddy, or any existing container, and nothing publishes a port.

### B0. This release needs a migration

The commit that carries this harness also carries the finding 1 fix, which
includes **migration 005** (the `web_snapshots` text-requires-2xx constraint and
the `usable_snapshots` view) and a change to `bootstrap`. The acceptance run
depends on both: `verify.sql` and `run.ts report` read `usable_snapshots`.

So this is a normal deploy first, then the acceptance run — never both in one
step, because you want to know which one caused a surprise:

```bash
cd /opt/stenth-operator
docker compose --profile migrate build
docker compose run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose ps
```

`ADMIN_DATABASE_URL` must be the bootstrap superuser — see the note under "The
database roles" in `ops/deploy.md`. The migration is additive: it adds a
constraint `NOT VALID` and creates a view. It deletes nothing, and the
historical 403 snapshot is deliberately kept.

### B1. Get the commit and confirm the stack is healthy

```bash
cd /opt/stenth-operator

git status --porcelain                 # expect empty
git fetch origin main
git log --oneline -1 origin/main       # expect the commit that added ops/day3-acceptance
git merge --ff-only origin/main

docker compose ps                      # postgres healthy, web healthy, worker up, fetcher healthy
docker compose exec web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
```

The worker must be **running** — it is what claims the jobs. If it is stopped,
the jobs sit in `queued` until it starts, which is harmless but means no results.

> **If this commit also brings application changes you have not deployed**, deploy
> them first by the normal runbook (`ops/deploy.md`): `docker compose --profile
> migrate build`, `docker compose run --rm migrate`, then `docker compose -f
> docker-compose.yml -f docker-compose.prod.yml up -d`. Do not mix a deploy and
> an acceptance run in one step — you want to know which one caused a surprise.

### B2. Dry run — writes nothing

`ops/` is not copied into any image (the `tools`, `worker` and `fetcher` targets
copy `package.json`, `tsconfig.json`, `migrations` and `src` only), so the script
is bind-mounted read-only. This is deliberate: it needs no image rebuild and no
Dockerfile change.

```bash
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day3-acceptance \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts plan
```

`--no-deps` so no existing container is started or restarted. The `worker`
service already carries `DATABASE_URL` for `operator_app`, so no connection
string is typed and nothing from `.env` is read or echoed.
`SERVICE_NAME=day3-acceptance` labels the connection in `pg_stat_activity`.

Expect 16 lines, each ending `job: would enqueue`, and a last line saying nothing
was written.

### B3. Batch 1 — eight sites

Run it in two batches of eight, with a checkpoint between them. If something is
wrong — a site refusing automation, a guard refusal you did not expect — you find
out after eight sites, not sixteen.

```bash
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day3-acceptance \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts enqueue --yes \
    --only=sydneycriminallawyers.com.au,criminaldefencelawyers.com.au,aclawgroup.com.au,astorlegal.com.au,streetoncriminallawyers.com.au,jamesonlaw.com.au,pottslawyers.com.au,guestlawyers.com.au
```

Defaults, all overridable:

| Flag | Default | Why |
|---|---|---|
| `--stagger-seconds` | `30` | One job becomes due every 30s, so at most one site is being fetched at a time even though the worker runs four handlers. |
| `--max-attempts` | `1` | §6 gives `web.fetch` three attempts. One is used here on purpose: a site that refuses us is asked **once**, not three times (requirement 10). Pass `--max-attempts=3` for spec-default behaviour. |
| `--occurrence` | today, UTC | §7's `web.fetch` key is per-occurrence, so re-running today is idempotent and re-running tomorrow is a new occurrence. |

Eight jobs at 30s apart: the last becomes due about 3m30s in. Each job makes two
requests to one host — `robots.txt`, then the homepage — at least two seconds
apart, with any `Crawl-delay` honoured. **Sixteen sites is 32 outbound requests
in total.**

Wait about five minutes, then:

```bash
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day3-acceptance \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts report
```

### B4. Checkpoint, then batch 2

Look at batch 1 before continuing. Stop and reassess if **three or more** of the
eight returned 403/401/429 — that is a pattern, not a run of bad luck, and the
answer is to report it, not to push on through sixteen more requests.

```bash
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day3-acceptance \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts enqueue --yes \
    --only=cridlandhua.com,papahughes.com.au,criminalsolicitorsmelbourne.com.au,gardewilson.com.au,mklawfirm.com.au,paxmanandpaxman.com.au,perthcriminallawyer.com.au,caldicottlawyers.com.au
```

### B5. Report and verify

```bash
# The acceptance table, all sixteen:
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day3-acceptance \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts report

# The same facts straight from the database, read-only:
docker compose exec -T postgres psql -U postgres -d operator -f - \
  < ops/day3-acceptance/verify.sql
```

`psql` here connects over the container's local socket as `postgres`, so no
password is typed and no secret is read. Every statement in the file is a SELECT.

### B6. Only if short of 20: one reserve batch

```bash
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day3-acceptance \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts reserve
```

That is a dry run: it prints the accepted count, the shortfall and which
reserves it would take. Add `--yes` to enqueue them. Three brakes, and they are
the point of the mode:

1. It **refuses entirely** once the accepted count has reached 20.
2. The batch is capped at the **size of the shortfall**, so at 19 of 20 it sends
   one request, not nine. `--batch=N` (default 4, max 9) only lowers the cap
   further.
3. A reserve this harness has already enqueued is **never enqueued again**,
   whatever its outcome. A site that answered 403 is not asked twice.

The accepted count it gates on is database-wide, read from `usable_snapshots`,
so the four firms accepted before this harness existed count toward it — as they
should.

Run `report` after each batch. Come back here only if there is still a
shortfall, and if the reserves run out, verify a further real firm and add it to
`sites.json` with its `evidence_url` rather than re-asking a site that already
answered.

---

## C. Expected results

**Writes.** First run of a batch: 8 companies created, 8 jobs enqueued. Re-run
the same batch the same day: `companies created 0, jobs enqueued 0, already
present 8`. That line is the duplicate guard working, not an error.

**Timing.** Batch of 8 at 30s stagger: last job due at about T+3m30s, all
terminal within roughly 6 minutes. Both batches, end to end: 15–20 minutes
including the checkpoint.

**Per site, the report prints** company name, domain, job status, HTTP status,
robots allowed, bytes downloaded, extracted text length, whether a snapshot was
stored, any error, and whether it counts.

**What counts.** A site counts only if **all** of these hold:

- a snapshot row exists,
- `http_status` is 200–299,
- `robots_allowed` is true,
- extracted text is **at least 500 characters**,
- and the firm is counted **once**, however many snapshots it has.

The first three are the `usable_snapshots` view (migration 005), so the rule has
one definition in the system rather than one per query. The 500-character floor
is the acceptance threshold on top of it.

500 is the stated floor between a real homepage (thousands to tens of thousands
of characters) and an error page, a parked domain or a JavaScript-only shell (a
few dozen). It is a constant in `run.ts` and in `verify.sql`, so the count is
reproducible rather than a judgement call.

**Realistic outcome, stated honestly.** One of the five sites already attempted
returned 403 — bot protection in front of a law-firm site is common, not
exceptional. On that rate, expect roughly **11 to 14 of the 16** to count, giving
**15 to 18 of 20** overall, and one or two reserve batches to close the gap. That
is a normal result for a real-world fetch test, not a fetcher defect — but **do
not** report Day 3 complete at 15 or 18. The criterion is 20.

**A 403 now looks different.** The site is asked once, a diagnostic row is
written with `text` NULL, the job completes rather than retrying, and
`report` lists it under "answered with an error status". That is the finding 1
fix working; it is not a regression.

**What must not change.** Zero model calls and zero spend (`llm_calls` stays 0 —
no model API key exists in this deployment yet). No new rows in `extractions`,
`assessments`, `contacts`, `outreach_drafts`, `approved_outreach` or `prospects`
— `verify.sql` query 9 asserts all six are zero. No published host ports. Nothing
in `/opt/stenth` touched.

**Expect to see, and not be alarmed by:** a 403 or two; one or two sites with
`Disallow` on the paths we want; an apex → `www` redirect showing in query 11; a
`crawl_delay_seconds` making one site slower than the others.

---

## D. Read-only SQL verification

`ops/day3-acceptance/verify.sql`, run as shown in B5. Thirteen queries: the
acceptance count against the target of 20, the per-site table, **error-status
rows with `text_length` expected NULL on every one**, job outcomes, dead/blocked
jobs, robots decisions, the robots cache, the duplicate guards, proof that no
downstream table moved, scheduler liveness and spend, the off-domain-redirect
check, the installed non-2xx constraint, and proof that the fetcher role cannot
read the evidence view.

---

## E. Failure handling

Read `jobs.last_error` and the trace id from the report, then
`docker compose logs --since 30m worker | grep <trace_id>` and
`docker compose logs --since 30m fetcher | grep <trace_id>`.

| What you see | What it means | What to do |
|---|---|---|
| `http_status` 401/403/404, job succeeded | The site answered, and the answer is no. Terminal: one request, text NULL, not retried. | Nothing. It does not count. **Do not** change the User-Agent, add headers, use a proxy or retry around it — requirement 9, and §8's identity rule exists to be honest about who we are. |
| `http_status` 429 | Rate limited. Treated exactly as a 403: terminal, one request. | Nothing, and specifically do not re-run that site. One request per host per run means it is not our volume; it is a blanket policy. |
| job `dead`, `last_error` mentions `http_status_50x` | The site gave no answer. §6's bounded retry ran out. | Expected behaviour for a site that is down. Re-run that one site later with `--only=<domain> --occurrence=<a later date>` if you want to. |
| `OFF-DOMAIN FINAL URL` in the report | A redirect left the firm's domain (finding 2). apex → `www` is filtered out of this list, so anything here is a real domain change. | Look at it by hand. Day 4 must not consume it as company evidence until the policy is resolved. Do not add a filter. |
| `robots_allowed = false`, no `http_status`, `text` NULL | §8 working: `Disallow` matched, nothing was fetched. | Nothing. It does not count, and it is never overridden. |
| job `dead`, `last_error` mentions `robots_http_5xx` / `robots_unavailable` | robots.txt gave no answer, so permission was never granted and the page was skipped. Correct and deliberate. | Re-run that one site later: `--only=<domain> --occurrence=<a later date>`. Or `--max-attempts=3` to let §6's backoff handle it. |
| `last_error` with `address_blocked`, `content_type_not_allowed`, `too_many_redirects`, `timeout`, `transport_error` | A §8 control fired. `address_blocked` means the host resolved into a private range — exclude that site and say so. | Nothing to fix in the Operator. Record the refusal. |
| `url_has_credentials` | A URL carried userinfo. Cannot happen from `sites.json`, which has no credentials. | Investigate where the URL came from before anything else. |
| DNS failure, or 404 on the homepage | A stale `sites.json` entry — the firm rebranded, moved host or closed. | Fix or remove the entry, then substitute `tgb.com.au` from `reserve`. **Do not invent a replacement domain**; verify a real one first and add its `evidence_url`. |
| job stuck in `running` | §6's reaper returns it to `queued` after 15 minutes. | Wait 15 minutes, then re-report. |
| job `blocked` | Budget ceiling. | Should be impossible on Day 3 — no model calls happen. Investigate before re-running anything. |

**Aborting mid-run.** Queued acceptance jobs have `priority = -10`, below every
default, so they can never delay real pipeline work. To stop them being claimed,
`docker compose stop worker` — but that stops all claiming, so prefer simply
letting the batch finish; it is at most eight jobs and sixteen requests.
Abandoning queued jobs would need an UPDATE, which is deliberately not provided
here.

**Rolling back.** There is nothing to roll back: the script only inserted rows,
and no existing row was modified. The companies it created are real firms the
pipeline will legitimately use from Day 5, so the normal answer is to leave them.
If you do want them gone, identify them first and delete by hand — this file
provides the SELECT and deliberately no DELETE:

```sql
SELECT id, canonical_domain, legal_name, created_at FROM companies
 WHERE canonical_domain IN ('sydneycriminallawyers.com.au', '...')
 ORDER BY created_at DESC;
```

---

## F. Findings

See `findings.md`.

**Finding 1 — fixed.** A non-2xx response can no longer become evidence: the
body is dropped at the edge, a 4xx is stored with `text` NULL and is terminal, a
5xx stores nothing and retries within §6's budget, the contract declares which
outcomes are retryable, and migration 005 makes the row shape a database
constraint. Regression tests cover 401, 403, 404, 429, 500, 503, 2xx and robots.

**Finding 2 — open by decision.** Off-domain final URLs are reported and
explicitly flagged, by `run.ts report` and by `verify.sql` query 11. No
registrable-domain policy is implemented. Day 4 must not consume an off-domain
snapshot as company evidence until it is resolved.
