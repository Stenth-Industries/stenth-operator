# Open deviations from SPEC.md §20, awaiting a decision

Two things about the target host conflict with the specification as written.
Neither is solved here, because neither should be solved quietly. Both are
recorded with the options and a recommendation, and nothing in the repository
depends on the outcome yet.

The target is **stenth-engine**, 139.84.205.53, Vultr Melbourne, Ubuntu 24.04,
2 vCPU / 4 GB / 75 GB. It is **shared**: `/opt/stenth` runs `stenth-caddy-1`,
`stenth-n8n-1` and `stenth-n8n-clients-1`, and the clients instance is
production for a paying client.

---

## 1. Ports 80 and 443 are already taken

§20 says Caddy is "the only container with published host ports" and runs two
site blocks: a public one serving `/optout/*` and the ACME challenge, and a
private one on the Tailscale interface proxying the dashboard.

The existing Caddy already publishes 80 and 443 on the public interface, and
its Caddyfile is not ours to edit. So Operator's Caddy cannot be what §20
describes.

**This is not blocking.** The private dashboard is Day 9 and `/optout/:token`
is Day 7. Day 1 needs no ingress at all — nothing in `docker-compose.yml`
publishes 80 or 443, and the web container binds loopback only.

The private half has an answer that conflicts with nothing: Operator's Caddy
binds the **Tailscale interface** (`100.x.y.z:443`), not the public one. Two
processes can both listen on port 443 on different addresses. The existing
Caddy binds the public interface; Operator's binds the tailnet. No contention,
no edit to the live Caddyfile, and §20's "dashboard reachable over Tailscale
only" is satisfied exactly.

The public half — one URL that recipients must be able to open from any
device — is the open question.

| Option | How | Cost | Risk |
|---|---|---|---|
| **A. Cloudflare Tunnel** (recommended) | A `cloudflared` container in Operator's Compose project, outbound-only, serving `optout.<sending-domain>` straight to the web container | Free tier | A dependency on Cloudflare for one endpoint. No inbound port, so nothing to contend for and no ACME challenge needed — Cloudflare terminates TLS |
| **B. A second public IP** | Add a Vultr reserved IP, bind Operator's Caddy to it on 80/443, ACME as §20 describes | A few dollars a month | Most faithful to §20. One more thing to configure correctly, and the two Caddies must each bind a specific address rather than `0.0.0.0` — which means confirming the existing one is not already wildcard-bound |
| **C. One site block in the existing Caddyfile** | `handle /optout/* { reverse_proxy … }` in the live config | Free | Lowest complexity, highest blast radius. A reload touches the paying client's ingress. Currently excluded by instruction |

**Recommendation: A.** It needs no port, no new IP and no change to anything
the paying client depends on, which is the property that matters most on a
shared box. B is the better long-term shape if a second IP is acceptable.

**Decision needed before Day 7.** Until then this file is the record.

---

## 2. The host holds mail credentials; Operator does not

§1 and §14 say the deployment holds no mail-sending credential of any kind,
and §23 makes that a structural assertion rather than a promise. On a dedicated
box that is literally true. On this box it is not: the existing n8n stack holds
mail credentials, and that is known and accepted.

So the guarantee has a precise scope, and it is worth writing down precisely
rather than letting a future reader assume more than it says.

**What still holds, and is tested:**

- No mail-capable package in Operator's dependency tree — `npm run lint`
  (`scripts/lint-no-mail.mjs`) checks the resolved lockfile, not just
  `package.json`, and runs in CI on every commit.
- No Operator source file imports one, and `gmail.compose` appears nowhere in
  `src/`.
- No mail credential in Operator's `.env`, `.env.example`, environment or
  database schema — `001_init.sql` has no table, column or type for one, and a
  test asserts it.
- Operator's containers get no mail credential and no access to the other
  stack's: separate Compose project, separate network, separate `.env`.

**What does not hold, and why it is accepted:** an attacker with root on the
host reaches n8n's mail credentials. That is true whether or not Operator is
installed, so Operator's presence does not change that exposure — but it does
mean the sentence "the worst case for a compromised VPS is read access to
prospect research and the ability to burn model budget" (§17) is no longer true
of **this host**. It remains true of Operator.

