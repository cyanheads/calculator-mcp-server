/**
 * @fileoverview Calendar-date functions for expressions — `dateDiff`, `dateAdd`,
 * `weekday`, `isoWeek`, and `daysInMonth` — over dates written as quoted ISO 8601
 * `YYYY-MM-DD` strings. Proleptic Gregorian calendar, years 0000–9999, no time
 * zones, and no clock reads: every result depends only on the arguments.
 * Arithmetic runs on whole day counts (Howard Hinnant's `days_from_civil` /
 * `civil_from_days`), never on `Date`, which maps years 0–99 to 1900–1999 and
 * brings in time zones.
 * @module services/math/date-functions
 */

import { isBigNumber, isFraction, isUnit, type MathJsInstance, typeOf } from 'mathjs';

/** A calendar date: four-digit year, month 1–12, day of month. */
interface CivilDate {
  day: number;
  month: number;
  year: number;
}

type DateUnit = 'days' | 'weeks' | 'months' | 'years';

/** Accepted spellings of each unit, matched case-insensitively. */
const UNITS = new Map<string, DateUnit>([
  ['day', 'days'],
  ['days', 'days'],
  ['week', 'weeks'],
  ['weeks', 'weeks'],
  ['month', 'months'],
  ['months', 'months'],
  ['year', 'years'],
  ['years', 'years'],
]);

const MIN_YEAR = 0;
const MAX_YEAR = 9999;

