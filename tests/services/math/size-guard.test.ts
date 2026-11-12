/**
 * @fileoverview Tests for the evaluation size limits — per-call element and
 * string limits, the result element bound checked before formatting, and the
 * per-evaluation element budget — exercised through the real math.js instances.
 * @module services/math/size-guard.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { getMathService, initMathService, MathService } from '@/services/math/math-service.js';
import {
  MAX_EVALUATION_ELEMENTS,
  MAX_MATRIX_ELEMENTS,
  MAX_STRING_LENGTH,
} from '@/services/math/size-guard.js';

type NumericType = 'number' | 'BigNumber' | 'Fraction';

function evaluate(expression: string, numericType: NumericType = 'number') {
  return getMathService().evaluateExpression(expression, undefined, undefined, numericType);
}

/** Evaluate expecting a failure; measure executing-thread CPU rather than host scheduling delay. */
function timedFailure(expression: string, numericType: NumericType = 'number') {
  const started = process.threadCpuUsage();
  let caught: unknown;
  try {
    evaluate(expression, numericType);
  } catch (err) {
    caught = err;
  }
  const usage = process.threadCpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1000;
  expect(caught, `expected "${expression}" to fail`).toBeInstanceOf(McpError);
  return { error: caught as McpError, cpuMs };
}

beforeAll(() => {
  initMathService(getServerConfig());
});

describe('limit constants', () => {
  it('pins the per-call and per-evaluation limits', () => {
    expect(MAX_MATRIX_ELEMENTS).toBe(1_000_000);
    expect(MAX_STRING_LENGTH).toBe(1_000_000);
    expect(MAX_EVALUATION_ELEMENTS).toBe(20_000_000);
  });
});

describe('oversized constructions are rejected before allocating', () => {
  it.each([
    ['range(1, 5e6)', 'range()'],
    ['range(1, 3e7)', 'range()'],
    ['range(1, 1/0)', 'range()'],
    ['range("1:100000000")', 'range()'],
    ['zeros(5000, 5000)', 'zeros()'],
    ['ones(1e4, 1e4)', 'ones()'],
    ['ones([1e4, 1e4])', 'ones()'],
    ['identity(1e4)', 'identity()'],
    ['random([1e4, 1e4])', 'random()'],
    ['randomInt([1e4, 1e4], 5)', 'randomInt()'],
    ['resize([1], [1e4, 1e4])', 'resize()'],
    ['matrixFromFunction([1e4, 1e4], random)', 'matrixFromFunction()'],
    ['pickRandom([1], 1e8)', 'pickRandom()'],
    ['nthRoots(1, 1e7)', 'nthRoots()'],
    ['freqz([1], [1], 1e8)', 'freqz()'],
    ['quantileSeq([1, 2], 1e7)', 'quantileSeq()'],
    ['diag(range(1, 1e4))', 'diag()'],
    ['diag([1], 20000)', 'diag()'],
    ['kron(range(1, 1e4), range(1, 1e4))', 'kron()'],
    ['setCartesian(range(1, 1e4), range(1, 1e4))', 'setCartesian()'],
    ['setPowerset(range(1, 25))', 'setPowerset()'],
    ['transpose([range(1, 1e4)]) * [range(1, 1e4)]', 'multiply()'],
    ['transpose([range(1, 1e4)]) + range(1, 1e4)', 'add()'],
    ['transpose([range(1, 1e4)]) .* range(1, 1e4)', 'dotMultiply()'],
    ['transpose([range(1, 1e4)]) == range(1, 1e4)', 'equal()'],
    ['transpose([range(1, 1e4)]) and range(1, 1e4)', 'and()'],
    ['transpose([range(1, 1e4)]) | range(1, 1e4)', 'bitOr()'],
    ['[1].resize([1e4, 1e4])', 'DenseMatrix.resize()'],
    ['sparse([1]).resize([1, 1e9])', 'SparseMatrix.resize()'],
    ['(A = [1]) + (A[1e4, 1e4] = 1)', 'subset()'],
    ['subset([1], index(1e4, 1e4), 1)', 'subset()'],
    ['format(bignumber("1e1000000000"), {notation: "fixed"})', 'format()'],
    ['format(pi, {notation: "fixed", precision: 1e8})', 'format()'],
    ['print("$0", [bignumber("1e1000000000")], {notation: "fixed"})', 'print()'],
    ['hex(bignumber("1e1000000000"))', 'hex()'],
    ['bin(bignumber("1e1000000000"))', 'bin()'],
  ])('rejects %s', (expression, fn) => {
    const { error, cpuMs } = timedFailure(expression);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain(fn);
    expect(cpuMs).toBeLessThan(1500);
  });

  it.each(['BigNumber', 'Fraction'] as const)(
    'applies the limits under numericType %s',
    (numericType) => {
      const { error } = timedFailure('range(1, 5000000)', numericType);
      expect(error.data?.reason).toBe('result_too_large');
    },
  );

  it('reaches the client with the declared recovery hint', async () => {
    const result = await runToolContract(calculateTool, { expression: 'range(1, 5e6)' });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'result_too_large',
          recovery: {
            hint: 'Reduce precision, narrow the input range, or compute smaller subproblems separately.',
          },
        },
      },
    });
  });
});