The honest version for this deployment: *Operator cannot send mail, and no
compromise of Operator yields a mail credential. The host is a shared box whose
other tenant can.*

No action requested. Recorded so the claim is not overstated later.

---

# Day 4 deviations from the frozen specification

Four small departures, each with the reason and the alternative that was
rejected. None changes the architecture, the pipeline or a control.

## 4. `web_snapshots.signals` is a column §4 does not list

**§9** says every Tier A signal is "read out of stored HTML by code, not
inferred by a model", and **§23 case 13** says the scanner "reads script
content, not claims". The `AW-` identifier lives inside a `<script>`, and the
fetcher's HTML-to-text step drops `<script>` — correctly, because that is where
injected instructions live (§8). By the time a page is in `web_snapshots.text`
the evidence for the most useful Tier A signal is gone.

Migration 006 adds a nullable `jsonb` column and the fetcher writes the
deterministic scan into it before the text conversion. Rejected alternatives:
storing the raw HTML as well (doubles storage, puts hostile markup in the
database, gives §15 a second copy to prune) and re-fetching at extract time (a
second request for data we already had, and the page can change in between).

§4 names "key columns and constraints" rather than an exhaustive list, the
column is additive and nullable, and it belongs with the snapshot because it
shares its provenance, trace id and retention. A separate table would have been
a larger departure for no benefit.

**Consequence worth knowing:** the 20 snapshots stored during Day 3 have
`signals` NULL. Extraction records Tier A as `unknown` for them, not `absent`.
Day 6's rubric must treat `unknown` as "no evidence" — awarding the Visible
execution gap's 35 points for a signal nobody measured would be the Day 3
finding-1 mistake in a new place. One re-fetch pass of the 20 sites after
deployment gives Day 6 real signals; it costs 40 polite requests and no model
spend.

## 5. `paid_search_tag` has a third value, `unknown`

§9 says "Extraction records paid_search_tag enum(present, absent)". Two values
cannot express "no scanner has looked", and the only honest answer for a
pre-006 snapshot is neither present nor absent. Collapsing it to `absent` would
hand §10's largest dimension its full 35 points on no evidence; collapsing it to
`present` would be worse.

So the recorded enum is `present | absent | unknown`, and only the scanner may
say `absent`, because only the scanner has looked. §9's own rule — "Anything
outside Tier A is recorded as unknown and never estimated" — is the principle
this follows; the deviation is that one Tier A field can also be unknown, for
the specific reason that the scan is newer than some of the snapshots.

## 6. `blocked` covers one more case than §6 names

§6 introduces `blocked` as the state "when the budget ceiling is hit". Day 4
also moves a job to `blocked` when the configured provider is billable and
`MODEL_CALLS_ENABLED` is not set.

It is the same kind of event — a control refused the job before any provider was
contacted — and `blocked` is already terminal and alerting, which is the correct
behaviour: neither a ceiling nor a switch improves by being retried. The
alternative, failing three times into `dead`, would describe a configuration
decision as a fault.

## 7. `src/pipeline/evidence.ts` is a file §19 does not list

