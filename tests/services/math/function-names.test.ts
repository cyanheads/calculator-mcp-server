/**
 * @fileoverview Tests for function-names.ts — synonym calls renamed to their
 * canonical function on the parse tree (#42, #48), synonym value bindings,
 * `eigenvalues`, and the solver route a `roots` / `solve` call gets (#48).
 * @module tests/services/math/function-names
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { callsRoutedFunction, canonicalName } from '@/services/math/function-names.js';
import { initMathService, MathService } from '@/services/math/math-service.js';
import type { NumericType } from '@/services/math/types.js';

const service = new MathService({
  maxExpressionLength: 4000,
  evaluationTimeoutMs: 5000,
  maxResultLength: 100_000,
});

beforeAll(() => {
  initMathService({
    maxExpressionLength: 4000,
    evaluationTimeoutMs: 5000,
    maxResultLength: 100_000,
  });
});

type Options = {
  numericType?: NumericType;
  operation?: 'evaluate' | 'simplify' | 'derivative';
  scope?: Record<string, number>;
};

/** The result string, or the thrown McpError. */
function outcome(expression: string, options: Options = {}): string | McpError {
  try {
    switch (options.operation ?? 'evaluate') {
      case 'simplify':
        return service.simplifyExpression(expression).result;
      case 'derivative':
        return service.differentiateExpression(expression, 'x').result;
      default:
        return service.evaluateExpression(expression, options.scope, undefined, options.numericType)
          .result;
    }
  } catch (err) {
    if (err instanceof McpError) return err;
    throw err;
  }
}

function result(expression: string, options: Options = {}): string {
  const value = outcome(expression, options);
  if (value instanceof McpError) throw new Error(`${expression} failed: ${value.message}`);
  return value;
}

function failure(expression: string, options: Options = {}): McpError {
  const value = outcome(expression, options);
  if (!(value instanceof McpError)) throw new Error(`${expression} returned ${value}`);
  return value;
}

describe('canonicalName', () => {
  it.each([
    ['avg', 'mean'],
    ['average', 'mean'],
    ['stdev', 'std'],
    ['stddev', 'std'],
    ['permute', 'permutations'],
    ['nPr', 'permutations'],
    ['choose', 'combinations'],
    ['nCr', 'combinations'],
    ['length', 'count'],
    ['len', 'count'],
    ['ln', 'log'],
    ['arcsin', 'asin'],
    ['arccoth', 'acoth'],
    ['eig', 'eigs'],
    ['integral', 'integrate'],
  ])('%s → %s', (alias, canonical) => {
    expect(canonicalName(alias)).toBe(canonical);
  });

  it.each(['mean', 'roots', 'arc', 'Avg', 'toString', '__proto__'])('%s has none', (name) => {
    expect(canonicalName(name)).toBeUndefined();
  });
});