describe('limit boundaries', () => {
  it('allows exactly MAX_MATRIX_ELEMENTS and rejects one more', () => {
    expect(evaluate('sum(range(1, 1e6))').result).toBe('500000500000');
    expect(evaluate('sum(zeros(1000, 1000))').result).toBe('0');
    expect(evaluate('sum(identity(1000))').result).toBe('1000');
    expect(timedFailure('sum(range(1, 1e6 + 1))').error.data?.reason).toBe('result_too_large');
    expect(timedFailure('sum(zeros(1000, 1001))').error.data?.reason).toBe('result_too_large');
    expect(timedFailure('sum(identity(1001))').error.data?.reason).toBe('result_too_large');
  });

  it('allows a MAX_STRING_LENGTH format and rejects one more character', () => {
    expect(evaluate('size(format(1, {notation: "fixed", precision: 1e6}))').result).toBe(
      '[1000002]',
    );
    expect(
      timedFailure('size(format(1, {notation: "fixed", precision: 1e6 + 1}))').error.data?.reason,
    ).toBe('result_too_large');
  });

  it('returns an empty matrix', () => {
    expect(evaluate('zeros(0)').result).toBe('[]');
  });

  it('leaves invalid sizes to math.js', () => {
    expect(timedFailure('zeros(-1)').error.data?.reason).toBe('evaluation_failed');
    expect(timedFailure('range(1, "a")').error.data?.reason).not.toBe('result_too_large');
  });
});

describe('range predicts the elements it builds (#43)', () => {
  /** The message of a range rejected on its predicted count, before it allocates. */
  const predicted =
    /^Size limit exceeded: range\(\) would build (?:[\d,]+|unbounded) elements, over the limit of 1,000,000\.$/;

  it.each([
    'range(2000000, 1)',
    'range(1, 2000000, -1)',
    'range("2000000:1")',
    'range(Infinity, 1)',
  ])('returns %s, which steps away from its end, as an empty matrix', (expression) => {
    expect(evaluate(expression).result).toBe('[]');
  });

  it('counts the elements of an empty range expression as 0', () => {
    expect(evaluate('count(2000000:1)').result).toBe('0');
  });

  it.each([
    'count(range(1, 1000001, false))',
    'count(range(1, 1000001, 1, false))',
    'count(range(1000001, 1, -1, false))',
    'count(range("1:1000001", false))',
  ])('builds %s, an end-exclusive range of exactly MAX_MATRIX_ELEMENTS', (expression) => {
    expect(evaluate(expression).result).toBe(String(MAX_MATRIX_ELEMENTS));
  });

  it.each(['range(1, 2, 0)', '1:0:2', 'range("1:0:2")', '[1, 2, 3, 4, 5][1:0:2]'])(
    'fails %s with the zero-step evaluation_failed under every numericType',
    (expression) => {
      for (const numericType of ['number', 'BigNumber', 'Fraction'] as const) {
        const { error } = timedFailure(expression, numericType);
        expect(error.data?.reason, numericType).toBe('evaluation_failed');
        expect(error.message, numericType).toBe('Evaluation failed: Step must be non-zero');
      }
    },
  );

  it.each([
    'range(1, 2000000)',
    'range(2000000, 1, -1)',
    '1:2000000',
    'range(0, 1, 1e-7)',
    'range(1, Infinity)',
    'range("1:100000000")',
    'sum(range(1, 1e6 + 1))',
    // End-exclusive with a fractional span: 1,000,000.5 steps build 1,000,001 elements.
    'range(0, 1e6 + 0.5, 1, false)',
  ])('rejects %s on its predicted count', (expression) => {
    const { error, cpuMs } = timedFailure(expression);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toMatch(predicted);
    expect(cpuMs).toBeLessThan(1500);
  });

  it.each([
    ['count(range(1, 1000000))', '1000000'],
    ['sum(range(1, 1e6))', '500000500000'],
    ['range(1, NaN)', '[]'],
    ['[1, 2, 3, 4, 5][2:4]', '[2, 3, 4]'],
    ['[1, 2, 3, 4, 5][3:end]', '[3, 4, 5]'],
  ])('%s → %s', (expression, expected) => {
    expect(evaluate(expression).result).toBe(expected);
  });

  it('keeps exact Fraction steps', () => {
    expect(evaluate('range(1, 2, 1/3)', 'Fraction').result).toBe('[1/1, 4/3, 5/3, 2/1]');
  });
});

