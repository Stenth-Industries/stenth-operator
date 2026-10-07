# Day 4 operations: eligibility, reservations, signals

Three read-first tools and one re-fetch. None of them calls a model.

| File | What it is |
|---|---|
| `thresholds.ts` | The eligibility threshold comparison the decision needs. Read-only. |
| `thresholds.sql` | The same measurement as SELECTs, for psql. |
| `reconcile.ts` | Open budget reservations: list, then resolve each one by hand. |

The signals re-fetch lives with the Day 3 harness, in `ops/day3-acceptance/run.ts`,
because it reuses that harness's spacing, attempt budget and scoping.

Every command below runs `ops/` bind-mounted read-only into the worker
container, which is where the operator_app connection string already is. No
connection string is typed, and nothing from `.env` is read or echoed.

---

## 1. The eligibility threshold (review item 2)

The production gate is **not frozen**. `src/pipeline/evidence.ts` ships with
1,000 characters and 50 distinct words, and those numbers were an argument, not
a measurement. This produces the table that decides them:

```bash
cd /opt/stenth-operator
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day4-thresholds \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day4-extraction/thresholds.ts
```

It prints, for every firm with usable 2xx evidence: the normalised text length,
the distinct alphabetic word count, whether the final URL is first-party, and
whether a Tier A scan exists. Then, for `400/20`, `500/25`, `750/30` and
`1000/50`: how many are eligible, how many excluded, and **which firms** with
their measurements.

It uses the same functions as the gate — `normaliseForMeasurement`,
`countDistinctWords`, `isOnOwnDomain` — so the table cannot disagree with what
production will do.

**Reading it.** The question is not "which threshold excludes the least" but
"which excludes only pages that could not ground an extraction". Look at the
firms each threshold excludes and open two or three of them. A one-page firm
site with a name, three practice areas and a phone number is a page the
extraction can work with; a JavaScript shell is not. If a threshold excludes the
first kind, it is too high — the error asymmetry is in the file's header comment
and it runs strongly against false exclusions.

`thresholds.sql` is the same measurement for psql, with one difference stated in
its header: its on-domain column is host equality, because SQL cannot ask the
Public Suffix List, so it reads a legitimate subdomain as off-domain. The
TypeScript table is the answer.

---

## 2. Reconciling an open reservation (review item 1)

A reservation is left standing whenever a call's outcome is unknown — the
process died between reserving and finalising, or the provider failed after
being invoked. Its pessimistic cost keeps counting against the month and its
identity stays taken, so the system fails closed. Nothing in the Operator can
tell whether the money was actually spent; only the provider's billing can.

```bash
# Read-only. Everything open, with what you need to look it up.
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day4-reconcile \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day4-extraction/reconcile.ts list

# Only reservations older than 15 minutes, so a call in flight is not
# mistaken for a stuck one.
  ... reconcile.ts list --older-than-minutes=15
```

For each one, find the request in the provider's own billing or usage view at
the timestamp shown, then resolve it:

```bash
# The provider has no record of it: no charge happened.
  ... reconcile.ts resolve --id=<uuid> --as=abandoned --yes \
        --by=kushagra --note="no request at that timestamp in the dashboard"

# It was charged. Record what it actually cost.
  ... reconcile.ts resolve --id=<uuid> --as=charged --cost-usd=0.0412 --yes \
        --by=kushagra --note="billed 1,220 input / 480 output per the dashboard"
```

`abandoned` gives the budget back and frees the identity, so the work can be
enqueued again. `charged` keeps the cost in the month and keeps the identity
taken, so the work is not retried against a provider that already answered.
Both require `--by` and `--note`: a correction with no attribution is not an
audit trail.

**There is no automatic path.** Replaying an ambiguous charged call is the one
thing the reservation design exists to prevent.

---

## 3. The controlled signals re-fetch (review item 3, approved)

The 20 accepted snapshots predate the Tier A scanner, so their `signals` is NULL
and extraction records Tier A as `unknown` — never as `absent`, because §10 pays
35 points for absence and awarding that for an unmeasured signal is the Day 3
finding-1 mistake in a new place.

Scope comes from the database, not a list: firms with usable 2xx evidence and no
scan. A firm that was never accepted is not touched; a firm that already has a
scan is not asked again.

```bash
cd /opt/stenth-operator

# Dry run: who would be re-fetched, and how many requests that is.
docker compose run --rm --no-deps \
  -e SERVICE_NAME=day4-refetch \
  -v /opt/stenth-operator/ops:/app/ops:ro \
  worker node --import tsx /app/ops/day3-acceptance/run.ts refetch-signals

# Do it.
  ... run.ts refetch-signals --yes

# The Tier A table afterwards.
  ... run.ts report --signals
```

Unchanged from the Day 3 path: the same worker, the same fetcher, the same
robots, politeness and SSRF controls, one homepage per firm, 30 seconds apart,
one attempt, lowest priority. **No model is called** — the scan is regular
expressions over markup. A 403 is still a 403 and nothing is retried around it.

Re-fetching unchanged bytes used to be a no-op that left the NULL in place.
Migration 008 makes the conflict fill `signals` in when it is missing — a
column-level `UPDATE (signals)` grant, writing only where the column is NULL —
so the run works whether or not a firm has touched its website since Day 3. The
page itself stays immutable to the fetcher: `text`, `url`, `http_status`,
`content_hash` and `bytes` are all still refused to that role, and a test
asserts each one.

---

## 4. Configuring a provider (review item 6)

Four adapters are available and **none is chosen**: §1 freezes that to the Day 6
evaluation, and §22 decides it from the full metric set.

| id | Model id from | Key from | Billable |
|---|---|---|---|
| `offline` | — | — | no |
| `anthropic` | `ANTHROPIC_MODEL` | `ANTHROPIC_API_KEY` | yes |
| `openai` | `OPENAI_MODEL` | `OPENAI_API_KEY` | yes |
| `google` | `GOOGLE_MODEL` | `GOOGLE_API_KEY` | yes |

A family registers only when its model id is set — a family with no model id is
not a candidate, and guessing one would be the product decision these adapters
exist not to make. Keys are read from the environment at call time, never
stored, never logged, and never put in a URL.

Two switches, both off by default:

* `MODEL_PROVIDER` — unset means `web.extract` jobs are **blocked** with
  `provider_unconfigured` rather than silently running on whichever adapter
  loaded first.
* `MODEL_CALLS_ENABLED` — must be exactly `true` before a billable provider is
  invoked at all. Until then a billable provider is blocked with
  `model_calls_disabled`, so an offline test cannot become production spend.

A provider also cannot be called until `model_pricing` has a row in force for
its `(provider, model)`: the budget gate has to price a call before it can
authorise one, and a call it cannot price is refused with `missing_pricing`.

---

## Blocked reason codes

`jobs.last_error` carries the sentence, the `job.blocked` event payload carries
the code. Each needs a different response:

| Code | What to do |
|---|---|
| `provider_unconfigured` | Record the Day 6 decision, set `MODEL_PROVIDER`. |
| `model_calls_disabled` | Set `MODEL_CALLS_ENABLED=true` when real calls are authorised. |
| `missing_pricing` | Insert the `model_pricing` row for that provider and model. |
| `budget_hard_stop` | Raise `budgets.hard_stop_usd`, or wait for the month to roll. |
| `reservation_in_flight` | Reconcile the open reservation (section 2). Do not re-enqueue first. |
| `security_refusal` | Declared, no producer in Day 4. Day 6's consent and suppression controls will use it. |