describe('synonym calls run the canonical function (#42)', () => {
  it.each([
    ['avg([1,2;3,4], 1)', '[2, 3]'],
    ['average([1,2;3,4], 1)', '[2, 3]'],
    ['avg([1,2;3,4], 2)', '[1.5, 3.5]'],
    ['stdev([1,2;3,4], 1)', '[1.4142135623730951, 1.4142135623730951]'],
    ['stddev([1,2;3,4], 1)', '[1.4142135623730951, 1.4142135623730951]'],
    ['stddev([1,2;3,4], 2)', '[0.7071067811865476, 0.7071067811865476]'],
    ['nCr(5, 2)', '10'],
    ['nPr(5, 2)', '20'],
    ['len([1,2;3,4])', '4'],
    ['ln(e)', '1'],
  ])('%s → %s', (expression, expected) => {
    expect(result(expression)).toBe(expected);
  });

  it.each(['avg([1,2;3,4], 1)', 'stdev([1,2;3,4], 2)', 'nCr(5, 2)', 'nPr(5, 2)', 'len([1,2;3,4])'])(
    '%s under BigNumber equals the canonical call',
    (expression) => {
      const canonical = expression
        .replace(/^avg/, 'mean')
        .replace(/^stdev/, 'std')
        .replace(/^nCr/, 'combinations')
        .replace(/^nPr/, 'permutations')
        .replace(/^len/, 'count');
      expect(result(expression, { numericType: 'BigNumber' })).toBe(
        result(canonical, { numericType: 'BigNumber' }),
      );
    },
  );

  it.each([
    ['avg([1,2;3,4], 1)', '[2/1, 3/1]'],
    ['average([1,2;3,4], 2)', '[3/2, 7/2]'],
    ['nCr(10, 3)', '120/1'],
    ['choose(10, 3)', '120/1'],
    ['permute(10, 3)', '720/1'],
    ['nPr(10, 3)', '720/1'],
    ['nPr(10)', '3628800/1'],
    ['stdev([1, 2, 3])', '1/1'],
    ['stddev([1, 2, 3])', '1/1'],
  ])('Fraction %s → %s', (expression, expected) => {
    expect(result(expression, { numericType: 'Fraction' })).toBe(expected);
  });

  it.each([
    ['avg([1,2;3,4], 0)', 'Index out of range (0 < 1)'],
    ['avg([1,2;3,4], 5)', 'Index out of range (5 > 2)'],
  ])('%s fails one-based like mean', (expression, detail) => {
    const err = failure(expression);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.message).toContain(detail);
  });

  it('folds and prints the canonical name under simplify', () => {
    expect(result('avg([1,2;3,4], 1)', { operation: 'simplify' })).toBe('[2, 3]');
    expect(service.simplifyExpression('avg(x, y)')).toMatchObject({
      result: 'mean(x, y)',
      unchanged: true,
    });
  });

  it('renames inside an inline callback, past the first level', () => {
    expect(result('map([1,2], f(v) = avg([v, 3; 4, 5], 1))')).toBe('[[2.5, 4], [3, 4]]');
    expect(result('map([1,2], f(v) = map([v], g(w) = nCr(w + 3, 2)))')).toBe('[[6], [10]]');
  });

  it('binds the statistics synonyms as values, with the canonical transform', () => {
    expect(result('mapSlices([1,2;3,4], 1, avg)')).toBe('[2, 3]');
    expect(result('typeOf(avg)')).toBe('"function"');
    expect(result('mapSlices([1,2;3,4], 1, stdev)')).toBe(result('mapSlices([1,2;3,4], 1, std)'));
    // Called through a value, not by name, so only the binding is in play.
    expect(result('{f: avg}.f([1,2;3,4], 1)')).toBe('[2, 3]');
    expect(result('{f: stdev}.f([1,2;3,4], 1)')).toBe('[1.4142135623730951, 1.4142135623730951]');
    expect(result('{f: nCr}.f(10, 3)', { numericType: 'Fraction' })).toBe('120/1');
  });

  it('lets a scope value shadow the value form while a call is renamed', () => {
    expect(result('avg + 1', { scope: { avg: 4 } })).toBe('5');
    expect(result('avg(2, 4)', { scope: { avg: 4 } })).toBe('3');
  });

  it('keeps ln and arc* call-only and leaves string literals alone', () => {
    expect(failure('typeOf(ln)').data?.reason).toBe('parse_failed');
    expect(result('"avg(1)"')).toBe('"avg(1)"');
  });

  it('runs integral as integrate, call-only', () => {
    expect(result('integral(sin(x), x, 0, pi)')).toBe('2');
    expect(failure('typeOf(integral)').message).toContain('Undefined symbol integral');
  });
});

describe('a function the expression defines under a synonym or solver name is its own', () => {
  it.each([
    ['{f: avg(v) = v * 10, r: avg(3)}.r', '30'],
    ['{f: stdev(v) = v, r: stdev(4)}.r', '4'],
    ['{f: nCr(a, b) = a + b, r: nCr(5, 2)}.r', '7'],
    ['{f: eig(m) = 7, r: eig([1])}.r', '7'],
    ['{f: integral(v) = v + 1, r: integral(2)}.r', '3'],
    ['{f: ln(v) = v + 1, r: ln(2)}.r', '3'],
    ['{f: arcsin(v) = v + 1, r: arcsin(2)}.r', '3'],
    ['{f: solve(v) = v + 1, r: solve(2)}.r', '3'],
    ['{f: roots(v) = v + 1, r: roots(2)}.r', '3'],
  ])('%s → %s', (expression, expected) => {
    expect(result(expression)).toBe(expected);
  });

  it('calls a recursive definition, and one a body defined earlier calls by name', () => {
    expect(result('map([5], nCr(n) = n <= 1 ? 1 : n * nCr(n - 1))')).toBe('[120]');
    expect(result('map([5], len(n) = n <= 1 ? 1 : n * len(n - 1))')).toBe('[120]');
    expect(result('{g: g(x) = avg(x), f: avg(v) = v * 10, r: g(3)}.r')).toBe('30');
  });

  it('keeps a definition nested in callbacks, past the first level', () => {
    expect(result('map([1, 2], f(v) = map([v], g(w) = {h: avg(u) = u * 10, r: avg(w)}.r))')).toBe(
      '[[10], [20]]',
    );
  });

  it('still renames and routes beside a definition of another name', () => {
    expect(result('{f: f(v) = v, r: avg([1,2;3,4], 1)}.r')).toBe('[2, 3]');
    expect(failure('{f: f(v) = v, r: roots(3)}.r').message).toMatch(
      /^Invalid expression: Undefined function roots\. For a polynomial/,
    );
  });

  it('keeps a parameter named like a synonym or solver name bound to its argument', () => {
    expect(result('{f: f(nCr) = nCr(5, 2), r: f(permutations)}.r')).toBe('20');
    expect(result('{f: f(avg) = avg([1, 5]), r: f(max)}.r')).toBe('5');
    expect(result('{h: h(len) = len(3), r: h(sqrt)}.r')).toBe('1.7320508075688772');
    expect(result('{f: f(ln) = ln(4), r: f(sqrt)}.r')).toBe('2');
    expect(result('{f: f(eig) = eig(4), r: f(sqrt)}.r')).toBe('2');
    expect(result('{f: f(roots) = roots(4), r: f(sqrt)}.r')).toBe('2');
    // Outside the body that binds it, the name is the synonym again.
    expect(result('{f: f(ln) = ln(4), r: f(sqrt) + ln(e)}.r')).toBe('3');
  });

  it('renames and routes the names it does not define beside one it does', () => {
    expect(result('{f: avg(v) = v * 10, r: avg(3) + nCr(5, 2)}.r')).toBe('40');
    expect(failure('{f: solve(v) = v + 1, r: solve(2) + roots(3)}.r').message).toMatch(
      /^Invalid expression: Undefined function roots\. For a polynomial/,
    );
  });
});