describe('range takes at most MAX_MATRIX_ELEMENTS steps', () => {
  /** The message of a range stopped at the per-call step limit. */
  const stepLimit =
    'Size limit exceeded: range() would build more than the limit of 1,000,000 elements.';

  it.each([
    ['count(2^53:2^53+2)', 'number'],
    ['count(1e16:1e16+4)', 'number'],
    ['count(Infinity:Infinity)', 'number'],
    ['count(1e70:1e70+4)', 'BigNumber'],
    ['count(range(1e400, 1e400 + 5))', 'BigNumber'],
  ] as const)('holds %s (%s) to MAX_MATRIX_ELEMENTS steps', (expression, numericType) => {
    const { error } = timedFailure(expression, numericType);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toBe(stepLimit);
  });

  it('stops a range that the comparison tolerance carries one element past the limit', () => {
    // The span predicts exactly MAX_MATRIX_ELEMENTS, and 1e6 is within math.js's
    // relative tolerance of the end, so the range would include it too.
    const { error } = timedFailure('count(range(0, 1e6 - 1e-7))');
    expect(error.message).toBe(stepLimit);
    expect(evaluate('count(range(0, 1e6 - 1e-5))').result).toBe('1000000');
  });

  it.each([
    ['count(range(1000000, 1, -1))', 'number'],
    ['count(range(1, 1e6))', 'BigNumber'],
    ['count(range(1, 1e6))', 'Fraction'],
  ] as const)(
    'builds %s (%s), a range of exactly MAX_MATRIX_ELEMENTS',
    (expression, numericType) => {
      expect(evaluate(expression, numericType).result).toBe('1000000');
    },
  );

  it.each([
    // The outer range's end is computed by a range of the same length.
    ['count(range(1, count(range(1, 900000))))', '900000'],
    // Three callback ranges inside a fourth, together past the limit.
    ['sum(map(range(1, 3), f(i) = count(range(1, 900000))))', '2700000'],
    ['count(1:900000) + count(1:900000)', '1800000'],
  ])('counts the steps of each range in %s separately', (expression, expected) => {
    expect(evaluate(expression).result).toBe(expected);
  });

  it('holds a range inside a map callback to the step limit', () => {
    const { error } = timedFailure('map(1:2, f(i) = count(2^53:2^53+2))');
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toBe(stepLimit);
  });
});

