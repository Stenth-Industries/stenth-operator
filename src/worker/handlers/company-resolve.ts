/**
 * The company.resolve handler (SPEC.md §6, §7, §10 stages 1–3).
 *
 * §6: "Normalises the domain, dedupes, applies hard filters", enqueues
 * web.fetch, three attempts. §10 stages 1 and 2 are code-only and no model is
 * involved at any point — this handler never calls a provider, never reserves
 * budget, and never reads a page.
 *
 * ## One web.fetch job per page, not one job carrying six URLs
 *
 * This is the design decision Day 3 deferred, and §7 already contains the
 * answer. The web.fetch dedupe key is `fetch:{company_id}:{url_hash}:{date}` —
 * singular `url_hash`, one key per URL. A job carrying six URLs would have one
 * key for six pieces of work and, more importantly, one retry budget:
 *
 *   ops/day3-acceptance/findings.md, "Known residual, bounded and deliberate":
 *   a job where one page is 4xx and another is 5xx retries because of the 5xx,
 *   and the 4xx URL is requested again on that attempt. "Avoiding it needs
 *   per-URL state across attempts, which is a design decision for Day 5 — when
 *   company.resolve starts fanning out to §10's six pages."
 *
 * Per-URL state across attempts is exactly what a per-URL job is. The 404 job
 * succeeds terminally on its first attempt and is never asked again; the 503 job
 * retries alone with its own backoff and dies alone. No new state, no new table,
 * no change to the retry rules, and the fetcher's politeness token bucket still
 * spaces the requests because it is keyed by host, not by job.
 *
 * The web.fetch payload still accepts up to six URLs. That limit protects the
 * fetcher from any caller and stays where it is; this handler simply emits one
 * URL per job.
 *
 * ## Everything in one transaction
 *
 * The company row, its source row, the prospect row and all six enqueues commit
 * together or not at all. That is what makes a retry safe: a crash halfway
 * cannot leave a prospect with no fetches queued, which would otherwise read as
 * "already a prospect" on the next attempt and stall the firm for ever.
 */
import type { Pool } from 'pg';
import { z } from 'zod';

import { enqueue } from '../../jobs/enqueue';
import { dedupeKey, fetchUrlHash } from '../../jobs/kinds';
import type { ClaimedJob } from '../../jobs/queue';
import { withTrace } from '../../obs/log';
import {
  MAX_PLANNED_PAGES,
  normaliseCandidateDomain,
  planPages,
  type PageKind,
  type ResolveRejection,
} from '../../pipeline/resolve';

export const companyResolvePayloadSchema = z
  .object({
    /** A bare domain or a URL, as discovery produces it. Normalised here. */
    candidate_domain: z.string().min(1).max(2_048),
    campaign_id: z.string().uuid(),
    /** §4 company_sources.source_kind. */
    source_kind: z.enum(['search_query', 'manual']),
    source_ref: z.string().min(1).max(512),
  })
  .strict();

export type CompanyResolvePayload = z.infer<typeof companyResolvePayloadSchema>;

export interface CompanyResolveDeps {
  readonly pool: Pool;
  /** The fetch occurrence for §7's per-occurrence key. Defaults to today, UTC. */
  readonly occurrence?: string;
}

export type CompanyResolveResult =
  | {
      readonly kind: 'resolved';
      readonly companyId: string;
      readonly canonicalDomain: string;
      readonly companyCreated: boolean;
      readonly prospectCreated: boolean;
      /** Jobs this call inserted. Lower than planned on an idempotent re-run. */
      readonly fetchesEnqueued: number;
      readonly pagesPlanned: number;
      readonly pageKinds: readonly PageKind[];
    }
  | {
      readonly kind: 'rejected';
      readonly reason: ResolveRejection;
      readonly detail: string;
      readonly companyId: string | null;
    };

/** Today in UTC, as §7's `yyyy-mm-dd` occurrence. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Resolves one candidate.
 *
 * A rejection is a *successful* job. §10 stage 2's whole purpose is to reject
 * for free, and a candidate that is suppressed or already in the pipeline has
 * been answered, not failed — throwing would retry it three times and then
 * raise an alert about a correct decision. §6's `blocked` state is the budget
 * ceiling and is not this.
 */
