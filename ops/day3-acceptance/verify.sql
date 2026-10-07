-- Day 3 acceptance: read-only verification (SPEC.md §25 Day 3).
--
-- Every statement here is a SELECT. There is no INSERT, UPDATE, DELETE, TRUNCATE
-- or DDL in this file, so it cannot change the acceptance result it is reporting
-- on, and it is safe to run at any time, including while the worker is mid-run.
--
-- Run it on the VPS with:
--
--   cd /opt/stenth-operator
--   docker compose exec -T postgres psql -U postgres -d operator -f - \
--     < ops/day3-acceptance/verify.sql
--
-- psql connects over the container's local socket, so no password is typed, no
-- connection string is pasted, and nothing from .env is read or echoed.

\echo '== 1. Acceptance count: unique firms with usable 2xx evidence =='
-- The §25 criterion, as one number. 200-299, robots-allowed, and at least 500
-- characters of extracted text — the floor that separates a real homepage
-- (thousands of characters) from an error page or a JavaScript shell (dozens).
SELECT count(DISTINCT c.id) AS firms_counted
FROM companies c
JOIN web_snapshots s ON s.company_id = c.id
WHERE s.http_status BETWEEN 200 AND 299
  AND s.robots_allowed
  AND length(s.text) >= 500;

\echo ''
\echo '== 2. Per-site acceptance table =='
-- One row per firm the acceptance run registered, newest snapshot per firm.
-- `counts` is the same predicate as query 1, shown per row.
SELECT c.legal_name,
       c.canonical_domain                                  AS domain,
       j.status                                            AS job_status,
       j.attempts,
       s.http_status,
       s.robots_allowed,
       s.bytes,
       length(s.text)                                      AS text_length,
       (s.id IS NOT NULL)                                  AS snapshot_stored,
       (s.http_status BETWEEN 200 AND 299
         AND s.robots_allowed
         AND length(s.text) >= 500)                        AS counts,
       left(coalesce(j.last_error, ''), 120)               AS error
FROM companies c
LEFT JOIN LATERAL (
  SELECT status, attempts, last_error, trace_id
  FROM jobs
  WHERE kind = 'web.fetch' AND dedupe_key LIKE 'fetch:' || c.id || ':%'
  ORDER BY created_at DESC
  LIMIT 1
) j ON true
LEFT JOIN LATERAL (
  SELECT id, http_status, robots_allowed, bytes, text
  FROM web_snapshots
  WHERE company_id = c.id
    AND (j.trace_id IS NULL OR trace_id = j.trace_id)
  ORDER BY fetched_at DESC
  LIMIT 1
) s ON true
WHERE j.status IS NOT NULL
ORDER BY counts DESC NULLS LAST, c.canonical_domain;

\echo ''
\echo '== 3. Snapshots stored with an error status =='
-- Should be empty. Anything here is an error page sitting in the evidence table
-- with robots_allowed = true, indistinguishable from a real page to every later
-- stage. See ops/day3-acceptance/findings.md, finding 1.
SELECT c.canonical_domain, s.http_status, length(s.text) AS text_length, s.fetched_at
FROM web_snapshots s
JOIN companies c ON c.id = s.company_id
WHERE s.http_status >= 400
ORDER BY s.fetched_at DESC;

\echo ''
\echo '== 4. Job outcomes for the acceptance run =='
SELECT status, count(*) AS jobs
FROM jobs
WHERE kind = 'web.fetch'
GROUP BY status
ORDER BY status;

\echo ''
\echo '== 5. Jobs that are dead or blocked (§6: terminal, and an alert) =='
SELECT dedupe_key, attempts, max_attempts, left(coalesce(last_error, ''), 200) AS last_error
FROM jobs
WHERE kind = 'web.fetch' AND status IN ('dead', 'blocked')
ORDER BY updated_at DESC;

\echo ''
\echo '== 6. Robots decisions recorded =='
-- robots_allowed = false with no http_status is the §8 "disallow means skip"
-- row: the decision is recorded, nothing was fetched, and no text was stored.
SELECT c.canonical_domain, s.robots_allowed, s.http_status, (s.text IS NULL) AS text_is_null
FROM web_snapshots s
JOIN companies c ON c.id = s.company_id
WHERE NOT s.robots_allowed
ORDER BY c.canonical_domain;

\echo ''
\echo '== 7. robots.txt cache state (24h TTL, §8) =='
SELECT host, (body = '') AS no_robots_file, crawl_delay_seconds, fetched_at
FROM robots_cache
ORDER BY fetched_at DESC
LIMIT 30;

\echo ''
\echo '== 8. Duplicate guards: both counts must be zero =='
SELECT (SELECT count(*) FROM (
          SELECT canonical_domain FROM companies
          GROUP BY canonical_domain HAVING count(*) > 1) d)      AS duplicate_companies,
       (SELECT count(*) FROM (
          SELECT dedupe_key FROM jobs
          GROUP BY dedupe_key HAVING count(*) > 1) k)            AS duplicate_job_keys;

\echo ''
\echo '== 9. Nothing outside this test moved =='
-- Day 3 has no extract, assess, contact or draft stage, so these must all be
-- zero. A non-zero number means something other than the acceptance run wrote
-- to the database.
SELECT (SELECT count(*) FROM extractions)       AS extractions,
       (SELECT count(*) FROM assessments)       AS assessments,
       (SELECT count(*) FROM contacts)          AS contacts,
       (SELECT count(*) FROM outreach_drafts)   AS outreach_drafts,
       (SELECT count(*) FROM approved_outreach) AS approved_outreach,
       (SELECT count(*) FROM prospects)         AS prospects;

\echo ''
\echo '== 10. Scheduler liveness and spend (unchanged by this run) =='
SELECT (SELECT last_tick_at FROM scheduler_heartbeat LIMIT 1) AS last_scheduler_tick,
       (SELECT count(*) FROM llm_calls)                       AS llm_calls,
       (SELECT coalesce(sum(cost_usd), 0) FROM llm_calls)     AS spend_usd;

\echo ''
\echo '== 11. Final URL per firm, flagged when it left the firm''s own domain =='
-- §8 re-validates scheme, port and resolved address on every redirect hop, but
-- not the host, so a redirect can move a snapshot onto another domain. apex->www
-- and http->https are normal and expected; an unrelated host is the "parked
-- domain" case §10 means to disqualify. See findings.md, finding 2.
SELECT c.canonical_domain,
       s.url AS final_url,
       (split_part(regexp_replace(s.url, '^https?://', ''), '/', 1)
          NOT IN (c.canonical_domain, 'www.' || c.canonical_domain)) AS off_domain
FROM web_snapshots s
JOIN companies c ON c.id = s.company_id
WHERE s.url IS NOT NULL
ORDER BY off_domain DESC, c.canonical_domain;
