import { describe, expect, it } from 'vitest';

import {
  matchesCron,
  nextCronOccurrence,
  occurrenceToken,
  parseCron,
} from '../../src/worker/cron';

const at = (iso: string) => new Date(iso);
const next = (cron: string, from: string) =>
  nextCronOccurrence(parseCron(cron), at(from)).toISOString();

describe('cron parsing', () => {
  it('rejects anything that is not five fields', () => {
    expect(() => parseCron('* * * *')).toThrowError(/expected 5 fields/);
    expect(() => parseCron('* * * * * *')).toThrowError(/expected 5 fields/);
    expect(() => parseCron('')).toThrowError(/expected 5 fields/);
  });

  it('rejects out-of-range and malformed values', () => {
    expect(() => parseCron('60 * * * *')).toThrowError(/minute/);
    expect(() => parseCron('* 24 * * *')).toThrowError(/hour/);
    expect(() => parseCron('* * 0 * *')).toThrowError(/day-of-month/);
    expect(() => parseCron('* * * 13 *')).toThrowError(/month/);
    expect(() => parseCron('* * * * 8')).toThrowError(/day-of-week/);
    expect(() => parseCron('x * * * *')).toThrowError(/minute/);
    expect(() => parseCron('*/0 * * * *')).toThrowError(/step/);
    expect(() => parseCron('30-10 * * * *')).toThrowError(/start is after end/);
    expect(() => parseCron('1,,2 * * * *')).toThrowError(/empty element/);
  });

  it('treats 0 and 7 as Sunday', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek.has(0)).toBe(true);
    expect(parseCron('0 0 * * 0').daysOfWeek.has(0)).toBe(true);
  });

  it('expands steps, ranges and lists', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toStrictEqual([0, 15, 30, 45]);
    expect([...parseCron('0-4 * * * *').minutes]).toStrictEqual([0, 1, 2, 3, 4]);
    expect([...parseCron('1,5,9 * * * *').minutes]).toStrictEqual([1, 5, 9]);
    expect([...parseCron('0-10/5 * * * *').minutes]).toStrictEqual([0, 5, 10]);
    expect([...parseCron('5/10 * * * *').minutes]).toStrictEqual([5, 15, 25, 35, 45, 55]);
  });
});