describe('tabulated sequences take an index up to a stated maximum', () => {
  it.each([
    // S(n, n − 1) = C(n, 2).
    ['stirlingS2(1412, 1411)', 'number', '996166'],
    ['stirlingS2(314, 313)', 'BigNumber', '49141'],
    // S(n, 2) = 2^(n − 1) − 1; the BigNumber maximum applies only to a BigNumber argument.
    ['stirlingS2(315, 2) == 2^314 - 1', 'number', 'true'],
    // B(1000) ≈ −5.3e1769 overflows math.js's float recurrence.
    ['isNaN(bernoulli(1000))', 'number', 'true'],
    // Past the maximum, an odd index builds nothing.
    ['bernoulli(100001)', 'number', '0'],
  ] as const)('takes %s (%s) → %s', (expression, numericType, expected) => {
    expect(evaluate(expression, numericType).result).toBe(expected);
  });

  it('takes bellNumbers at each maximum', () => {
    // B(1412) is past 1e308, so the float result overflows; the BigNumber one is finite.
    expect(timedFailure('bellNumbers(1412)').error.data?.reason).toBe('undefined_result');
    expect(evaluate('bellNumbers(314)', 'BigNumber').resultType).toBe('BigNumber');
  });

  it('takes bernoulli(1000) under BigNumber', () => {
    // B(n) is negative for n divisible by 4, and |B(1000)| ≈ 4√(1000π)·(1000/2πe)^1000 ≈ 10^1769.7.
    expect(evaluate('bernoulli(1000)', 'BigNumber').result).toMatch(/^-[1-9]\.\d+e\+1769$/);
  });

  it.each([
    [
      'stirlingS2(1413, 1)',
      'number',
      'stirlingS2() takes n up to 1,412 (314 when an argument is a BigNumber); got n = 1,413.',
    ],
    [
      'bellNumbers(1413)',
      'number',
      'bellNumbers() takes n up to 1,412 (314 when an argument is a BigNumber); got n = 1,413.',
    ],
    [
      'stirlingS2(315, 1)',
      'BigNumber',
      'stirlingS2() takes n up to 314 when an argument is a BigNumber (1,412 for numbers); got n = 315.',
    ],
    [
      'bellNumbers(315)',
      'BigNumber',
      'bellNumbers() takes n up to 314 when an argument is a BigNumber (1,412 for numbers); got n = 315.',
    ],
    [
      'stirlingS2(bignumber(315), 2)',
      'number',
      'stirlingS2() takes n up to 314 when an argument is a BigNumber (1,412 for numbers); got n = 315.',
    ],
    [
      'stirlingS2(315, bignumber(2))',
      'number',
      'stirlingS2() takes n up to 314 when an argument is a BigNumber (1,412 for numbers); got n = 315.',
    ],
    ['bernoulli(1002)', 'number', 'bernoulli() takes an even n up to 1,000; got n = 1,002.'],
    ['bernoulli(1002)', 'BigNumber', 'bernoulli() takes an even n up to 1,000; got n = 1,002.'],
    ['bernoulli(1002)', 'Fraction', 'bernoulli() takes an even n up to 1,000; got n = 1,002.'],
  ] as const)('rejects %s (%s) above its maximum', (expression, numericType, detail) => {
    const { error, cpuMs } = timedFailure(expression, numericType);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toBe(`Size limit exceeded: ${detail}`);
    expect(cpuMs).toBeLessThan(1500);
  });
});

describe('Fraction-mode dimension arguments of diff and mapSlices', () => {
  it.each([
    ['mapSlices([1, 2; 3, 4], 1, sum)', '[4/1, 6/1]'],
    ['mapSlices([1, 2; 3, 4], 2, sum)', '[3/1, 7/1]'],
    ['apply([1, 2; 3, 4], 1, sum)', '[4/1, 6/1]'],
    // The callback indexes each column with a Fraction literal too.
    ['mapSlices([1, 2; 3, 4], 1, f(v) = v[2])', '[3/1, 4/1]'],
    ['diff([1, 2; 4, 8], 1)', '[[3/1, 6/1]]'],
    ['diff([1, 2; 4, 8], 2)', '[[1/1], [4/1]]'],
    ['diff(diff([1, 2, 4; 8, 16, 32], 2), 1)', '[[7/1, 14/1]]'],
  ])('%s → %s', (expression, expected) => {
    expect(evaluate(expression, 'Fraction').result).toBe(expected);
  });

  it.each([
    ['diff([1, 2; 4, 8], 1/2)', 'diff() needs whole-number dimensions; got 1/2.'],
    ['mapSlices([1, 2; 3, 4], 3/2, sum)', 'mapSlices() needs whole-number dimensions; got 3/2.'],
  ])('rejects %s, whose dimension is not a whole number', (expression, detail) => {
    const { error } = timedFailure(expression, 'Fraction');
    expect(error.data?.reason).toBe('evaluation_failed');
    expect(error.message).toBe(`Evaluation failed: ${detail}`);
  });
});

