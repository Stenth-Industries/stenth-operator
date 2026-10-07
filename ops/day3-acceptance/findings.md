# Day 3 acceptance: application findings

Written while preparing the acceptance run. **Nothing here is fixed yet** — these
are reports, not changes, and the fetcher's behaviour on the VPS today is exactly
what it was before this document existed.

---

## Finding 1 — an HTTP error page is stored as a successful snapshot

**Severity: must be corrected before Day 4.**

### What happens

`src/fetch/http.ts` → `guardedFetch` returns any non-redirect response. It
refuses on scheme, port, address class, content type, redirect count, size and
timeout, and it treats a redirect specially — but a 403, 404, 410 or 503 is
returned to the caller like any other response, with its body.

`src/fetcher/server.ts` → `fetchAndStore` then stores it without looking at the
status:

```ts
const extracted = htmlToText(outcome.body);          // the error page's text
const snapshotId = await storeSnapshot(deps.pool, {
  url: outcome.finalUrl,
  httpStatus: outcome.httpStatus,                    // 403, recorded
  text: extracted.text,                              // "Access denied" — stored
  robotsAllowed: true,                               // asserted true
  ...
});
return { outcome: 'stored', http_status: outcome.httpStatus, ... };
```

`src/worker/handlers/web-fetch.ts` counts `outcome === 'stored'`, so `stored`
becomes 1 and the job completes as **succeeded**.

Observed in production on 2026-10-07: Doogue + George returned 403, the snapshot
was stored, and the job was marked succeeded.

### Is it compliant with the frozen spec?

**§8's fetch-hardening table says nothing about status codes.** So this is not a
violation of a rule that was written down — it is a gap in the table. That is the
honest reading, and it is why this is a report rather than a patch.

**But the effect is outside what three other sections require**, so the gap has
to be closed rather than documented:

1. **§9 Tier A.** "All of it is read out of stored HTML by code, not inferred by
   a model," from "the firm's own public site." An error page is not the firm's
   site. Every Tier A signal is *absent* from a 403 body: no `AW-` tag, no `G-`
   id, no `GTM-` container, no form, no `tel:` link, no location pages, thin
   content, no copyright year.

2. **§10 rubric.** Those absences are precisely what the **Visible execution
   gap** dimension pays for — 35 points, the largest of the five, and v1.1 raised
   it from 25 *because* "every component is now directly observable." Scored
   against an error page, the dimension reads as a maximum. A site that blocks us
   therefore produces a **high** qualification score from no evidence at all,
   which inverts §10's grounding mechanic instead of tripping it.

3. **§10 hard disqualifiers.** "No website, or the site is dead, parked or under
   construction" is a disqualifier, and the HTTP status is the machine-checkable
   signal for it — "most are caught in stage 2 for free." Today the status is
   recorded and then contradicted by `outcome: 'stored'` and a succeeded job, so
   no later stage can tell a dead site from a live one.

Two smaller consequences, both real:

- **Cost.** §10 orders the stages "cheap deterministic ones first, so no model is
  paid to reject an obvious miss." A succeeded `web.fetch` enqueues
  `web.extract`, which is an isolated model call. Against the amended budget —
  **$50/month, warning at $35** — paying for extraction of "Access denied" is
  money spent on nothing, on every blocked site, every run.
- **Audit trail.** §15 and §16 want the trail to record what happened. A row with
  `robots_allowed = true` and error-page prose in `text` records that we
  retrieved the firm's page. We did not.

**Verdict: non-compliant in effect, compliant on the letter of §8.** The
correction belongs in the fetcher, before Day 4 builds the stage that pays for
the mistake.

### Proposed correction (not applied)

Smallest change that closes it, in the shape the file already uses — the
`robots_disallowed` path is already a snapshot row that records a decision and
stores no text, so this is the same pattern applied to a second case.

