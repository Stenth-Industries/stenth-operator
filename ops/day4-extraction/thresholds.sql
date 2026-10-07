-- Day 4 eligibility threshold comparison, read-only (review item 2).
--
-- The same measurement as ops/day4-extraction/thresholds.ts, as SQL, for when
-- psql is closer to hand than the tools container. Every statement is a SELECT.
--
--   cd /opt/stenth-operator
--   docker compose exec -T postgres psql -U postgres -d operator -f - \
--     < ops/day4-extraction/thresholds.sql
--
-- One difference from the TypeScript version, and it matters: the on-domain
-- column here is host equality, because SQL cannot ask the Public Suffix List.
-- It will read a legitimate subdomain as off-domain. The gate that decides
-- whether money is spent uses the list (src/pipeline/domain.ts); treat this
-- column as a hint and the TypeScript table as the answer.

\echo '== Per-firm measurement: newest usable snapshot per firm =='
WITH newest AS (
  SELECT DISTINCT ON (c.canonical_domain)
         c.canonical_domain::text AS domain,
         c.legal_name,
         s.url,
         regexp_replace(btrim(s.text), '\s+', ' ', 'g') AS normalised,
         (w.signals IS NOT NULL) AS has_signals
    FROM usable_snapshots s
    JOIN web_snapshots w ON w.id = s.id
    JOIN companies c ON c.id = s.company_id
   ORDER BY c.canonical_domain, s.fetched_at DESC
)
SELECT legal_name,
       domain,
       length(normalised) AS chars,
       (SELECT count(DISTINCT w) FROM regexp_matches(lower(normalised), '[a-z][a-z''-]+', 'g') AS m(w))
         AS distinct_words,
       (lower(split_part(regexp_replace(url, '^https?://', ''), '/', 1))
          IN (lower(domain), 'www.' || lower(domain))) AS on_domain_host_equality,
       has_signals
  FROM newest
 ORDER BY chars;

\echo ''
\echo '== Threshold comparison =='
WITH newest AS (
  SELECT DISTINCT ON (c.canonical_domain)
         c.canonical_domain::text AS domain,
         s.url,
         regexp_replace(btrim(s.text), '\s+', ' ', 'g') AS normalised
    FROM usable_snapshots s
    JOIN companies c ON c.id = s.company_id
   ORDER BY c.canonical_domain, s.fetched_at DESC
), measured AS (
  SELECT domain,
         length(normalised) AS chars,
         (SELECT count(DISTINCT w) FROM regexp_matches(lower(normalised), '[a-z][a-z''-]+', 'g') AS m(w))
           AS words
    FROM newest
), thresholds (label, min_chars, min_words) AS (
  VALUES ('400 / 20', 400, 20),
         ('500 / 25', 500, 25),
         ('750 / 30', 750, 30),
         ('1000 / 50', 1000, 50)
)
SELECT t.label,
       count(*) FILTER (WHERE m.chars >= t.min_chars AND m.words >= t.min_words) AS eligible,
       count(*) FILTER (WHERE m.chars <  t.min_chars OR  m.words <  t.min_words) AS excluded,
       coalesce(string_agg(
         m.domain || ' (' || m.chars || 'c/' || m.words || 'w)', ', '
         ORDER BY m.chars
       ) FILTER (WHERE m.chars < t.min_chars OR m.words < t.min_words), '(none)') AS excluded_firms
  FROM thresholds t CROSS JOIN measured m
 GROUP BY t.label, t.min_chars, t.min_words
 ORDER BY t.min_chars;

\echo ''
\echo '== Firms with no Tier A scan: these record Tier A as unknown =='
SELECT c.canonical_domain, count(*) AS snapshots
  FROM web_snapshots s JOIN companies c ON c.id = s.company_id
 WHERE s.signals IS NULL AND s.http_status BETWEEN 200 AND 299
 GROUP BY c.canonical_domain
 ORDER BY c.canonical_domain;
