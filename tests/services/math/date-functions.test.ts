/**
 * @fileoverview Tests for the calendar-date functions (`dateDiff`, `dateAdd`,
 * `weekday`, `isoWeek`, `daysInMonth`) and the clock-call check, run through
 * MathService so the parse-time checks apply.
 * @module tests/services/math/date-functions.test
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { MathService } from '@/services/math/math-service.js';
import type { NumericType } from '@/services/math/types.js';

const CONFIG = { maxExpressionLength: 1000, evaluationTimeoutMs: 5000, maxResultLength: 100_000 };
const service = new MathService(CONFIG);

/** The result string and type of an evaluation. */
function evaluate(
  expression: string,
  numericType: NumericType = 'number',
  scope?: Record<string, number>,
) {
  const { result, resultType } = service.evaluateExpression(
    expression,
    scope,
    undefined,
    numericType,
  );
  return { result, resultType };
}

/** The McpError an evaluation throws. */
function failure(expression: string, numericType: NumericType = 'number'): McpError {
  try {
    service.evaluateExpression(expression, undefined, undefined, numericType);
  } catch (err) {
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }
  throw new Error(`Expected ${expression} to fail`);
}

describe('date functions', () => {
  it.each([
    ['dateDiff("2026-10-17", "2026-10-31")', '14', 'number'],
    ['dateDiff("2026-01-31", "2026-02-28", "months")', '1', 'number'],
    ['dateDiff("1990-05-17", "2026-05-16", "years")', '35', 'number'],
    ['dateAdd("2026-10-24", 30)', '"2026-11-23"', 'string'],
    ['dateAdd("2026-01-31", 1, "months")', '"2026-02-28"', 'string'],
    ['weekday("2026-10-26")', '"Monday"', 'string'],
    ['isoWeek("2027-01-01")', '53', 'number'],
    ['daysInMonth(2024, 2)', '29', 'number'],
  ])('%s => %s', (expression, result, resultType) => {
    expect(evaluate(expression)).toEqual({ result, resultType });
  });

  describe('dateDiff counts whole units', () => {
    it.each([
      ['dateDiff("2026-02-28", "2026-01-31", "months")', '-1'],
      ['dateDiff("2026-01-15", "2026-03-14", "months")', '1'],
      ['dateDiff("2026-01-15", "2026-03-15", "months")', '2'],
      ['dateDiff("2026-10-17", "2026-10-31", "months")', '0'],
      ['dateDiff("2026-10-17", "2026-10-27", "weeks")', '1'],
      ['dateDiff("2026-10-31", "2026-10-17", "weeks")', '-2'],
      ['dateDiff("2024-02-29", "2025-02-28", "years")', '1'],
      ['dateDiff("2024-02-29", "2025-02-27", "years")', '0'],
      ['dateDiff("1990-05-17", "2026-05-17", "years")', '36'],
      ['dateDiff("2026-10-31", "2026-10-17")', '-14'],
      ['dateDiff("0000-01-01", "9999-12-31")', '3652424'],
    ])('%s => %s', (expression, result) => {
      expect(evaluate(expression).result).toBe(result);
    });

    /**
     * An earlier end counts as −dateDiff(end, start, unit) (#51): whole units from the
     * end forward, negated, so a partial unit truncates toward zero in both directions.
     */
    it.each([
      // dateAdd("2023-01-31", 1, "months") is 2023-02-28 ≤ 2023-03-30; 2 months is 2023-03-31, past it.
      ['dateDiff("2023-03-30", "2023-01-31", "months")', '-1'],
      // 11 days back.
      ['dateDiff("2026-10-31", "2026-10-20", "weeks")', '-1'],
      // 431 whole months from 1990-05-18 to 2026-05-17.
      ['dateDiff("2026-05-17", "1990-05-18", "years")', '-35'],
    ])('%s => %s, the negated forward count', (expression, result) => {
      expect(evaluate(expression).result).toBe(result);
    });

    it('inverts dateAdd: dateDiff(a, dateAdd(a, m, "months"), "months") = m for every day of 2023–2025, m in −25…25', () => {
      const expected = `[${Array.from({ length: 51 }, (_, k) => k - 25).join(', ')}]`;
      const first = Date.UTC(2023, 0, 1);
      let days = 0;
      for (let t = first; t < Date.UTC(2026, 0, 1); t += 86_400_000) {
        const a = new Date(t).toISOString().slice(0, 10);
        const expression = `map(-25:25, f(m) = dateDiff("${a}", dateAdd("${a}", m, "months"), "months"))`;
        expect(evaluate(expression).result, a).toBe(expected);
        days++;
      }
      expect(days).toBe(1096);
    });
  });

  describe('dateAdd clamps month and year steps to the end of the month', () => {
    it.each([
      ['dateAdd("2024-02-29", 1, "years")', '"2025-02-28"'],
      ['dateAdd("2024-02-29", 4, "years")', '"2028-02-29"'],
      ['dateAdd("2026-03-31", -1, "months")', '"2026-02-28"'],
      ['dateAdd("2024-01-31", 1, "months")', '"2024-02-29"'],
      ['dateAdd("2026-10-24", 2, "weeks")', '"2026-11-07"'],
      ['dateAdd("2026-12-31", 1)', '"2027-01-01"'],
      ['dateAdd("9999-12-30", 1)', '"9999-12-31"'],
      ['dateAdd("0000-01-02", -1)', '"0000-01-01"'],
    ])('%s => %s', (expression, result) => {
      expect(evaluate(expression)).toEqual({ result, resultType: 'string' });
    });

    it.each([
      'dateAdd("2026-10-24", 1, "Months")',
      'dateAdd("2026-10-24", 1, "month")',
      'dateAdd("2026-10-24", 1, "MONTHS")',
    ])('reads the unit in any case, singular or plural: %s', (expression) => {
      expect(evaluate(expression).result).toBe('"2026-11-24"');
    });
  });

  describe('isoWeek and weekday', () => {
    it.each([
      ['isoWeek("2026-10-26")', '44'],
      ['isoWeek("2024-12-30")', '1'],
      ['isoWeek("2026-12-31")', '53'],
      ['isoWeek("2027-01-04")', '1'],
      ['isoWeek("2021-01-03")', '53'],
      ['weekday("0001-01-01")', '"Monday"'],
      ['weekday("1582-10-15")', '"Friday"'],
      ['weekday("1970-01-01")', '"Thursday"'],
    ])('%s => %s', (expression, result) => {
      expect(evaluate(expression).result).toBe(result);
    });

    it('applies as a map callback', () => {
      expect(evaluate('map(["2026-10-26", "2026-10-27"], weekday)')).toEqual({
        result: '["Monday", "Tuesday"]',
        resultType: 'DenseMatrix',
      });
    });
  });

  /**
   * Rows computed with Python's `datetime` (proleptic Gregorian, years 1–9999):
   * `[start, end, end − start in days, weekday(start), ISO week(start)]` — calendar
   * edges (1582, century years, leap days, ISO week-year boundaries) plus random pairs.
   */
  describe("agrees with Python's datetime", () => {
    const rows = z
      .array(z.tuple([z.string(), z.string(), z.number(), z.string(), z.number()]))
      .parse(
        JSON.parse(readFileSync(new URL('./fixtures/python-dates.json', import.meta.url), 'utf8')),
      );

    it(`on ${rows.length} date pairs`, () => {
      expect(rows.length).toBeGreaterThan(900);
      for (const [start, end, days, day, week] of rows) {
        const expression = `[dateDiff("${start}", "${end}"), weekday("${start}"), isoWeek("${start}")]`;
        expect(evaluate(expression).result, expression).toBe(`[${days}, "${day}", ${week}]`);
      }
    });
  });

  describe('numeric types', () => {
    it.each(['BigNumber', 'Fraction'] as const)(
      'accepts whole %s counts and returns plain integers',
      (numericType) => {
        expect(evaluate('dateAdd("2026-10-24", 30)', numericType)).toEqual({
          result: '"2026-11-23"',
          resultType: 'string',
        });
        expect(evaluate('dateDiff("2026-10-17", "2026-10-31")', numericType)).toEqual({
          result: '14',
          resultType: 'number',
        });
        expect(evaluate('daysInMonth(2024, 2)', numericType)).toEqual({
          result: '29',
          resultType: 'number',
        });
        expect(evaluate('isoWeek("2026-10-26")', numericType).result).toBe('44');
      },
    );

    it('composes with BigNumber and Fraction arithmetic', () => {
      expect(evaluate('dateDiff("2026-10-17", "2026-10-31") + 1', 'BigNumber')).toEqual({
        result: '15',
        resultType: 'BigNumber',
      });
      expect(evaluate('dateDiff("2026-10-17", "2026-10-31") / 7', 'Fraction')).toEqual({
        result: '2/1',
        resultType: 'Fraction',
      });
    });

    it.each(['BigNumber', 'Fraction'] as const)('rejects a fractional %s count', (numericType) => {
      const err = failure('dateAdd("2026-10-24", 1/2)', numericType);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain('dateAdd() takes the count as a whole number; got 0.5');
    });

    it('rejects a BigNumber count that is not whole past 64-bit float precision', () => {
      const err = failure('dateAdd("2026-10-24", bignumber("1.0000000000000000001"))');
      expect(err.message).toContain('takes the count as a whole number');
    });
  });

  describe('argument errors name the fix', () => {
    it.each([
      ['isoWeek(2026-10-26)', 'it got the number 1990. An unquoted date such as 2026-10-26'],
      ['dateDiff(2026-10-17, "2026-10-31")', 'it got the number 1999'],
      [
        'dateAdd("2026-02-30", 1)',
        '"2026-02-30", which is not a calendar date: February 2026 has 28 days',
      ],
      ['dateDiff("2026-13-01", "2026-01-01")', 'months run 01–12'],
      ['dateAdd("2026-2-3", 1)', 'four-digit year and a two-digit month and day'],
      ['weekday("10/26/2026")', 'got "10/26/2026"'],
      ['dateAdd("2026-10-24T00:00:00Z", 1)', 'got "2026-10-24T00:00:00Z"'],
      ['dateAdd("2026-10-24", 1.5)', 'takes the count as a whole number; got 1.5'],
      [
        'dateAdd("2026-10-24", 1, "fortnights")',
        '"days", "weeks", "months", or "years"; got "fortnights"',
      ],
      ['dateAdd("2026-10-24", 1, "constructor")', 'got "constructor"'],
      ['dateAdd("2026-01-31", 1, months)', 'write the date unit as a quoted string'],
      ['dateAdd("2026-10-24", 30 days)', 'not a unit; pass the date unit as a string'],
      ['dateAdd("9999-12-31", 1)', 'falls outside years 0000–9999'],
      ['dateAdd("0000-01-01", -1)', 'falls outside years 0000–9999'],
      ['dateAdd("0000-01-15", -1, "months")', 'falls outside years 0000–9999'],
      ['dateAdd("0000-06-15", -1, "years")', 'falls outside years 0000–9999'],
      ['dateAdd("2026-10-24", 1e30)', 'falls outside years 0000–9999'],
      ['dateAdd("2026-10-24", bignumber("1e400"))', 'falls outside years 0000–9999'],
      ['dateAdd("2026-10-24", 1e30, "years")', 'falls outside years 0000–9999'],
      ['dateAdd("2026-10-24", Infinity)', 'takes the count as a whole number; got Infinity'],
      ['daysInMonth(2026, 13)', 'takes a month from 1 to 12; got 13'],
      ['daysInMonth(2026, 1e30)', 'takes a month from 1 to 12; got 1e+30'],
      ['daysInMonth(10000, 1)', 'takes a year from 0 to 9999; got 10000'],
      ['daysInMonth(2026, 2.5)', 'takes the month as a whole number; got 2.5'],
      ['weekday(true)', 'it got a boolean'],
      ['weekday("2026-10-26", 1)', 'Too many arguments in function weekday'],
      ['dateAdd("2026-10-24")', 'Too few arguments in function dateAdd'],
    ])('%s fails with evaluation_failed', (expression, detail) => {
      const err = failure(expression);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain(detail);
    });

    it('describes a long date argument by its length rather than repeating it', () => {
      const err = failure(`weekday(concat("2026-10-26", "${'x'.repeat(40)}"))`);
      expect(err.message).toContain('got a string of 50 characters');
      expect(err.message).not.toContain('xxxxxxxxxx');
    });
  });

  describe('clock calls', () => {
    it.each([
      ['now()', 'now'],
      ['today()', 'today'],
      ['dateDiff(today(), "2026-12-25")', 'today'],
    ])('rejects %s at parse time under evaluate', (expression, name) => {
      const err = failure(expression);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('parse_failed');
      expect(err.message).toBe(`${name}() is not available: the calculator reads no clock.`);
      expect(err.data?.recovery).toEqual({
        hint: `Pass the current date as a quoted YYYY-MM-DD string where ${name}() would go, e.g. dateDiff("2026-10-17", "2026-12-25").`,
      });
    });

    it('rejects a clock call in every numeric type', () => {
      for (const numericType of ['BigNumber', 'Fraction'] as const) {
        const err = failure('now()', numericType);
        expect(err.data?.reason).toBe('parse_failed');
        expect(err.message).toContain('the calculator reads no clock');
      }
    });

    it('leaves now and today symbolic under simplify and derivative', () => {
      expect(service.simplifyExpression('now(t) + now(t)')).toEqual({
        result: '2 * now(t)',
        resultType: 'string',
        unchanged: false,
      });
      expect(service.differentiateExpression('today(t) * x', 'x').result).toBe('today(t)');
    });
  });

  it('keeps a scope value named like a date function', () => {
    expect(evaluate('weekday + 1', 'number', { weekday: 3 })).toEqual({
      result: '4',
      resultType: 'number',
    });
  });

  it('keeps no state across calls', () => {
    const probe = 'dateAdd("2024-01-31", 1, "months")';
    expect(new MathService(CONFIG).evaluateExpression(probe).result).toBe('"2024-02-29"');
    const primed = new MathService(CONFIG);
    for (const expression of [
      'dateAdd("2026-01-31", 13, "months")',
      'dateDiff("1990-05-17", "2026-05-16", "years")',
      'weekday("0001-01-01")',
    ]) {
      primed.evaluateExpression(expression);
    }
    expect(() => primed.evaluateExpression('dateAdd("2026-02-30", 1)')).toThrow(McpError);
    expect(primed.evaluateExpression(probe).result).toBe('"2024-02-29"');
    expect(primed.evaluateExpression(probe, undefined, undefined, 'Fraction').result).toBe(
      '"2024-02-29"',
    );
  });
});
