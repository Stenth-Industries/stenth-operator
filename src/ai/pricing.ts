/**
 * Cost arithmetic (SPEC.md §16, §19).
 *
 * §16: llm_calls records "a cost computed from model_pricing rather than
 * hard-coded". That is not bookkeeping pedantry — the budget gate runs *before*
 * the call and has to estimate, and an estimate from a constant in the source
 * drifts from the invoice the first time a price changes. The table is the
 * source of truth and a price change is a data change.
 *
 * A model with no pricing row cannot be estimated, so it cannot be authorised.
 * Failing closed is the only safe direction for a control that exists to stop
 * spending.
 */
import type { Pool, PoolClient } from 'pg';

export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  readonly effectiveFrom: Date;
}

type Queryable = Pool | PoolClient;

/** The price in force now for this provider and model, if there is one. */
export async function priceFor(
  db: Queryable,
  provider: string,
  model: string,
): Promise<ModelPrice | undefined> {
  const { rows } = await db.query<{
    input_per_mtok: string;
    output_per_mtok: string;
    effective_from: Date;
  }>(
    `SELECT input_per_mtok, output_per_mtok, effective_from
       FROM model_pricing
      WHERE provider = $1 AND model = $2 AND effective_from <= now()
      ORDER BY effective_from DESC
      LIMIT 1`,
    [provider, model],
  );

  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    inputPerMtok: Number(row.input_per_mtok),
    outputPerMtok: Number(row.output_per_mtok),
    effectiveFrom: row.effective_from,
  };
}

/**
 * Cost in USD for a token count at a price.
 *
 * Cached tokens are counted at the input rate. Providers discount them by
 * different amounts and §4's model_pricing has two columns, not three, so
 * charging them in full is the conservative reading: the estimate is never
 * lower than the invoice, which is the direction a budget gate needs.
 */
export function costUsd(
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number },
  price: ModelPrice,
): number {
  const inputTokens = usage.inputTokens + (usage.cachedTokens ?? 0);
  const dollars =
    (inputTokens / 1_000_000) * price.inputPerMtok +
    (usage.outputTokens / 1_000_000) * price.outputPerMtok;
  // Six decimal places, matching numeric(12, 6) in §4.
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/**
 * Tokens in a string, estimated for the pre-call gate only.
 *
 * Four characters per token is the usual rough figure for English prose and it
 * is deliberately rounded up here. The gate's job is to refuse a call that
 * *might* cross the ceiling; an estimate that reads low would let it through.
 * The recorded cost always comes from the provider's own usage numbers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
