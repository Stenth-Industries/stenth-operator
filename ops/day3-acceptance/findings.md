# Day 3 acceptance: application findings

## Finding 1 — an HTTP error page was stored as a successful snapshot

**Status: FIXED.** Code, contract and schema changed; regression tests added.

### What was wrong

`guardedFetch` returned any non-redirect response, body and all, and
`fetchAndStore` stored it without looking at the status: a 403 landed in
`web_snapshots` with `robots_allowed = true` and the error page's own prose in
`text`, and the job completed as **succeeded**. Observed in production on
2026-10-07 against Doogue + George.

§8's hardening table says nothing about status codes, so this broke no written
rule — it was a gap. The effect was still outside what the rest of the spec
requires:

- **§9 Tier A** signals are observations of the firm's own public site, read out
  of stored HTML by code. Every one of them is *absent* from an error page.
- **§10**'s **Visible execution gap** dimension — 35 points, the largest of the
  five, raised in v1.1 *because* every component is directly observable — pays
  for exactly those absences. A firm that blocked us therefore scored like a
  strong prospect on no evidence at all.
- **§10**'s "site is dead, parked or under construction" disqualifier has the
  status code as its machine-checkable signal, and `outcome: 'stored'` plus a
  succeeded job contradicted it.
- From Day 4 a succeeded `web.fetch` enqueues `web.extract`, so each blocked
  site would have paid for an isolated model call on "Access denied", against a
  $50 monthly budget with a $35 warning.

### What changed

Four layers, because the requirement was that bad evidence be impossible to
promote rather than merely unlikely to be:

1. **`src/fetch/http.ts`** — the body of any non-2xx response is dropped at the
   edge. `bytes` is still the real count, so diagnostics survive, but the error
   page's markup is never handed up and never reaches the HTML parser.
2. **`src/fetcher/server.ts`** — the status is classified before anything else
   happens:
   - **2xx** → unchanged: extracted, hashed, stored with text, `outcome:
     'stored'`.
   - **4xx** → terminal. A diagnostic row is written with **`text` NULL**,
     keeping `http_status`, `bytes`, `url` and `trace_id`, and the reply is
     `outcome: 'http_error'`, `reason: 'http_status_<code>'`. The site is asked
     once.
   - **5xx**, and any status that is neither 2xx nor 4xx → `outcome:
     'http_unavailable'`, **no row at all**: a snapshot row records a decision
     that is final, and this one is not. The job's §6 retry budget decides.
3. **`src/fetcher/contract.ts`** — the terminal/retryable split is declared in
   the contract the two sides share, as `TERMINAL_OUTCOMES`,
   `RETRYABLE_OUTCOMES` and `isRetryable`, with a test asserting the two sets
   partition the enum so a new outcome cannot be added unclassified. The
   response schema now also refuses a `content_hash` or a `text_length` on any
   outcome but `stored` — the exact shape the production 403 reply had.
4. **`migrations/005_snapshot_text_requires_2xx.sql`** — the database refuses
   the row:
   ```sql
   CHECK (text IS NULL
          OR (http_status IS NOT NULL AND http_status BETWEEN 200 AND 299))
   NOT VALID
   ```
   `NOT VALID` because the production 403 row is kept: it is enforced on every
   insert and update from now on and skips the scan of existing rows. No delete
   migration, as instructed. It still permits the two text-free shapes the
   pipeline needs — the robots-disallowed row (`http_status` NULL) and a
   snapshot whose text `maintenance.prune` has removed.

   The same migration defines **`usable_snapshots`**, the one predicate later
   analysis reads: 2xx, robots-allowed, text present. `text IS NOT NULL` alone
   is not safe, because the legacy 403 row satisfies it; the view excludes it
   whether or not it is ever cleaned. Granted to `operator_app` and
   `operator_ro`, and deliberately **not** to `operator_fetch` — a view runs
   with its owner's privileges, so granting it there would hand back the page
   text migration 004 withheld column by column.

5. **`src/worker/handlers/web-fetch.ts`** — `snapshotIds` is now
   `extractableSnapshotIds` and contains only `stored` ids. A robots-disallowed
   row and a 4xx row both exist in `web_snapshots` and both have `text` NULL;
   neither belongs in the list Day 4 iterates to enqueue `web.extract`. The
   retry decision is `stored === 0 && robotsDisallowed === 0 && retryable > 0`,
   so a job whose pages all ended terminally completes instead of turning one
   unwanted request into three.

### What a job does now, by status

| Status | Outcome | Row | Text | Retries | Counts as evidence |
|---|---|---|---|---|---|
| 2xx | `stored` | yes | yes | — | yes |
| robots `Disallow` | `robots_disallowed` | yes | NULL | — | no |
| 401/403/404/429 | `http_error` | yes, diagnostic | NULL | **no** | no |
| 500/503, other | `http_unavailable` | no | — | yes, §6 bounded → dead | no |
| guard refusal | `refused` | no | — | yes, §6 bounded → dead | no |

### Known residual, bounded and deliberate

A job carrying several URLs where **one** page is 4xx and **another** is 5xx
retries because of the 5xx, and the 4xx URL is requested again on that attempt.
Avoiding it needs per-URL state across attempts, which is a design decision for
Day 5 — when `company.resolve` starts fanning out to §10's six pages — not a
change to make quietly now. It cannot occur in the acceptance run: one homepage
per job, `--max-attempts=1`.

---

## Finding 2 — a redirect can move a snapshot off the firm's own domain

**Status: OPEN, by decision. No registrable-domain policy implemented.**

`guardedFetch` re-validates every redirect hop for scheme, port and resolved
address — §8's requirement — but not for host, and the row is written with
`url: outcome.finalUrl`. So a redirect can store another host's content as this
company's evidence, with nothing in the row saying the domain changed.

Most of what a real run hits is benign and must keep working: apex → `www`,
`http` → `https`, and a firm that genuinely moved domains. The problem case is
an expired domain pointing at a parking or affiliate host, which §10 means to
disqualify as "parked" and which would instead be read as the firm's site. It
also touches §9's hardest line — contact discovery is "frozen to the firm's own
published site", enforced by `contacts.email_source_snapshot_id` — because the
structural guarantee holds while the premise does not.

**What is in place for now, and only this:** occurrences are reported, never
filtered.

- `run.ts report` prints an `OFF-DOMAIN FINAL URL` block naming every site whose
  `final_url` host is neither the firm's domain nor its `www.` form.
- `verify.sql` query 11 lists the final URL per firm with an `off_domain` flag.
- `usable_snapshots` deliberately does **not** filter on domain, and its comment
  says so.

**Day 4 constraint:** `web.extract` must not consume an off-domain snapshot as
company evidence until this policy is resolved. The two options, for a decision
rather than a quiet fix:

- **(a) Record it.** Compare the registrable domain of `final_url` against
  `companies.canonical_domain` in the extract stage and treat a mismatch as "not
  the firm's own site" for §9 purposes. The public-suffix list is already needed
  there.
- **(b) Refuse it in the fetcher**, allowing only the same registrable domain
  across hops. Stricter and cheaper, and it rejects firms that legitimately
  redirect to a new domain.

(a) matches the spec's structure better: §9 is about what counts as the firm's
own evidence, not about what the fetcher may retrieve.