describe('result elements are bounded before formatting', () => {
  it('formats the largest collection that fits and rejects one element more', () => {
    const { result } = evaluate('zeros(33333)');
    expect(result.length).toBe(99_999);
    expect(timedFailure('zeros(33334)').error.data?.reason).toBe('result_too_large');
  });

  it('derives the bound from maxResultLength', () => {
    const svc = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 5000,
      maxResultLength: 1000,
    });
    expect(svc.evaluateExpression('zeros(333)').result.length).toBe(999);
    expect(() => svc.evaluateExpression('zeros(334)')).toThrow(
      'Result exceeds maximum size (1000 characters)',
    );
  });

  it('counts elements nested in objects and units inside matrices', () => {
    expect(timedFailure('[{a: zeros(20000)}, {a: zeros(20000)}]').error.data?.reason).toBe(
      'result_too_large',
    );
    expect(timedFailure('zeros(40000) * 1 m').error.data?.reason).toBe('result_too_large');
  });

  it('bounds a sparse result by its stored values, not its dimensions', () => {
    expect(evaluate('sparse([1, 0; 0, 2])').resultType).toBe('SparseMatrix');
  });
});

describe('per-evaluation element budget', () => {
  // Each callback result is under the per-call limit; only the accumulation is not.
  const accumulating = 'size(map(range(1, 1e5), f(x) = zeros(1e4)))';

  it('stops an inline callback that accumulates literal matrices', () => {
    const svc = new MathService({
      maxExpressionLength: 5000,
      evaluationTimeoutMs: 5000,
      maxResultLength: 100_000,
    });
    // No guarded function runs per iteration: only the metered literal sees the growth.
    const literal = `[${Array.from({ length: 1000 }, () => 'x').join(',')}]`;
    let caught: unknown;
    try {
      svc.evaluateExpression(`size(map(range(1, 1e6), ${literal}))`);
    } catch (err) {
      caught = err;
    }
    expect((caught as McpError).data?.reason).toBe('result_too_large');
    expect((caught as McpError).message).toContain('20,000,000 elements');
  });

  it('stops a loop that accumulates allocations', () => {
    const { error, cpuMs } = timedFailure(accumulating);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain('20,000,000 elements');
    expect(cpuMs).toBeLessThan(1500);
  });

  it('lets a large scalar loop finish', () => {
    expect(evaluate('sum(map(range(1, 1e6), f(x) = x^2))').result).toBe('333333833333127550');
    expect(evaluate('sum(map(range(1, 1e5), x^2))', 'BigNumber').result).toBe('333338333350000');
    expect(
      evaluate('sum(map(range(1, 1e6), f(x) = x^3 - 2*x + x^2/3 + 5 - x/7 + sin(x)^2 + cos(x)^2))')
        .resultType,
    ).toBe('number');
  });

  it('resets between evaluations', () => {
    timedFailure(accumulating);
    expect(evaluate('sum(zeros(1000, 1000) + 1)').result).toBe('1000000');
  });

  it('decides from what the expression builds, not from heap readings', () => {
    // Garbage an evaluation leaves uncollected shows up in heapUsed; a legitimate
    // expression must not fail because the collector has not run yet.
    const reading = process.memoryUsage();
    let calls = 0;
    const spy = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
      ...reading,
      heapUsed: reading.heapUsed + (calls++ > 0 ? 2 ** 30 : 0),
    }));
    try {
      expect(evaluate('sum(range(1, 100) .* range(1, 100))').result).toBe('338350');
    } finally {
      spy.mockRestore();
    }
  });

  it('stops repeated copies that no single call builds', () => {
    const { error, cpuMs } = timedFailure(
      "size([A = range(1, 1e6), A', A', A', A', A', A', A', A', A', A'])",
    );
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain('20,000,000 elements');
    expect(cpuMs).toBeLessThan(1500);
  });

  it.each([
    ['BigNumber', 'sum((range(1, 1e6) .^ 2) .* range(1, 1e6))', '2.5000050000025e+23'],
    ['number', 'sum(((r = range(1, 1e6)) .^ 2 + r .* 3 - r) ./ 2)', '166667416667013900'],
  ] as const)(
    'lets chained full-size %s vector arithmetic finish',
    (numericType, expression, result) => {
      expect(evaluate(expression, numericType).result).toBe(result);
    },
  );

  it('allows nine chained operations on a full-size range and rejects the tenth', () => {
    // The range and each sum are charged twice: by the guarded call and by its node.
    const nine = `sum((r = range(1, 1e6))${' + r'.repeat(9)})`;
    expect(evaluate(nine).result).toBe('5000005000000');
    const { error } = timedFailure(`sum((r = range(1, 1e6))${' + r'.repeat(10)})`);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain('20,000,000 elements');
  });

  it('charges indexed assignment only for the growth it causes', () => {
    expect(
      evaluate('sum((A = zeros(1e5)) * 0 + map(range(1, 1e5), f(i) = (A[i] = i)))').result,
    ).toBe('5000050000');
  });
});

