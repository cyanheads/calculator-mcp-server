/**
 * @fileoverview Tests for the evaluation size limits — per-call element and
 * string limits, the result element bound checked before formatting, and the
 * per-evaluation element budget — exercised through the real math.js instances.
 * @module services/math/size-guard.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

function mockCtx() {
  return createMockContext({ errors: calculateTool.errors });
}

function evaluate(expression: string, numericType: NumericType = 'number') {
  return getMathService().evaluateExpression(
    expression,
    mockCtx(),
    undefined,
    undefined,
    numericType,
  );
}

/** Evaluate expecting a failure; return the error and how long the call took. */
function timedFailure(expression: string, numericType: NumericType = 'number') {
  const started = performance.now();
  let caught: unknown;
  try {
    evaluate(expression, numericType);
  } catch (err) {
    caught = err;
  }
  const elapsedMs = performance.now() - started;
  expect(caught, `expected "${expression}" to fail`).toBeInstanceOf(McpError);
  return { error: caught as McpError, elapsedMs };
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
    const { error, elapsedMs } = timedFailure(expression);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain(fn);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it.each(['BigNumber', 'Fraction'] as const)(
    'applies the limits under numericType %s',
    (numericType) => {
      const { error } = timedFailure('range(1, 5000000)', numericType);
      expect(error.data?.reason).toBe('result_too_large');
    },
  );

  it('carries the declared recovery hint', () => {
    const { error } = timedFailure('range(1, 5e6)');
    expect(error.data?.recovery).toEqual({
      hint: 'Reduce precision, narrow the input range, or compute smaller subproblems separately.',
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
    expect(svc.evaluateExpression('zeros(333)', mockCtx()).result.length).toBe(999);
    expect(() => svc.evaluateExpression('zeros(334)', mockCtx())).toThrow(
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
      svc.evaluateExpression(`size(map(range(1, 1e6), ${literal}))`, mockCtx());
    } catch (err) {
      caught = err;
    }
    expect((caught as McpError).data?.reason).toBe('result_too_large');
    expect((caught as McpError).message).toContain('20,000,000 elements');
  });

  it('stops a loop that accumulates allocations', () => {
    const { error, elapsedMs } = timedFailure(accumulating);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain('20,000,000 elements');
    expect(elapsedMs).toBeLessThan(1500);
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
    const { error, elapsedMs } = timedFailure(
      "size([A = range(1, 1e6), A', A', A', A', A', A', A', A', A', A'])",
    );
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain('20,000,000 elements');
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('lets chained full-size vector arithmetic finish', () => {
    expect(evaluate('sum((range(1, 1e6) .^ 2) .* range(1, 1e6))', 'BigNumber').result).toBe(
      '2.5000050000025e+23',
    );
    expect(evaluate('sum(((r = range(1, 1e6)) .^ 2 + r .* 3 - r) ./ 2)').result).toBe(
      '166667416667013900',
    );
  });

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
    const { error, elapsedMs } = timedFailure(expression);
    expect(error.data?.reason).toBe('result_too_large');
    expect(error.message).toContain(fn);
    expect(elapsedMs).toBeLessThan(1500);
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
    const started = performance.now();
    expect(svc.simplifyExpression('zeros(5000, 5000)', mockCtx()).result).toBe('zeros(5000, 5000)');
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