/** Exactly `YYYY-MM-DD`; only ever run on a 10-character string. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_LENGTH = 10;

/** Longest string argument an error message repeats back. */
const MAX_ECHOED_LENGTH = 32;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A correct call of each date-taking function, quoted in its argument errors. */
const USAGE: Record<string, string> = {
  dateDiff: 'dateDiff("2026-10-17", "2026-10-31")',
  dateAdd: 'dateAdd("2026-10-24", 30)',
  weekday: 'weekday("2026-10-26")',
  isoWeek: 'isoWeek("2026-10-26")',
};

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthLength(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days from 1970-01-01 to `date` (negative before it). */
function daysFromCivil({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The date `days` days after 1970-01-01; the inverse of {@link daysFromCivil}. */
function civilFromDays(days: number): CivilDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** Monday = 0 … Sunday = 6 for a day count (1970-01-01 was a Thursday). */
function weekdayIndex(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}

/** `date` moved by `count` calendar months, its day clamped to the end of the target month. */
function addMonths(date: CivilDate, count: number): CivilDate {
  const total = date.year * 12 + (date.month - 1) + count;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return { year, month, day: Math.min(date.day, monthLength(year, month)) };
}

/** Whole months from `start` to `end`: the largest `m` with `addMonths(start, m) ≤ end`, negated when `end < start`. */
function wholeMonths(start: CivilDate, end: CivilDate): number {
  const endDays = daysFromCivil(end);
  if (endDays < daysFromCivil(start)) return -wholeMonths(end, start);
  const months = end.year * 12 + end.month - (start.year * 12 + start.month);
  return daysFromCivil(addMonths(start, months)) > endDays ? months - 1 : months;
}

function formatDate({ year, month, day }: CivilDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isNumeric(value: unknown): boolean {
  return typeof value === 'number' || isBigNumber(value) || isFraction(value);
}

/** A string argument as an error message repeats it: quoted when short, by length when long. */
function describeString(value: string): string {
  return value.length <= MAX_ECHOED_LENGTH
    ? JSON.stringify(value)
    : `a string of ${value.length} characters`;
}

/** Read a `YYYY-MM-DD` argument; anything else throws an error naming the fix. */
function parseDate(fn: string, value: unknown): CivilDate {
  const usage = USAGE[fn];
  if (typeof value !== 'string') {
    const got = isNumeric(value)
      ? `the number ${String(value)}. An unquoted date such as 2026-10-26 is read as subtraction`
      : `a ${typeOf(value)}`;
    throw new Error(
      `${fn}() takes a date as a quoted YYYY-MM-DD string, e.g. ${usage}; it got ${got}.`,
    );
  }
  const match = value.length === ISO_DATE_LENGTH ? ISO_DATE.exec(value) : null;
  if (!match) {
    throw new Error(
      `${fn}() takes a date as a quoted YYYY-MM-DD string with a four-digit year and a two-digit month and day, e.g. ${usage}; got ${describeString(value)}.`,
    );
  }
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  if (month < 1 || month > 12) {
    throw new Error(`${fn}() got "${value}", which is not a calendar date: months run 01–12.`);
  }
  const length = monthLength(year, month);
  if (day < 1 || day > length) {
    throw new Error(
      `${fn}() got "${value}", which is not a calendar date: ${MONTH_NAMES[month - 1]} ${String(year).padStart(4, '0')} has ${length} days.`,
    );
  }
  return { year, month, day };
}

function outOfRange(fn: string): Error {
  return new Error(
    `${fn}() result falls outside years 0000–9999; dates run from 0000-01-01 to 9999-12-31.`,
  );
}

/**
 * Read a whole-number argument — a number, or a whole BigNumber or Fraction, as the
 * BigNumber and Fraction numeric types deliver literals. The caller range-checks it.
 */
function wholeNumber(fn: string, what: string, value: unknown): number {
  if (isUnit(value)) {
    throw new Error(
      `${fn}() takes ${what} as a plain whole number, not a unit; pass the date unit as a string instead, e.g. dateAdd("2026-10-24", 30, "days").`,
    );
  }
  let whole: number | undefined;
  if (typeof value === 'number' && Number.isInteger(value)) whole = value;
  else if (isBigNumber(value) && value.isInteger()) whole = value.toNumber();
  else if (isFraction(value) && Number(value.d) === 1) whole = Number(value.valueOf());
  if (whole === undefined) {
    const got = isNumeric(value) ? String(value) : `a ${typeOf(value)}`;
    throw new Error(`${fn}() takes ${what} as a whole number; got ${got}.`);
  }
  return whole;
}

function parseUnit(fn: string, value: unknown): DateUnit {
  if (value === undefined) return 'days';
  const unit = typeof value === 'string' ? UNITS.get(value.toLowerCase()) : undefined;
  if (unit) return unit;
  const got =
    typeof value === 'string'
      ? describeString(value)
      : isUnit(value)
        ? `the unit ${String(value)}; write the date unit as a quoted string, e.g. "months"`
        : isNumeric(value)
          ? String(value)
          : `a ${typeOf(value)}`;
  throw new Error(`${fn}() takes the unit "days", "weeks", "months", or "years"; got ${got}.`);
}

function checkRange(fn: string, date: CivilDate): CivilDate {
  if (date.year < MIN_YEAR || date.year > MAX_YEAR) throw outOfRange(fn);
  return date;
}

/** `dateDiff(start, end, unit?)`: whole units from start to end, negative when end is earlier. */
function dateDiff(startArg: unknown, endArg: unknown, unitArg?: unknown): number {
  const start = parseDate('dateDiff', startArg);
  const end = parseDate('dateDiff', endArg);
  const unit = parseUnit('dateDiff', unitArg);
  switch (unit) {
    case 'days':
      return daysFromCivil(end) - daysFromCivil(start);
    case 'weeks':
      return Math.trunc((daysFromCivil(end) - daysFromCivil(start)) / 7);
    case 'months':
      return wholeMonths(start, end);
    case 'years':
      return Math.trunc(wholeMonths(start, end) / 12);
  }
}

/** `dateAdd(date, count, unit?)`: the date `count` units later; month and year steps clamp to the month's end. */
function dateAdd(dateArg: unknown, countArg: unknown, unitArg?: unknown): string {
  const date = parseDate('dateAdd', dateArg);
  const count = wholeNumber('dateAdd', 'the count', countArg);
  const unit = parseUnit('dateAdd', unitArg);
  // A count too large to step by exactly can only land outside the date range.
  if (!Number.isSafeInteger(count)) throw outOfRange('dateAdd');
  switch (unit) {
    case 'days':
      return formatDate(checkRange('dateAdd', civilFromDays(daysFromCivil(date) + count)));
    case 'weeks':
      return formatDate(checkRange('dateAdd', civilFromDays(daysFromCivil(date) + 7 * count)));
    case 'months':
      return formatDate(checkRange('dateAdd', addMonths(date, count)));
    case 'years':
      return formatDate(checkRange('dateAdd', addMonths(date, 12 * count)));
  }
}

/** `weekday(date)`: the English day name, `"Monday"` … `"Sunday"`. */
function weekday(dateArg: unknown): string {
  return WEEKDAYS[weekdayIndex(daysFromCivil(parseDate('weekday', dateArg)))] as string;
}

/** `isoWeek(date)`: the ISO 8601 week number, 1–53, of the week-year the date's Thursday falls in. */
function isoWeek(dateArg: unknown): number {
  const days = daysFromCivil(parseDate('isoWeek', dateArg));
  const thursday = days - weekdayIndex(days) + 3;
  const { year } = civilFromDays(thursday);
  return Math.floor((thursday - daysFromCivil({ year, month: 1, day: 1 })) / 7) + 1;
}

/** `daysInMonth(year, month)`: 28–31. */
function daysInMonth(yearArg: unknown, monthArg: unknown): number {
  const year = wholeNumber('daysInMonth', 'the year', yearArg);
  const month = wholeNumber('daysInMonth', 'the month', monthArg);
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new Error(`daysInMonth() takes a year from 0 to 9999; got ${year}.`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`daysInMonth() takes a month from 1 to 12; got ${month}.`);
  }
  return monthLength(year, month);
}

/**
 * The date functions as typed functions of one math.js instance, ready to import.
 * One `any` signature per arity, so math.js reports a wrong argument count itself
 * and passes a callback only the arguments it takes (`map(dates, weekday)` hands
 * `weekday` the element alone). The functions check their own argument types,
 * since typed dispatch has no number-to-string conversion to reject a number with.
 * Numeric results are plain integers in every numeric type, as `count` returns.
 */
export function createDateFunctions(typed: MathJsInstance['typed']): Record<string, unknown> {
  return {
    dateDiff: typed('dateDiff', { 'any, any': dateDiff, 'any, any, any': dateDiff }),
    dateAdd: typed('dateAdd', { 'any, any': dateAdd, 'any, any, any': dateAdd }),
    weekday: typed('weekday', { any: weekday }),
    isoWeek: typed('isoWeek', { any: isoWeek }),
    daysInMonth: typed('daysInMonth', { 'any, any': daysInMonth }),
  };
}