1. **`src/fetcher/server.ts`** — branch after `guardedFetch`:
   - `2xx` → unchanged: extract, hash, store with text, return `'stored'`.
   - anything else → store the row **with `text` NULL** (keep `http_status`,
     `bytes`, `robots_allowed`, `url`, `trace_id`) and return a new outcome
     `'http_error'` with `reason: 'http_status_<code>'` and no `text_length`.
     The decision stays in the audit trail; the error prose never enters the
     evidence table.
2. **`src/fetcher/contract.ts`** — add `'http_error'` to the outcome enum. The
   `reason` token already matches `/^[a-z0-9_]+$/`.
3. **`src/worker/handlers/web-fetch.ts`** — count `http_error` separately from
   `stored`, and split retry behaviour by class, because the two are not the same
   kind of failure:
   - **4xx is terminal.** The site answered and the answer is no. Retrying it
     three times is three more unwanted requests at a site that just refused us,
     which is the opposite of what requirement 9 asks for. The job completes with
     zero usable pages and the outcome recorded.
   - **5xx and transport failures stay retryable**, as now: no answer was given,
     so asking again later is legitimate.
4. **Day 4** — `web.extract` is enqueued per snapshot *that has text*. With the
   change above that is automatic rather than a second rule to remember.

### Tests the correction needs

- `tests/reliability/fetcher-service.test.ts`: one case per status class — 403,
  404, 410, 500, 503 — asserting `outcome: 'http_error'`, `text IS NULL` in the
  stored row, and the status preserved.
- The same suite: a 2xx page still stores its text (guard against over-correcting).
- `tests/unit/response-boundary.test.ts`: `http_error` carries no `text_length`
  and no page content.
- `tests/reliability/web-fetch-handler.test.ts`: an all-4xx job does **not**
  retry; an all-5xx job does.

### Until it is corrected

The acceptance count is taken from `web_snapshots`, never from `jobs.status`:
`http_status BETWEEN 200 AND 299 AND robots_allowed AND length(text) >= 500`.
`run.ts report` and `verify.sql` query 3 both list any stored error page
explicitly, so a 403 cannot be quietly counted.

---

## Finding 2 — a redirect can move a snapshot off the firm's own domain

**Severity: low for Day 3, decide before Day 5. No change proposed yet.**

`guardedFetch` re-validates every redirect hop for scheme, port and resolved
address — §8's requirement — but not for host. The row is then written with
`url: outcome.finalUrl`. So if `firmname.com.au` redirects to an unrelated host,
up to three hops away, that host's content is stored as this company's evidence,
and nothing in the row says the domain changed.

Most of what a real run will hit is benign and must keep working: apex → `www`,
`http` → `https`, and a firm that genuinely moved domains. The problem case is
an expired domain pointing at a parking or affiliate host, which §10 means to
disqualify as "parked" and which would instead be read as the firm's site.

This also touches §9's hardest line: contact discovery is "frozen to the firm's
own published site," enforced by `contacts.email_source_snapshot_id`. If the
snapshot behind an address is a different domain's page, the structural guarantee
holds while the premise does not.

Not proposing a fetcher change: §8 lists no same-host rule, the fetcher is frozen
for Day 3, and refusing off-domain redirects outright would break the apex→www
case on a large share of real sites. The two options, for a decision rather than
a quiet fix:

- **(a) Record it.** Compare the registrable domain of `final_url` against
  `companies.canonical_domain` in the extract stage and treat a mismatch as "not
  the firm's own site" for §9 purposes — the natural home is Day 4, where the
  public-suffix list is already needed.
- **(b) Refuse it in the fetcher**, allowing only the same registrable domain
  across hops. Stricter, cheaper, and it will reject firms that legitimately
  redirect to a new domain.

(a) matches the spec's structure better: §9 is about what counts as the firm's
own evidence, not about what the fetcher is allowed to retrieve.

For the acceptance run this is visible, not harmful: `verify.sql` query 11 lists
the final URL per firm and flags any host that is neither the firm's domain nor
its `www.` form, so an off-domain redirect is reported rather than discovered
later. `run.ts report --json` carries the same `final_url` per row.