describe('functions whose output can outgrow their inputs', () => {
  // Each input stays under the per-call limit; the output repeats or broadcasts it.
  it.each([
    ['size(zeros(1, 1)[ones(2000), ones(2000)])', 'subset()'],
    ['size(subset(zeros(1, 1), index(ones(2000), ones(2000))))', 'subset()'],
    ['size(concat(A = range(1, 1e5), A, A, A, A, A, A, A, A, A, A))', 'concat()'],
    ['size(concat(s = format(1, {notation: "fixed", precision: 5e5}), s, s))', 'concat()'],
    ['size(matrixFromRows(A = range(1, 1e5), A, A, A, A, A, A, A, A, A, A))', 'matrixFromRows()'],
    [
      'size(matrixFromColumns(A = range(1, 1e5), A, A, A, A, A, A, A, A, A, A))',
      'matrixFromColumns()',
    ],
    ['size(map(transpose([range(1, 2000)]), range(1, 2000), add))', 'map()'],
    ['size(map(transpose([range(1, 2000)]), range(1, 2000), f(a, b) = a))', 'map()'],
  ])('rejects %s before building it', (expression, fn) => {
    const { error, cpuMs } = timedFailure(expression);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain(fn);
    expect(cpuMs).toBeLessThan(1500);
  });

  it('keeps the broadcasting forms of map working within the limit', () => {
    expect(evaluate('map([1; 2], [10, 20], f(a, b) = a + b)').result).toBe('[[11, 21], [12, 22]]');
    expect(evaluate('map([1; 2], [10, 20], f(a, b) = a * b)').result).toBe('[[10, 20], [20, 40]]');
    expect(evaluate('concat([1, 2], [3, 4])').result).toBe('[1, 2, 3, 4]');
    expect(evaluate('concat("ab", "cd")').result).toBe('"abcd"');
    expect(evaluate('matrixFromRows([1, 2], [3, 4])').result).toBe('[[1, 2], [3, 4]]');
  });
});

describe('guarded functions keep their math.js behavior', () => {
  it.each([
    ['range(1, 3)', '[1, 2, 3]'],
    ['range(0, 10, 5)', '[0, 5, 10]'],
    ['range("1:3")', '[1, 2, 3]'],
    ['subset([1, 2, 3], index(2))', '2'],
    ['quantileSeq([1, 2, 3, 4], 3)', '[1.75, 2.5, 3.25]'],
    ['map([1, 2], ones)', '[[1], [1, 1]]'],
    ['false and foo(1)', 'false'],
    ['true or foo(1)', 'true'],
    ['[1, 0] and [1; 1]', '[[true, false], [true, false]]'],
    ['[1, 2] + [10; 20]', '[[11, 12], [21, 22]]'],
    ['[1, 2; 3, 4] * [5; 6]', '[[17], [39]]'],
    ['kron([1, 2], [1, 1])', '[1, 1, 2, 2]'],
    ['diag([1, 2], 1)', '[[0, 1, 0], [0, 0, 2]]'],
    ['size(setCartesian([1, 2], [3, 4]))', '[4, 2]'],
    ['format(pi, 3)', '"3.14"'],
    ['print("$1 and $2", [1, 2])', '"1 and 2"'],
    ['hex(255)', '"0xff"'],
    ['5 kg to lbs', '11.023113109243878 lbs'],
    // Indexed assignment grows A in place to [1, 2, 3]; the assignment evaluates to 3.
    ['(A = [1, 2]) + (A[3] = 3)', '[4, 5, 6]'],
    ['size(resize([1], [2, 3]))', '[2, 3]'],
  ])('%s → %s', (expression, expected) => {
    expect(evaluate(expression).result).toBe(expected);
  });

  it('constant folding in simplify hits the same limit and leaves the call', () => {
    const svc = getMathService();
    const started = process.threadCpuUsage();
    expect(svc.simplifyExpression('zeros(5000, 5000)').result).toBe('zeros(5000, 5000)');
    const usage = process.threadCpuUsage(started);
    expect((usage.user + usage.system) / 1000).toBeLessThan(1500);
  });
});
