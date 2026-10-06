/**
 * GET /api/health (SPEC.md §20).
 *
 * Reports database connectivity, queue depth, the age of the last successful
 * job, the age of the last scheduler tick, and month-to-date spend. Private:
 * reached over Tailscale, 404 through the public Caddy site block.
 *
 * 200 when the database answers, 503 when it does not, so a check can be a
 * status-code check and not a body parse.
 */
import { NextResponse } from 'next/server';

import { getPool } from '../../../db/client';
import { collectHealth } from '../../../db/health';
import { withTrace } from '../../../obs/log';
import { TRACE_HEADER, adoptTraceId } from '../../../obs/trace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const traceId = adoptTraceId(request.headers.get(TRACE_HEADER));
  const log = withTrace(traceId);

  const report = await collectHealth(getPool());

  if (report.status === 'ok') {
    log.info(
      {
        queue_depth: report.queue?.depth,
        spend_state: report.spend?.state,
        db_latency_ms: report.database.latency_ms,
      },
      'health ok',
    );
  } else {
    log.error({ err: report.database.error }, 'health check failed');
  }

  return NextResponse.json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: {
      [TRACE_HEADER]: traceId,
      'cache-control': 'no-store',
    },
  });
}
