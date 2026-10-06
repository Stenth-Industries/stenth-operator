/**
 * A 5-field cron matcher for the in-process scheduler (SPEC.md §6).
 *
 * Hand-written rather than a dependency. The scheduler needs one thing from
 * cron — "when is the next occurrence after this instant" — and a parser for
 * that is ~100 lines of arithmetic with no supply-chain surface. It is pure,
 * takes its instant as an argument, and is therefore exhaustively testable
 * without a clock.
 *
 * Fields: minute hour day-of-month month day-of-week.
 * Syntax: * , - / and plain numbers. Day-of-week accepts 0-7, 0 and 7 Sunday.
 *
 * All evaluation is UTC. The scheduler's own work (pruning, discovery) has no
 * local-time requirement; the one job that does — the nightly backup — runs
 * from a host systemd timer and never touches this code (§18, §20).
 */

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  readonly name: string;
}

const MINUTE: FieldSpec = { min: 0, max: 59, name: 'minute' };
const HOUR: FieldSpec = { min: 0, max: 23, name: 'hour' };
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31, name: 'day-of-month' };
const MONTH: FieldSpec = { min: 1, max: 12, name: 'month' };
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 7, name: 'day-of-week' };

export interface CronExpression {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when the field was a bare '*', which decides the §6 day-match rule. */
  readonly dayOfMonthUnrestricted: boolean;
  readonly dayOfWeekUnrestricted: boolean;
  /** True when hour and minute are each a single fixed value. */
  readonly firesAtMostDaily: boolean;
  readonly source: string;
}

function parseField(raw: string, spec: FieldSpec): { values: Set<number>; unrestricted: boolean; single: boolean } {
  const values = new Set<number>();
  const unrestricted = raw === '*';

  for (const part of raw.split(',')) {
    if (part === '') {
      throw new Error(`Invalid ${spec.name} field "${raw}": empty element`);
    }

    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0 || rangePart === undefined) {
      throw new Error(`Invalid ${spec.name} field "${raw}": malformed step`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new Error(`Invalid ${spec.name} step "${stepPart}"`);
      }
      step = Number(stepPart);
      if (step < 1) {
        throw new Error(`Invalid ${spec.name} step "${stepPart}": must be at least 1`);
      }
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = spec.min;
      to = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...extra] = rangePart.split('-');
      if (extra.length > 0 || a === undefined || b === undefined) {
        throw new Error(`Invalid ${spec.name} range "${rangePart}"`);
      }
      from = toNumber(a, spec);
      to = toNumber(b, spec);
      if (from > to) {
        throw new Error(`Invalid ${spec.name} range "${rangePart}": start is after end`);
      }
    } else {
      from = toNumber(rangePart, spec);
      to = stepPart === undefined ? from : spec.max;
    }

    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) {
    throw new Error(`Invalid ${spec.name} field "${raw}": matches nothing`);
  }

  // A single fixed value, written plainly: "30", not "30-30" or "*/60".
  const single = /^\d+$/.test(raw);
  return { values, unrestricted, single };
}

function toNumber(raw: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${spec.name} value "${raw}"`);
  }
  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `Invalid ${spec.name} value "${raw}": outside ${spec.min}-${spec.max}`,
    );
  }
  return value;
}

export function parseCron(source: string): CronExpression {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${source}": expected 5 fields, got ${fields.length}`,
    );
  }

  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string, string, string, string, string,
  ];

  const minute = parseField(minuteRaw, MINUTE);
  const hour = parseField(hourRaw, HOUR);
  const dom = parseField(domRaw, DAY_OF_MONTH);
  const month = parseField(monthRaw, MONTH);
  const dow = parseField(dowRaw, DAY_OF_WEEK);

  // 7 and 0 both mean Sunday.
  const daysOfWeek = new Set(dow.values);
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek,
    dayOfMonthUnrestricted: dom.unrestricted,
    dayOfWeekUnrestricted: dow.unrestricted,
    firesAtMostDaily: hour.single && minute.single,
    source,
  };
}

/**
 * Vixie-cron day semantics: when day-of-month and day-of-week are both
 * restricted the day matches if EITHER does; when only one is restricted, that
 * one decides. Surprising, but it is what every other cron does, and a
 * scheduler that disagreed with the operator's expectations would be worse.
 */
function dayMatches(cron: CronExpression, date: Date): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) {
    return false;
  }

  const domMatch = cron.daysOfMonth.has(date.getUTCDate());
  const dowMatch = cron.daysOfWeek.has(date.getUTCDay());

  if (cron.dayOfMonthUnrestricted && cron.dayOfWeekUnrestricted) {
    return true;
  }
  if (cron.dayOfMonthUnrestricted) {
    return dowMatch;
  }
  if (cron.dayOfWeekUnrestricted) {
    return domMatch;
  }
  return domMatch || dowMatch;
}

/** True when this exact minute is an occurrence. */
export function matchesCron(cron: CronExpression, at: Date): boolean {
  return (
    dayMatches(cron, at) &&
    cron.hours.has(at.getUTCHours()) &&
    cron.minutes.has(at.getUTCMinutes())
  );
}

/**
 * How far ahead to look before calling an expression unsatisfiable.
 *
 * Nine years, because the largest real gap between two occurrences of a valid
 * expression is eight: 29 February is skipped at a century that is not
 * divisible by 400, so `0 0 29 2 *` jumps straight from 2096 to 2104. A
 * four-year horizon looks generous and is wrong, and the test that walks
 * consecutive occurrences is what found it.
 */
const HORIZON_DAYS = 366 * 9;

/**
 * The first occurrence strictly after `after`.
 *
 * Days that cannot match are skipped whole rather than minute by minute, so the
 * worst case is a few thousand cheap comparisons even for "02:30 on Feb 29".
 * An expression that can never match — 31 February — throws instead of looping.
 */
export function nextCronOccurrence(cron: CronExpression, after: Date): Date {
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const sortedHours = [...cron.hours].sort((a, b) => a - b);
  const sortedMinutes = [...cron.minutes].sort((a, b) => a - b);

  for (let day = 0; day <= HORIZON_DAYS; day += 1) {
    if (dayMatches(cron, cursor)) {
      for (const hour of sortedHours) {
        if (hour < cursor.getUTCHours()) {
          continue;
        }
        const fromMinute = hour === cursor.getUTCHours() ? cursor.getUTCMinutes() : 0;
        for (const minute of sortedMinutes) {
          if (minute < fromMinute) {
            continue;
          }
          const found = new Date(cursor.getTime());
          found.setUTCHours(hour, minute, 0, 0);
          return found;
        }
      }
    }

    // Next day, from midnight.
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  throw new Error(
    `Cron expression "${cron.source}" has no occurrence within ${HORIZON_DAYS} days`,
  );
}

/**
 * The occurrence token that goes into a dedupe key (§7).
 *
 * §7 writes prune's key as `prune:{yyyy-mm-dd}`, which is right for a daily
 * schedule. It is not right for a sub-daily one: an hourly schedule with a
 * date-only key would fire once and then collide with itself for the rest of
 * the day — no error, no dead job, just a schedule that stopped, which is the
 * exact failure §7 exists to prevent. So the token is the date when the cron
 * fires at most once a day, and carries the minute otherwise.
 */
export function occurrenceToken(cron: CronExpression, scheduledFor: Date): string {
  const iso = scheduledFor.toISOString();
  return cron.firesAtMostDaily ? (iso.slice(0, 10) as string) : (iso.slice(0, 16) as string);
}