§19's tree lists `pipeline/ discover.ts, qualify.ts, rank.ts, outreach.ts,
priors.ts`. The snapshot eligibility gate sits between §10's stage 3 (fetch) and
stage 4 (extract) and belongs to neither `qualify.ts` nor the handler: it is the
rule that decides whether a paid call happens, and it has to be unit-testable
without a database or a provider.

§19's five rules forbid a new top-level directory without a written reason and
an abstraction with a single caller. This is neither — `pipeline/` already
exists, and the gate has two callers already (the handler and the SQL mirror
test) with Day 5's `company.resolve` to come.

---

# Day 4 review deviations

Three further departures, all from the review of 2026-10-08. The four recorded
above (`signals` jsonb, `paid_search_tag: unknown`, the widened `blocked` state,
`pipeline/evidence.ts`) were provisionally approved and stand.

## 8. `llm_calls` gains six columns and two states

§4's `llm_calls` lists provider, model, token counts, cost, latency, status and
request hash — a record of a call that happened. §16's hard stop cannot be built
on that alone: a row written after the call cannot stop the call, and two
workers reading the same month-to-date both pass.

Migration 007 adds `reservation_key`, `estimated_cost_usd`, `reserved_at`,
`finalized_at`, `reconciled_by`, `reconciliation_note`, and the states `reserved`
and `abandoned`. The table becomes a reservation ledger as well as a record,
which is what makes "check before the call" a control rather than a report.

§4 names "key columns and constraints" rather than an exhaustive list, every
addition is nullable, and nothing existing changed meaning — except `cost_usd`,
which now holds the pessimistic estimate while a row is `reserved`. That is
deliberate: it keeps month-to-date a plain `sum(cost_usd)`, with no status
filter for a future query to get wrong, and it is documented on the column.

## 9. `operator_fetch` may write and read one derived column

Migration 002 gave the fetcher INSERT on `web_snapshots` and nothing else, and
the privilege matrix test asserts UPDATE is refused. Migration 008 grants
`UPDATE (signals)` and `SELECT (signals)` — one column, because the 20 Day 3
snapshots can only acquire a Tier A scan through a re-fetch, and a re-fetch of
unchanged bytes conflicts on `(company_id, url, content_hash)` and would change
nothing.

The statement writes only where `signals IS NULL`, so an existing scan cannot be
overwritten; the SELECT exists because that guard reads the column. `text`,
`url`, `http_status`, `content_hash` and `bytes` all remain refused to the
fetcher, each asserted by its own case.

## 10. The eligibility threshold is not frozen

Recorded because the code currently says 1,000 characters and 50 distinct words
and that is **not** a decision yet. `ops/day4-extraction/thresholds.ts` produces
the comparison against the real corpus; the number changes in one constant when
the data is in. Day 4 must not be deployed as the final gate until that table
has been read.

---

# Final Day 4 review deviations

Two further departures, both from the review of 2026-10-09, which asked for the
abandoned-reservation retry path to be proven rather than described.

## 11. `llm_calls` gains one more column: `released_reservation_key`

Migration 007 released a work identity by setting `reservation_key` to NULL,
which is what frees the retry — the unique index is partial on
`reservation_key IS NOT NULL`. It also erased the one fact that made the
abandoned row interpretable: which work the money had been held for. An audit
row reading "released $0.09, by a person, with a note, for something" is not an
audit trail, and §4 wants the ledger readable after the fact.

Migration 009 therefore moves the key instead of dropping it. One nullable
column, write-once through a `BEFORE UPDATE` trigger in the same style as 001's
`approved_outreach_write_once`, deliberately **not** unique — the same work can
be reserved and released more than once, and uniqueness would make the second
honest abandonment fail and leave the budget held. Nothing reads it as a
control: reservations still serialise on `reservation_key` alone.

The trigger also refuses a row that records a release while still holding a
key, so "held" and "handed back" can never both be true of one row.

## 12. `blocked` is terminal, and now has one human-driven way back

§6: "dead and blocked are terminal and raise an alert; nothing retries them
silently." That is kept — nothing in the worker undoes a terminal state. But §7
makes `web.extract`'s dedupe key permanent (`extract:<snapshot>:<version>`), so
the blocked row is the only job row that will ever exist for that snapshot: a
later `enqueue` hits `ON CONFLICT` and reports success while changing nothing.

Taken together, those two rules made every control refusal permanent. An
abandoned reservation freed its identity and its budget into a pipeline that
would never ask for the work again, and the same held for a `budget_hard_stop`
after the ceiling was raised and a `provider_unconfigured` after a provider was
configured.

`requeueBlockedJob` (`src/jobs/queue.ts`) is the one path back: guarded on
`status = 'blocked'`, it returns the job to `queued` in place — same id, same
dedupe key, `attempts` untouched so the blocked attempt is not erased — and
writes a `job.requeued` event with `actor_type = 'human'` carrying the
`llm_calls` id behind the decision. It is called by `reconcile.ts` after a
successful abandonment and by nothing else. "Silently" is the word §6 turns on,
and this is attributable, bounded by the original attempt budget, and never
automatic.

---

# Day 5 deviations

Recorded 2026-10-08, with the frozen §25 milestone table in front of me.

## 13. What was built is not §25's Day 5

**This is the first thing a reader needs to know.** §25's Day 5 row is:

> Eval harness: fixture format, snapshot sanitiser, frozen snapshots,
> eval/run.ts, metrics, markdown report, dev/holdout split. **Kushagra labels 60
> fixtures.**

and the paragraph under the table says, in the spec's own words: "Day 5 is still
the critical path and it is still not Claude Code's work." None of that was
built. The eval harness cannot be finished here — its exit criterion is a
baseline measured over 60 human-labelled fixtures, and the labels are the input,
not the output.

What was built instead is `company.resolve`: §10 stages 1–3, which §25 places
under Day 6's "code filters" and which Day 3's own handoff calls Day 5's work —
`ops/day3-acceptance/findings.md`: "a design decision for Day 5 — when
`company.resolve` starts fanning out to §10's six pages", and
`src/pipeline/domain.ts`: "until `company.resolve` separately verifies that the
other domain belongs to the same firm, which is Day 5's work and does not exist
yet." Two files in the repo already called this Day 5, so the name was taken
before today.

Nothing here is rubric, scoring or threshold work: §10 stages 4–7 are untouched,
and so is every number Day 6 has to derive. The milestone order changed; no
milestone's content did.

## 14. One `web.fetch` job per page, not one job carrying six URLs

§6 says web.fetch "Asks the fetcher service for up to 6 pages", which reads as
one job with six URLs, and the payload schema has always accepted up to six.
`company.resolve` emits one URL per job instead.

§7 is the evidence: the web.fetch key is `fetch:{company_id}:{url_hash}:{date}`,
singular, one key per URL. A job carrying six URLs has one key for six pieces of
work and — the part that matters — one retry budget. That is exactly Day 3's
recorded residual: "a job carrying several URLs where one page is 4xx and another
is 5xx retries because of the 5xx, and the 4xx URL is requested again on that
attempt. Avoiding it needs per-URL state across attempts, which is a design
decision for Day 5."

Per-URL state across attempts is a per-URL job. No new table, no new state, and
no change to the terminal/retryable split in `src/fetcher/contract.ts` — the
4xx job succeeds on its first attempt and is never asked again, the 5xx job
retries alone. Politeness is unaffected because the fetcher's token bucket is
keyed by host, not by job. The six-URL ceiling stays on the payload schema,
where it protects the fetcher from any caller.

The payload gains one optional field, `page_kind`. It is provenance, not an
option: `fetchRequestSchema` is strict and takes company_id, url and trace_id,
so it never reaches the fetcher. It exists so the 404 rate per page kind is
measurable, which is the evidence deviation 15 needs.

## 15. The candidate paths are a first pass, and page discovery is undecided

§10 stage 3 freezes the six page *kinds* — "home, about, services or practice
areas, contact, team, one location page". It does not say what a firm calls them,
and **nothing in the repo knows**: `src/fetch/signals.ts` counts location links,
it does not collect them, and no page URL has ever been harvested from a stored
snapshot. So `PAGE_PATHS` in `src/pipeline/resolve.ts` asks for one conventional
path per kind and accepts that some will 404.

That is bounded by Day 3's own correction — a 4xx is terminal, writes a text-free
diagnostic row, is never evidence and is never retried — but it is a quality
cost, not a free one: a firm whose about page is `/our-firm` loses that page.

**The open decision, not made here.** The alternative is to harvest candidate
links from the homepage's markup deterministically (no model call: the scanner
already runs over the HTML before `html-to-text` drops the links) and classify
them into the six kinds. That is better fan-out and it is also a new capability
crossing the fetcher boundary — URLs from a hostile page, which would have to
pass the same filter `next_urls` does. It needs approval, so it was not built.

`practice_areas` rather than `services` because §9 and §10 use "practice areas"
throughout as the thing to extract and to score, and `practice_area_priors` is a
table. The spec's own vocabulary is the only evidence available; both spellings
pass the path allowlist either way.

## 16. `company.resolve` writes the `prospects` row

§4 calls prospects "the pipeline row" and §6 does not say which stage creates it.
It is created here, at stage 1, on the evidence of §10 stage 1 itself: "Reject if
suppressed or **already a prospect in this campaign**" can only be a dedupe test
if resolve is what writes it. `prospect_stage`'s first value is `discovered`,
which is the resolve stage and not the assess stage, and §4's unique index on
(company_id, campaign_id) is the constraint that makes the test free.

The company row, its `company_sources` row, the prospect row and all six
enqueues commit in one transaction. That is load-bearing, not tidiness: a crash
between the prospect insert and the fan-out would otherwise leave a firm that
reads as "already a prospect" with nothing queued, stalled for ever. A
reliability case drives exactly that rollback.

## 17. `next_urls` now asks the Public Suffix List (closing Day 3 finding 2)

§8 has always said "code filters it to the same registrable domain". Day 4
implemented host equality and said so in the code: "that list arrives with
company.resolve on Day 5, and host equality is the stricter of the two, so it is
safe to tighten now and relax later." It now asks `src/pipeline/domain.ts`.

One thing relaxed: a legitimate subdomain of the firm's own eTLD+1 is first
party, which is the policy already approved for `src/pipeline/evidence.ts`.
Nothing else moved — protocol, credential rejection, allowed ports, the path
allowlist, depth, the five-URL cap and deduplication are all unchanged, and six
adversarial cases assert each of them *on a subdomain* rather than only on the
apex, because a widened domain test is where a hole would hide.

Host equality was never stricter where it mattered. It could not tell
`firm.com.au` from `firm.com.au.attacker.tld` on principle, only by the accident
of two strings differing.

## 18. `web.fetch` now enqueues `web.extract` (§6), which Day 3 deferred

`src/worker/handlers/web-fetch.ts` said: "web.extract is Day 4, so this stores
snapshots and stops there; the enqueue arrives with the handler that can act on
it." The handler exists, so the enqueue is wired, per §6's "Enqueues next:
web.extract per snapshot" — only for `EXTRACTABLE_OUTCOMES`, so a robots row and
a 4xx row still produce nothing.

The pool became a *required* dependency rather than an optional one. A handler
that silently skips its successor when a dependency is missing is a pipeline
that stops with no error, and "the enqueue only happens in production" is not a
property a test can check.

**What this means for a deployment with model calls disabled**, which is the
current production state: every fetched page now produces a `web.extract` job,
and each one is blocked with `model_calls_disabled` before any reservation
exists. No provider is contacted and no budget is consumed. Those jobs are
terminal until a human requeues them, which is what `requeueBlockedJob` and
`ops/day4-extraction/reconcile.ts` are for. Nothing enqueues `company.resolve`
in production, so none of this starts on its own.

---

# Day 5, the approved link harvester

Approved explicitly on 2026-10-08, after deviation 15 recorded the decision as
open. This is the capability that closes it.

## 19. The fetcher reads the homepage's links, deterministically

**What was approved.** Deviation 15 said the candidate paths were a first pass
because "nothing in the repo has ever harvested a page URL from a snapshot", and
named the alternative: harvest links from the homepage's markup deterministically
and classify them into §10 stage 3's six kinds. That is now built.

**Where it runs, and why there.** `src/fetch/links.ts`, inside the fetcher, for
the same reason §19 puts the Tier A scanner there: `htmlToText` is next and it
drops every `<a>` element, so this is the only moment the links exist. Keeping
the raw HTML in the database instead would mean storing hostile markup and
pruning it under §15.

**What crosses the boundary.** At most five URLs, each of which has already
passed every rule §8 states, written to `web_snapshots.signals` beside the Tier
A scan. Nothing else. The fetch response schema is `.strict()` and has no link
field, which a test asserts by trying to add one. No raw markup and no
unfiltered link set reaches the worker — the handler's own result carries counts
and snapshot ids, and the chosen URLs exist only as the jobs it enqueued.

**One filter, two callers.** The rules moved to `src/pipeline/links.ts`:
http/https only, no credentials, ports 80 and 443 only, the same registrable
domain via the Public Suffix List, the §8 path allowlist, depth at most two,
deduplication with the query string and fragment dropped, and a cap. There are
now two sources of untrusted URL suggestions — a model reading a hostile page
(`next_urls`) and code reading the same page (the harvest) — and a rule
tightened in one path and forgotten in the other is the failure a second copy
would eventually produce. `filterNextUrls` is a four-line wrapper over it.

**The worker trusts none of it.** The stored harvest is jsonb written by the
process whose job is handling hostile input, so the handler re-runs every
candidate through `safeFirstPartyUrl` — against `companies.canonical_domain`
this time rather than the page's own final URL, because §4 makes the canonical
domain the firm's identity and a redirect could have moved the snapshot — and
re-derives the page kind rather than reading the stored label. The fetcher's
filter keeps junk out of the database; this is the one that decides what gets
fetched.

**No model, no provider, no migration, no spend.** A DOM query, a URL filter and
five anchored regular expressions. `signals` is already jsonb and migration 008
already grants the fetcher `UPDATE (signals)`, so the second deterministic read
of the markup shares the column the first one uses — one fact about one page,
"what code could see in this markup before it was thrown away". Readers pick
named keys, so `assembleSignals` is unaffected and the harvest never reaches an
extraction payload or a model, which a case asserts on the payload's key set.

## 20. The fan-out is two waves, and that is a departure from the literal ask

The approved requirement said "company.resolve must still enqueue one web.fetch
job per selected page". Preferring a discovered URL means the homepage has to be
*read* before the other five can be selected, so one stage cannot do both: this
stage enqueues the homepage, and the homepage's own job selects and enqueues the
rest.

The invariant the requirement protects is kept exactly — one page per job, each
with its own §7 key and its own §6 retry budget, and a hard ceiling of six: one
in wave one, at most five in wave two. `selectFollowUpPages` loops over the page
kinds rather than over the candidates, so a harvest of a thousand links cannot
widen it, and only a job whose `page_kind` is `home` fans out at all, which
holds the depth at one. Three cases assert those three properties.

The alternative — `company.resolve` fetching the homepage itself and then
enqueuing all six — would put a sixty-second network call inside the transaction
that writes the company, and give the worker a second route to the fetcher. §6's
chain is company.resolve → web.fetch → web.extract, and adding a job kind to
avoid that is a specification change to a frozen table.

**A consequence, now reversed — see deviation 21.** As first built, a homepage
that could not be read ended the firm at one request. That lost the firm whose
`/` returns 403 and whose `/about` is perfectly readable, and it was reversed on
the same day it was recorded.

**`page_source` is the new provenance.** Every web.fetch payload now says
whether its URL is the `root`, `discovered` from the homepage, or a `fallback`
guess, and the occurrence is carried so all six pages of one firm share one §7
date rather than splitting across midnight. Deviation 15's open question — what
a firm actually calls its about page — is now answerable from the data instead
of guessed, and the fallback paths remain for the kinds a homepage does not link.

## 21. A homepage that refuses us falls back; it does not end the firm

Deviation 20 recorded that a terminal homepage outcome produced no fan-out at
all. Reversed on request, 2026-10-08, before deployment.

A site with a blocked root and a readable `/about` is ordinary. Day 3's
correction was about never re-asking a URL that has already answered — a 403
does not become a 200 by asking twice more — and that is kept exactly: the
homepage URL is asked once and never again. It was never an argument for
abandoning the company.

So when the homepage job finishes with no usable snapshot, the five conventional
paths are enqueued instead of the five discovered ones. Same shape either way:
one `web.fetch` job per URL, `page_source: 'fallback'` on every payload, the
§7 occurrence carried so all six share one date, and `selectFollowUpPages`
looping over the page kinds rather than the candidates so the total cannot pass
§10's six. Every URL — discovered or conventional — passes `safeFirstPartyUrl`
against `companies.canonical_domain` as the last gate before it becomes a job.

**Which outcomes fall back, and why the other two do not.** The handler now
reports a `followUpBasis`, which is the audit answer to "where did these five
come from":

| Homepage outcome | Basis | Fan-out |
|---|---|---|
| 2xx stored | `homepage_read` | discovered preferred, conventional fills the rest |
| 4xx (401/403/404/429) | `terminal_fallback` | five conventional paths |
| robots `Disallow` | `terminal_fallback` | five conventional paths |
| guard refusal, attempts left | `retry_pending` | none yet |
| guard refusal, last attempt | `exhausted_fallback` | five conventional paths |
| 5xx or other non-2xx/4xx | `no_answer` | none |
| final URL off the firm's domain | `off_domain` | none |

A guard refusal is retryable under §6, and fanning out while an attempt remained
would be **unsound**, not merely eager: the retry could then store the homepage,
discovery would run, and the discovered URLs would be *added* to five fallbacks
already queued — one firm, eleven pages, the ceiling gone. So it waits until the
homepage has no attempts left, at which point no later attempt can discover
anything. A reliability case drives exactly that sequence and asserts six.

A 5xx never falls back. "The site gave no answer" is what §6's bounded retry
exists for, and asking five more URLs of a server returning 500s is load, not
fallback. That behaviour is unchanged from Day 3.

**The robots case costs one request, not five.** Each fallback job does its own
robots check inside the fetcher, and `robots_cache` holds the file for 24 hours,
so a blanket `Disallow: /` produces one cached robots.txt and five text-free
rows — no fetches. A narrower `Disallow: /$` blocks only the root, which is
precisely the case this reversal exists to serve.

**The off-domain guard is new, and it applies to the successful path too.** If
the homepage's final URL left the firm's registrable domain, nothing is fanned
out at all: not the discovered URLs, which are off-domain by definition, and not
the conventional ones either. §10 calls that site parked, the snapshot is
already ineligible for extraction (`off_domain_final_url` in
`src/pipeline/evidence.ts`), and `src/pipeline/domain.ts` says such a domain is
not company evidence "until company.resolve separately verifies that the other
domain belongs to the same firm". A parked domain does not get to nominate
pages, and it does not earn five guesses at the domain it left. A legitimate
subdomain redirect — `firm.com.au` to `www.firm.com.au` — is the same firm and
still fans out, which the Public Suffix List decides rather than a string
comparison.

This is the one part of the successful-homepage path that changed. Discovery
preference is untouched.

No model call, no provider choice, no migration, no new grant: the reversal is a
branch in one handler function and five extra rows in the jobs table.

---

# Day 5, the real one: the eval harness

Recorded 2026-10-10. §25's Day 5 row — "Eval harness: fixture format, snapshot
sanitiser, frozen snapshots, eval/run.ts, metrics, markdown report, dev/holdout
split. Kushagra labels 60 fixtures" — is now built, except for the two parts of
it that are not software. Deviation 13 recorded that this had been skipped; it is
no longer skipped, and deviation 13 stands as written.

## 22. `assembleSignals` is exported from the web.extract handler

One word added to a production file, no behaviour changed. The eval fixture
freezes §9's Tier A block, and §9 makes `unknown` a first-class answer distinct
from `absent` — only the scanner may say absent, and §10 pays 35 points for
absence.

A second implementation of that mapping inside the harness would have been a
second chance to get it wrong, and the corpus is the ground truth Day 6's
thresholds are derived from, so a divergence there would be both invisible and
load-bearing. The function is pure and already had exactly the right shape, so it
is imported rather than restated.

## 23. No dev/holdout ratio is invented; the counts are the operator's

§25 says "dev/holdout split" and the repository preserves no authoritative ratio
— no percentage, no count, nothing in §21 or §25. So `eval:split` requires
`--dev-count` and `--holdout-count` and refuses to run without them, and writes
the result to a checked-in `split.json`. Both safe designs together: the counts
decide how many, the committed manifest decides which, for ever.

The manifest is **append-only**. A domain already in it keeps its split; adding
fixtures later assigns only the new ones; moving one requires `--rebuild --yes`.
A fixture that drifts from holdout to dev has been tuned against, and that would
happen by accident — a re-run with different counts, a fixture added in the
middle — long before anyone did it deliberately.

Assignment order is `sha256(fixture_set + "\n" + domain)`, and `eval/split.ts`
does not import the labels file. A holdout chosen by looking at labels encodes
the ground truth into the partition, which is leakage by construction; the module
cannot do it because it cannot read them.

## 24. A fixture carries no timestamps at all, including no freeze time

The brief's list of unstable fields to exclude named row uuids, trace ids, worker
ids and `created_at`/`updated_at`. A freeze timestamp is not on that list and
would have been defensible as provenance — it is excluded anyway.

A fixture's identity is its content. With no timestamp, re-freezing unchanged
evidence produces byte-identical output, so `--replace` on an unchanged corpus is
a visible no-op and a `git diff` over the corpus means something. Freeze-time
provenance that actually matters (which set, which domain, which URL, which
content hash) is all stable and all present. `labelled_at` is a timestamp and it
lives in `labels.json`, because when a person decided is a fact about the person,
not about the evidence.

## 25. `uncertain` is a prediction that matches no label, and is counted as such

§4 gives `eval_fixtures.label` two values and `eval_results.predicted_verdict`
three, because `verdict` is `qualified | uncertain | rejected`. That is not an
inconsistency to paper over: §10 stage 7's gate is "Qualified, uncertain or
rejected", and ground truth is a decision a person actually made.

So `uncertain` is counted in its own right. It is never correct; it is not a
false qualification (nobody was contacted) and not a false rejection (the firm
was not discarded); it stays out of precision denominators and inside recall
denominators. The confusion matrix has a column for it rather than folding it
into either side.

Every rate is `null` when its denominator is zero, rendered as an em dash. A
report that said "qualified precision 0.0000" for a run that predicted nothing
qualified would be stating a result it does not have.

## 26. No predictor ships, and `eval:run` says so

§25 puts the rubric, `practice_area_priors`, the grounding filter, the thresholds
and the provider bake-off on **Day 6**. The harness therefore ships with a
typed predictor seam and no real predictor: `eval:run` without `--predictor`
prints that none exists rather than producing a number, and `hasRealPredictor()`
returns false.

`test-only-scripted` answers from a script, reads no evidence, requires
`--allow-test-predictor`, and stamps a warning banner on any report it touches.
It exists so the runner, the metrics and the report could be tested end to end. A
predictor that inspected the fixture and guessed would have been worse, because
it would have produced plausible numbers.

`eval_runs.rubric_version` and `prompt_version` are `NOT NULL`, so the runner
requires both on the command line and defaults neither. Day 6 owns the rubric;
this tool will not invent a version string for it.

## 27. `eval/` is a new top-level directory, and §19 already names it

§19 rule 1 forbids a new top-level directory without a written reason. No reason
is needed here beyond pointing at §19's own tree, which lists
`eval/ fixtures/, run.ts, report.ts`. The directory was always in the plan; this
is the day it exists. `eval/**/*.ts` was added to `tsconfig.json`'s `include` so
typecheck covers it, and `tests/eval/` follows the existing `tests/adversarial/`
precedent for a third suite category.

## 28. No migration, and the one place the schema pinches

§4's `eval_fixtures`, `eval_runs` and `eval_results` were enough as they stand.
Nothing was added, altered or dropped.

The one place it pinches, recorded because a future reader will hit it:
`eval_fixtures.label` is `NOT NULL`, so a row cannot exist for an unlabelled
fixture. An unlabelled fixture is a real and common state of a corpus on its way
to sixty. Rather than add a nullable column — or worse, write a placeholder label
— the **files** are the source of truth and the DB rows are metadata written only
for fixtures a human has already decided. That is also what the brief asked for,
and it means the schema never has to represent a label nobody gave.