export async function handleCompanyResolve(
  job: ClaimedJob,
  deps: CompanyResolveDeps,
): Promise<CompanyResolveResult> {
  const payload = companyResolvePayloadSchema.parse(job.payload);
  const log = withTrace(job.trace_id);
  const occurrence = deps.occurrence ?? todayUtc();

  // Stage 1, before any connection is taken: a candidate with no registrable
  // domain cannot become a company row, so it never reaches the database.
  const normalised = normaliseCandidateDomain(payload.candidate_domain);
  if (!normalised.ok) {
    await recordRejection(deps.pool, job, normalised.reason, null);
    log.info(
      { reason: normalised.reason, detail: normalised.detail },
      'company.resolve rejected a candidate before any lookup',
    );
    return {
      kind: 'rejected',
      reason: normalised.reason,
      detail: normalised.detail,
      companyId: null,
    };
  }

  const canonicalDomain = normalised.canonicalDomain;
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');

    // Stage 2, the suppression half. §15's do-not-contact list is checked
    // before a company row exists: a suppressed firm should leave no trace of
    // having been considered beyond the audit event.
    const suppressed = await client.query(
      `SELECT 1 FROM suppressions
        WHERE match_type = 'domain' AND lower(match_value) = lower($1)
        LIMIT 1`,
      [canonicalDomain],
    );
    if (suppressed.rowCount === 1) {
      await writeEvent(client, 'job', job.id, 'company.rejected', job.trace_id, {
        reason: 'suppressed_domain',
        canonical_domain: canonicalDomain,
      });
      await client.query('COMMIT');
      log.info({ canonical_domain: canonicalDomain }, 'company.resolve: domain is suppressed');
      return {
        kind: 'rejected',
        reason: 'suppressed_domain',
        detail: `${canonicalDomain} is on the suppression list`,
        companyId: null,
      };
    }

    // §4's deduplication constraint doing the work: canonical_domain is unique,
    // so two candidates that normalise to one firm produce one row. DO UPDATE
    // rather than DO NOTHING so the id comes back either way, and `created`
    // comes from the system column rather than from a second query.
    const upserted = await client.query<{ id: string; created: boolean }>(
      `INSERT INTO companies (canonical_domain) VALUES ($1)
       ON CONFLICT (canonical_domain) DO UPDATE SET updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [canonicalDomain],
    );
    const company = upserted.rows[0];
    if (company === undefined) {
      throw new Error(`the companies upsert for ${canonicalDomain} returned no row`);
    }

    // How we found it (§4 company_sources). Guarded rather than blind so a
    // replayed attempt does not accumulate identical provenance rows (§7).
    await client.query(
      `INSERT INTO company_sources (company_id, source_kind, source_ref, raw, trace_id)
       SELECT $1, $2::source_kind, $3, $4::jsonb, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM company_sources
           WHERE company_id = $1 AND source_kind = $2::source_kind AND source_ref = $3
        )`,
      [
        company.id,
        payload.source_kind,
        payload.source_ref,
        JSON.stringify({ candidate_domain: payload.candidate_domain }),
        job.trace_id,
      ],
    );

    // Stage 2, the other half: "already a prospect in this campaign".
    const existing = await client.query<{ id: string; stage: string }>(
      `SELECT id, stage::text AS stage FROM prospects
        WHERE company_id = $1 AND campaign_id = $2`,
      [company.id, payload.campaign_id],
    );
    if (existing.rows[0] !== undefined) {
      await writeEvent(client, 'company', company.id, 'company.rejected', job.trace_id, {
        reason: 'already_a_prospect',
        canonical_domain: canonicalDomain,
        prospect_id: existing.rows[0].id,
        stage: existing.rows[0].stage,
      });
      await client.query('COMMIT');
      log.info(
        { canonical_domain: canonicalDomain, stage: existing.rows[0].stage },
        'company.resolve: already a prospect in this campaign',
      );
      return {
        kind: 'rejected',
        reason: 'already_a_prospect',
        detail: `prospect ${existing.rows[0].id} is at stage ${existing.rows[0].stage}`,
        companyId: company.id,
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO prospects (company_id, campaign_id, stage)
       VALUES ($1, $2, 'discovered')
       ON CONFLICT (company_id, campaign_id) DO NOTHING
       RETURNING id`,
      [company.id, payload.campaign_id],
    );
    const prospectCreated = inserted.rows[0] !== undefined;

    // Stage 3's fan-out. One job per page, each with its own §7 key and its own
    // §6 retry budget.
    const pages = planPages(canonicalDomain);
    if (pages.length > MAX_PLANNED_PAGES) {
      throw new Error(`the page plan produced ${pages.length} pages, over §10's six`);
    }

    let fetchesEnqueued = 0;
    for (const page of pages) {
      const result = await enqueue(client, {
        kind: 'web.fetch',
        dedupeKey: dedupeKey.webFetch(company.id, fetchUrlHash([page.url]), occurrence),
        traceId: job.trace_id,
        payload: { company_id: company.id, urls: [page.url], page_kind: page.kind },
        parentJobId: job.id,
      });
      if (result.inserted) {
        fetchesEnqueued += 1;
      }
    }

    await writeEvent(client, 'company', company.id, 'company.resolved', job.trace_id, {
      canonical_domain: canonicalDomain,
      company_created: company.created,
      prospect_created: prospectCreated,
      pages_planned: pages.length,
      fetches_enqueued: fetchesEnqueued,
      page_kinds: pages.map((page) => page.kind),
      occurrence,
    });

    await client.query('COMMIT');

    log.info(
      {
        company_id: company.id,
        canonical_domain: canonicalDomain,
        pages_planned: pages.length,
        fetches_enqueued: fetchesEnqueued,
      },
      'company.resolve complete',
    );

    return {
      kind: 'resolved',
      companyId: company.id,
      canonicalDomain,
      companyCreated: company.created,
      prospectCreated,
      fetchesEnqueued,
      pagesPlanned: pages.length,
      pageKinds: pages.map((page) => page.kind),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A rejection decided before a transaction was needed. */
async function recordRejection(
  pool: Pool,
  job: ClaimedJob,
  reason: ResolveRejection,
  companyId: string | null,
): Promise<void> {
  await writeEvent(
    pool,
    companyId === null ? 'job' : 'company',
    companyId ?? job.id,
    'company.rejected',
    job.trace_id,
    { reason },
  );
}

/**
 * One append-only audit row.
 *
 * Machine tokens, ids and counts only. `canonical_domain` is in there because
 * §4 makes it the firm's business key and an audit of a dedupe decision is
 * unreadable without it; `source_ref` is not, because a search query is prose
 * and §16 keeps prose out of the spine. It lives in company_sources.raw.
 */
async function writeEvent(
  db: { query: Pool['query'] },
  entityType: 'job' | 'company',
  entityId: string,
  kind: string,
  traceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO events (entity_type, entity_id, kind, actor_type, payload, trace_id)
     VALUES ($1, $2, $3, 'system', $4::jsonb, $5)`,
    [entityType, entityId, kind, JSON.stringify(payload), traceId],
  );
}