describe('eigenvalue names (#48)', () => {
  it('renames eig to eigs', () => {
    expect(result('eig([2,1;1,2]).values')).toBe('[1, 3]');
    expect(failure('eig([2,0;0,3])', { operation: 'simplify' }).data?.reason).toBe(
      'evaluation_failed',
    );
  });

  it.each([
    ['eigenvalues([2,1;1,2])', '[1, 3]'],
    ['eigenvalues([1,2;3,4])', '[-0.37228132326901653, 5.372281323269014]'],
    ['eigenvalues([0,1;-1,0])', '[i, -i]'],
  ])('%s → %s', (expression, expected) => {
    expect(result(expression)).toBe(expected);
  });

  it('fails as eigs does: Fraction irrational values, a scalar argument', () => {
    expect(failure('eigenvalues([1,2;3,4])', { numericType: 'Fraction' }).data?.reason).toBe(
      'fraction_unsupported',
    );
    expect(failure('eigenvalues(5)').data?.reason).toBe('type_mismatch');
    expect(failure('eigs(5)').data?.reason).toBe('type_mismatch');
  });
});

describe('roots and solve point at the solvers (#48)', () => {
  const route =
    'For a polynomial of degree 3 or less, pass its coefficients constant term first: 2*x^2 - 4*x + 1 → polynomialRoot(1, -4, 2) → [1.7071067811865475, 0.2928932188134524]. For a linear system A·x = b, use lusolve(A, b): lusolve([3, 2; 1, -1], [12; 1]) → [[2.7999999999999994], [1.8000000000000003]]. Run either with operation "evaluate".';

  it.each([
    ['roots(2*x^2 - 4*x + 1)', 'roots'],
    ['roots([2, -4, 1])', 'roots'],
    ['solve(x^2 - 6*x + 8, x)', 'solve'],
    ['solve([3,2;1,-1], [12;1])', 'solve'],
    ['1 + map([1], f(v) = roots(v))', 'roots'],
  ])('%s fails at parse with the route in every operation', (expression, name) => {
    for (const operation of ['evaluate', 'simplify', 'derivative'] as const) {
      const err = failure(expression, { operation });
      expect(err.data?.reason).toBe('parse_failed');
      expect(err.message).toBe(`Invalid expression: Undefined function ${name}. ${route}`);
      expect(err.data?.recovery).toEqual({ hint: route });
    }
  });

  it('follows a parse failure of text that calls solve with the route', () => {
    const err = failure('solve([3*x+2*y=12, x-y=1], [x, y])');
    expect(err.message).toBe(
      `Invalid expression: Invalid left hand side of assignment operator = (char 15). ${route}`,
    );
    expect(err.data?.recovery).toEqual({ hint: route });
  });

  it('leaves other names, string literals, and unrelated parse failures alone', () => {
    expect(result('"roots("')).toBe('"roots("');
    expect(failure('foo(1)').message).toBe('Invalid expression: Undefined function foo');
    expect(failure('1 +').data?.recovery).toBeUndefined();
    expect(result('map([1, 2], solve(v) = v + 1)')).toBe('[2, 3]');
  });

  it('returns exactly the results the route quotes, under the operation it names', () => {
    expect(result('polynomialRoot(1, -4, 2)')).toBe('[1.7071067811865475, 0.2928932188134524]');
    expect(result('lusolve([3, 2; 1, -1], [12; 1])')).toBe(
      '[[2.7999999999999994], [1.8000000000000003]]',
    );
    // Neither symbolic operation returns those roots.
    expect(failure('polynomialRoot(1, -4, 2)', { operation: 'simplify' }).data?.reason).toBe(
      'evaluation_failed',
    );
    expect(result('polynomialRoot(1, -4, 2)', { operation: 'derivative' })).toBe('0');
  });

  it('renders the quoted code as code spans in content[] and raw in structuredContent', async () => {
    const wire = await runToolContract(calculateTool, {
      expression: 'roots(2*x^2 - 4*x + 1)',
      operation: 'simplify',
    });
    expect(wire.isError).toBe(true);
    const text = (wire.content[0] as { text: string }).text;
    expect(text).toContain('`2*x^2 - 4*x + 1` → `polynomialRoot(1, -4, 2)` →');
    expect(text).toContain('`lusolve([3, 2; 1, -1], [12; 1])`');
    expect(text).toContain('Run either with operation "evaluate".');
    expect(text).not.toContain('Recovery:');
    const { error } = wire.structuredContent as { error: { message: string } };
    expect(error.message).toBe(`Invalid expression: Undefined function roots. ${route}`);
  });

  it('callsRoutedFunction matches a call, not a longer name', () => {
    expect(callsRoutedFunction('solve ([1])')).toBe(true);
    expect(callsRoutedFunction('roots(')).toBe(true);
    expect(callsRoutedFunction('resolve(1)')).toBe(false);
    expect(callsRoutedFunction('my_roots(1)')).toBe(false);
    expect(callsRoutedFunction('solve + 1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callsRoutedFunction scan time: linear in the text across a 64× span
// ---------------------------------------------------------------------------

const BASE_SIZE = 5_000;
const SPAN = 64;
/** Thread CPU milliseconds a measurement spans at least, so a fast call is timed over a batch. */
const MIN_BATCH_MS = 4;
/** Thread CPU milliseconds one call may take at the largest size; a linear scan takes about 1 ms. */
const LARGEST_CALL_MS = 50;

/**
 * Least thread CPU milliseconds per call of `run` over three measurements, each
 * doubling its batch of calls until it spans {@link MIN_BATCH_MS}.
 */
function cpuMsPerCall(run: () => void): number {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round++) {
    const started = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    for (let batch = 1; usedMs < MIN_BATCH_MS; batch = calls) {
      for (let call = 0; call < batch; call++) run();
      calls += batch;
      const used = process.threadCpuUsage(started);
      usedMs = (used.user + used.system) / 1000;
    }
    least = Math.min(least, usedMs / calls);
  }
  return least;
}

/**
 * Time {@link callsRoutedFunction} on texts doubling from {@link BASE_SIZE} to
 * {@link SPAN} times it, timing the base size again beside each larger one. At
 * each size the least growth over three pairs stays under four times the size
 * ratio (below 256 across the full span), checked before the next size runs; the
 * largest call stays under {@link LARGEST_CALL_MS} of thread CPU time.
 */
function expectLinear(make: (size: number) => string): void {
  const base = make(BASE_SIZE);
  let largestMs = 0;
  for (let size = 2 * BASE_SIZE; size <= SPAN * BASE_SIZE; size *= 2) {
    const text = make(size);
    let growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3; pair++) {
      const baseMs = cpuMsPerCall(() => callsRoutedFunction(base));
      largestMs = cpuMsPerCall(() => callsRoutedFunction(text));
      growth = Math.min(growth, largestMs / baseMs);
    }
    expect(growth, `growth from ${BASE_SIZE} to ${size} characters`).toBeLessThan(
      (4 * size) / BASE_SIZE,
    );
  }
  expect(largestMs).toBeLessThan(LARGEST_CALL_MS);
}

/** `unit` repeated to `size` characters. */
const repeat = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));

describe('callsRoutedFunction scan time', () => {
  it.each([
    ['one long line ending in a line break', (size: number) => `${'x'.repeat(size)}\ny`],
    ['line breaks throughout', (size: number) => repeat('  \r\n', size)],
    ['a long identifier ending in solve(', (size: number) => `${'a'.repeat(size)}solve(`],
    ['repeated roots with no (', (size: number) => repeat('roots', size)],
    ['repeated solve prefixes with no (', (size: number) => repeat('solve ', size)],
    ['overlapping roots and solve prefixes', (size: number) => repeat('rootsolve', size)],
    [
      'roots then whitespace and line breaks with no (',
      (size: number) => `roots${repeat(' \t\r\n', size)}x`,
    ],
  ])('stays linear on %s', (_, make) => expectLinear(make), 0);
});