describe('next occurrence', () => {
  it('is strictly after the instant given, never equal to it', () => {
    expect(next('* * * * *', '2026-10-07T10:00:00.000Z')).toBe('2026-10-07T10:01:00.000Z');
    // Seconds within the minute are discarded, not rounded up past it.
    expect(next('* * * * *', '2026-10-07T10:00:30.000Z')).toBe('2026-10-07T10:01:00.000Z');
  });

  it('finds the next daily occurrence, rolling over midnight', () => {
    expect(next('30 2 * * *', '2026-10-07T00:00:00.000Z')).toBe('2026-10-07T02:30:00.000Z');
    expect(next('30 2 * * *', '2026-10-07T02:30:00.000Z')).toBe('2026-10-08T02:30:00.000Z');
    expect(next('30 2 * * *', '2026-10-07T23:59:00.000Z')).toBe('2026-10-08T02:30:00.000Z');
  });

  it('handles hourly and sub-hourly schedules', () => {
    expect(next('0 * * * *', '2026-10-07T10:30:00.000Z')).toBe('2026-10-07T11:00:00.000Z');
    expect(next('*/15 * * * *', '2026-10-07T10:07:00.000Z')).toBe('2026-10-07T10:15:00.000Z');
    expect(next('*/15 * * * *', '2026-10-07T10:46:00.000Z')).toBe('2026-10-07T11:00:00.000Z');
  });

  it('rolls over months and years', () => {
    expect(next('0 0 1 * *', '2026-10-15T00:00:00.000Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(next('0 0 1 1 *', '2026-10-15T00:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(next('30 2 * * *', '2026-12-31T23:00:00.000Z')).toBe('2027-01-01T02:30:00.000Z');
  });

  it('finds 29 February only in a leap year', () => {
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('matches by weekday', () => {
    // 2026-10-07 is a Wednesday; the next Sunday is the 11th.
    expect(next('0 3 * * 0', '2026-10-07T00:00:00.000Z')).toBe('2026-10-11T03:00:00.000Z');
    expect(next('0 3 * * 3', '2026-10-07T00:00:00.000Z')).toBe('2026-10-07T03:00:00.000Z');
  });

  it('ORs day-of-month against day-of-week when both are restricted, as cron does', () => {
    // The 1st OR any Monday. 2026-10-07 is a Wednesday, so the 12th is the
    // next Monday and comes before the 1st of November.
    expect(next('0 0 1 * 1', '2026-10-07T00:00:00.000Z')).toBe('2026-10-12T00:00:00.000Z');
    // With only day-of-month restricted, weekday is ignored.
    expect(next('0 0 1 * *', '2026-10-07T00:00:00.000Z')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('throws rather than looping on an expression that can never match', () => {
    expect(() => next('0 0 30 2 *', '2026-01-01T00:00:00.000Z')).toThrowError(
      /no occurrence/,
    );
  });

  it('agrees with matchesCron on everything it returns', () => {
    for (const expression of [
      '* * * * *', '*/7 * * * *', '30 2 * * *', '0 0 1 * *',
      '0 3 * * 0', '15 */4 * * 1-5', '0 0 29 2 *',
    ]) {
      const cron = parseCron(expression);
      let cursor = at('2026-10-07T10:00:00.000Z');
      for (let i = 0; i < 25; i += 1) {
        cursor = nextCronOccurrence(cron, cursor);
        expect(matchesCron(cron, cursor), `${expression} at ${cursor.toISOString()}`).toBe(
          true,
        );
      }
    }
  });

  it('never skips an occurrence: stepping minute by minute finds the same ones', () => {
    const cron = parseCron('15 */4 * * 1-5');
    const start = at('2026-10-07T00:00:00.000Z');
    const end = at('2026-10-21T00:00:00.000Z');

    const byMinute: string[] = [];
    for (let t = start.getTime() + 60_000; t <= end.getTime(); t += 60_000) {
      const candidate = new Date(t);
      if (matchesCron(cron, candidate)) {
        byMinute.push(candidate.toISOString());
      }
    }

    const byNext: string[] = [];
    let cursor = start;
    for (;;) {
      cursor = nextCronOccurrence(cron, cursor);
      if (cursor.getTime() > end.getTime()) break;
      byNext.push(cursor.toISOString());
    }

    expect(byNext).toStrictEqual(byMinute);
    expect(byNext.length).toBeGreaterThan(50);
  });
});

describe('occurrence tokens (SPEC.md §7)', () => {
  it('uses the date for a schedule that fires at most once a day', () => {
    const cron = parseCron('30 2 * * *');
    expect(cron.firesAtMostDaily).toBe(true);
    expect(occurrenceToken(cron, at('2026-10-07T02:30:00.000Z'))).toBe('2026-10-07');
  });

  it('keeps §7’s literal prune key shape', () => {
    // §7 writes it as prune:{yyyy-mm-dd}, and a daily prune must stay that.
    expect(occurrenceToken(parseCron('30 2 * * *'), at('2026-10-07T02:30:00.000Z'))).toBe(
      '2026-10-07',
    );
  });

  it('carries the minute for a sub-daily schedule, so occurrences stay distinct', () => {
    const hourly = parseCron('0 * * * *');
    expect(hourly.firesAtMostDaily).toBe(false);
    const first = occurrenceToken(hourly, at('2026-10-07T01:00:00.000Z'));
    const second = occurrenceToken(hourly, at('2026-10-07T02:00:00.000Z'));
    expect(first).toBe('2026-10-07T01:00');
    expect(second).toBe('2026-10-07T02:00');
    // A date-only token here would collide and the schedule would silently
    // stop after its first fire of the day — the §7 failure mode.
    expect(first).not.toBe(second);
  });
});

describe('the horizon covers the largest real gap', () => {
  it('finds 29 February across 2100, which is not a leap year', () => {
    // 2096 -> 2104 is an eight-year gap. A four-year horizon rejected this.
    expect(next('0 0 29 2 *', '2096-03-01T00:00:00.000Z')).toBe(
      '2104-02-29T00:00:00.000Z',
    );
  });

  it('walks a century of leap days without losing one', () => {
    const cron = parseCron('0 0 29 2 *');
    let cursor = at('2026-01-01T00:00:00.000Z');
    const years: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      cursor = nextCronOccurrence(cron, cursor);
      years.push(cursor.getUTCFullYear());
    }
    expect(years).toContain(2096);
    expect(years).toContain(2104);
    expect(years).not.toContain(2100);
  });
});
