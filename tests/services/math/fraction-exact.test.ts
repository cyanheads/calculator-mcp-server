/**
 * @fileoverview Tests for the exact numericType "Fraction" functions — integer
 * combinatorics, rational roots (`nthRoot` over collections included), `^` with a
 * non-integer exponent, and `sqrtm` — exercised through the real math.js
 * instances, plus the failure-reason lookup the service classifies their errors
 * with.
 * @module services/math/fraction-exact.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { FractionResultError, fractionFailureIn } from '@/services/math/fraction-exact.js';
import { getMathService, initMathService, MathService } from '@/services/math/math-service.js';
import { markdownText } from '../../helpers/markdown.js';

type NumericType = 'number' | 'BigNumber' | 'Fraction';

/** The text surface of a tool result, read as a CommonMark client would. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return markdownText(
    result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  );
}

function evaluate(
  expression: string,
  numericType: NumericType = 'Fraction',
  scope?: Record<string, number>,
  service: MathService = getMathService(),
) {
  return service.evaluateExpression(expression, scope, undefined, numericType);
}

/** Evaluate expecting a failure; also measure the executing thread's CPU time. */
function failure(
  expression: string,
  numericType: NumericType = 'Fraction',
  service: MathService = getMathService(),
) {
  const started = process.threadCpuUsage();
  let caught: unknown;
  try {
    evaluate(expression, numericType, undefined, service);
  } catch (err) {
    caught = err;
  }
  const usage = process.threadCpuUsage(started);
  expect(caught, `expected "${expression}" to fail`).toBeInstanceOf(McpError);
  const error = caught as McpError;
  return {
    reason: error.data?.reason,
    message: error.message,
    cpuMs: (usage.user + usage.system) / 1000,
  };
}

beforeAll(() => {
  initMathService(getServerConfig());
});

describe('integer combinatorics under Fraction', () => {
  it.each([
    ['10!', '3628800/1'],
    ['factorial(10)', '3628800/1'],
    ['permutations(10)', '3628800/1'],
    ['50!', '30414093201713378043612608166064768844377641568960512000000000000/1'],
    ['combinations(10, 3)', '120/1'],
    ['permutations(10, 3)', '720/1'],
    ['combinations(10^20, 2)', '4999999999999999999950000000000000000000/1'],
    ['permutations(10^20, 2)', '9999999999999999999900000000000000000000/1'],
    ['gamma(5)', '24/1'],
    ['multinomial([1, 2, 3])', '60/1'],
    ['catalan(5)', '42/1'],
    ['composition(5, 2)', '4/1'],
  ])('%s → %s', (expression, expected) => {
    expect(evaluate(expression)).toEqual({ result: expected, resultType: 'Fraction' });
  });

  it.each([
    ['0!', '1/1'],
    ['permutations(0)', '1/1'],
    ['combinations(0, 0)', '1/1'],
    ['combinations(5, 5)', '1/1'],
    ['combinations(10, 7)', '120/1'],
    ['permutations(5, 0)', '1/1'],
    ['permutations(5, 5)', '120/1'],
    ['gamma(1)', '1/1'],
    ['catalan(0)', '1/1'],
    ['composition(5, 5)', '1/1'],
    ['multinomial([4])', '1/1'],
    ['multinomial([3, 1, 2])', '60/1'],
  ])('%s at a boundary → %s', (expression, expected) => {
    expect(evaluate(expression)).toEqual({ result: expected, resultType: 'Fraction' });
  });

  it('reads a scope value as an integer argument', () => {
    expect(evaluate('x!', 'Fraction', { x: 5 })).toEqual({
      result: '120/1',
      resultType: 'Fraction',
    });
  });

  it('maps over collections, nested past the first level', () => {
    expect(evaluate('factorial([3, 4])').result).toBe('[6/1, 24/1]');
    expect(evaluate('[1, 2, 3]!').result).toBe('[1/1, 2/1, 6/1]');
    expect(evaluate('factorial([[1, 2], [3, 4]])').result).toBe('[[1/1, 2/1], [6/1, 24/1]]');
    // 10! / (1! 2! 3! 4!) over the elements of a matrix.
    expect(evaluate('multinomial([1, 2; 3, 4])').result).toBe('12600/1');
  });

  it.each([
    '100! - prod(1:100)',
    'gamma(1001) - prod(1:1000)',
    'permutations(500, 200) - prod(301:500)',
    'combinations(200, 100) - prod(101:200) / prod(1:100)',
    'catalan(30) * 31 * prod(1:30) - prod(31:60)',
    'composition(40, 15) - prod(26:39) / prod(1:14)',
    'multinomial([7, 5, 3]) - prod(1:15) / (prod(1:7) * prod(1:5) * prod(1:3))',
  ])('%s → 0/1 (agrees with the product of the same integers)', (expression) => {
    expect(evaluate(expression).result).toBe('0/1');
  });

  it('keeps math.js results for a collection with no Fraction in it', () => {
    expect(evaluate('multinomial([])')).toEqual({ result: '1', resultType: 'number' });
  });
});

describe('invalid combinatorics arguments fail as in number mode', () => {
  it.each([
    ['(-1)!', 'evaluation_failed'],
    ['factorial(-1/2)', 'evaluation_failed'],
    ['permutations(-1)', 'evaluation_failed'],
    ['combinations(3, 5)', 'evaluation_failed'],
    ['combinations(5/2, 1)', 'evaluation_failed'],
    ['combinations(-1, 0)', 'evaluation_failed'],
    ['permutations(3, 5)', 'evaluation_failed'],
    ['permutations(5/2, 1)', 'evaluation_failed'],
    ['catalan(-1)', 'evaluation_failed'],
    ['catalan(1/2)', 'evaluation_failed'],
    ['composition(0, 1)', 'evaluation_failed'],
    ['composition(2, 3)', 'evaluation_failed'],
    ['multinomial([0, 2])', 'evaluation_failed'],
    ['multinomial([1/2, 1])', 'evaluation_failed'],
    ['nthRoot(-16, 4)', 'evaluation_failed'],
    ['nthRoot(-8, 3/2)', 'evaluation_failed'],
    ['nthRoot(8, 0)', 'evaluation_failed'],
    ['nthRoot([-16, 4], 4)', 'evaluation_failed'],
    ['nthRoot([4, 9], 0)', 'evaluation_failed'],
    ['nthRoot(16, [2, 0])', 'evaluation_failed'],
    ['nthRoot(4, sparse([2, 0]))', 'evaluation_failed'],
    ['gamma(0)', 'undefined_result'],
    ['gamma(-3)', 'undefined_result'],
    ['nthRoot(0, -2)', 'undefined_result'],
    ['nthRoot([4, 0], -2)', 'undefined_result'],
  ])('%s → %s in Fraction and number mode', (expression, reason) => {
    expect(failure(expression).reason).toBe(reason);
    expect(failure(expression, 'number').reason).toBe(reason);
  });

  it('names the argument problem in the message', () => {
    expect(failure('(-1)!').message).toContain('Value must be non-negative');
    expect(failure('combinations(3, 5)').message).toContain('k must be less than or equal to n');
    expect(failure('nthRoot(-16, 4)').message).toContain('Root must be odd when a is negative.');
    expect(failure('nthRoot([-16, 4], 4)').message).toContain(
      'Root must be odd when a is negative.',
    );
    expect(failure('nthRoot(4, sparse([2, 0]))').message).toContain('Root must be non-zero');
  });
});

describe('rational roots under Fraction', () => {
  it.each([
    ['sqrt(4)', '2/1'],
    ['sqrt(9/4)', '3/2'],
    ['sqrt(0)', '0/1'],
    ['(-4 + sqrt(4^2 - 4*4*1))/(2*4)', '-1/2'],
    ['cbrt(27/8)', '3/2'],
    ['cbrt(-8)', '-2/1'],
    ['nthRoot(-8, 3)', '-2/1'],
    ['nthRoot(16, 4)', '2/1'],
    ['nthRoot(16)', '4/1'],
    ['nthRoot(8, 3/2)', '4/1'],
    ['nthRoot(1/4, -2)', '2/1'],
    ['nthRoot(0, 3)', '0/1'],
    ['sqrt(sqrt(16))', '2/1'],
    ['((2^61-1)^2)^(1/2)', '2305843009213693951/1'],
    ['((2^61-1)^3)^(1/3)', '2305843009213693951/1'],
    ['4^(1/2)', '2/1'],
    ['(9/4)^(3/2)', '27/8'],
    ['(9/4)^(-3/2)', '8/27'],
    ['(2^3000)^(1/1000)', '8/1'],
    ['1^(1/10^30)', '1/1'],
    ['0^(1/2)', '0/1'],
    ['(-8)^2', '64/1'],
  ])('%s → %s', (expression, expected) => {
    expect(evaluate(expression)).toEqual({ result: expected, resultType: 'Fraction' });
  });

  it.each([
    ['2^10', '1024/1'],
    ['2^(-10)', '1/1024'],
    ['(-2)^3', '-8/1'],
    ['(-2)^(-3)', '-1/8'],
    ['(2/3)^(-3)', '27/8'],
    ['(-2/3)^(-3)', '-27/8'],
    ['(-2/3)^0', '1/1'],
    ['0^0', '1/1'],
    ['0^(10^400)', '0/1'],
    ['1^(10^400)', '1/1'],
    ['(-1)^(10^400 + 1)', '-1/1'],
    ['(-1)^(-3)', '-1/1'],
  ])('%s → %s (an integer or zero-base power)', (expression, expected) => {
    expect(evaluate(expression)).toEqual({ result: expected, resultType: 'Fraction' });
  });

  it.each([
    '(3^1000)^(1/2) - 3^500',
    'sqrt((10^200 + 1)^2) - (10^200 + 1)',
    'nthRoot((7^300 / 2^90)^7, 7) - 7^300 / 2^90',
    '(2/3)^20 - prod((2/3) * ones(1, 20))',
    '(-3/5)^(-21) - 1 / prod((-3/5) * ones(1, 21))',
    '(9/4)^(-5/2) - prod((2/3) * ones(1, 5))',
    'nthRoot(16/81, -4/3) - prod((3/2) * ones(1, 3))',
  ])('%s → 0/1 (agrees with integer powers)', (expression) => {
    expect(evaluate(expression).result).toBe('0/1');
  });

  it.each([
    'sqrt(2)',
    'sqrt(2^61-1)',
    'sqrt(10^200 + 1)',
    'sqrt(1/2)',
    'sqrt(2/9)',
    'sqrt(-4)',
    'cbrt(2)',
    'nthRoot(2, 3)',
    'nthRoot(8, 10^9)',
    '(1/2)!',
    'gamma(1/2)',
    'log2(8)',
    'stirlingS2(5, 2)',
    '2^(1/2)',
    '(2^61-1)^(1/2)',
    '2^(1/10^9)',
    '(-8)^(1/3)',
  ])('%s fails with fraction_unsupported, naming the function cause', (expression) => {
    const { reason, message } = failure(expression);
    expect(reason).toBe('fraction_unsupported');
    expect(message).toContain('no exact rational value');
  });

  it.each([
    // The 64-bit float power is exactly 1, or the exponent's float underflows to 0.
    '2^(1/10^30)',
    '2^(1/10^400)',
    '(-8)^(1/10^400)',
    // The float is the safe integer 10^15, underflows to 0, or overflows.
    '(10^30 + 1)^(1/2)',
    '(1/2)^((10^20 + 1)/2)',
    '2^((10^20 + 1)/2)',
    // The float would reach exact arithmetic or a number function: 4/3, 1, and 10^15
    // (the true floor is 10^15 - 1).
    '2^(1/10^30) + 1/3',
    'floor(2^(1/2))',
    'floor((10^30 - 1)^(1/2))',
    // Element-wise, nested past the first level, and inside a callback.
    '2 .^ (1/10^30)',
    '[[4/9], [2]] .^ (1/10^30)',
    'map([4, 2], f(x) = x^(1/10^30))',
  ])(
    '%s, an irrational power, fails with fraction_unsupported whatever its float rounds to',
    (expression) => {
      const { reason, message } = failure(expression);
      expect(reason).toBe('fraction_unsupported');
      expect(message).toContain('no exact rational value');
    },
  );

  it('takes exact element-wise powers', () => {
    expect(evaluate('[4, 9/4] .^ (1/2)')).toEqual({
      result: '[2/1, 3/2]',
      resultType: 'DenseMatrix',
    });
    expect(evaluate('[[2], [-2/3]] .^ (-3)').result).toBe('[[1/8], [-27/8]]');
  });

  it.each([
    // A collection and a scalar root, either way round.
    ['nthRoot([4, 9], 2)', '[2/1, 3/1]', 'DenseMatrix'],
    ['nthRoot([8, 27], 3)', '[2/1, 3/1]', 'DenseMatrix'],
    ['nthRoot([-8, 27/8], 3)', '[-2/1, 3/2]', 'DenseMatrix'],
    ['nthRoot([1/4, 64], -2/3)', '[8/1, 1/512]', 'DenseMatrix'],
    ['nthRoot(16, [2, 4])', '[4/1, 2/1]', 'DenseMatrix'],
    ['nthRoot([4, 9].valueOf(), 2)', '[2/1, 3/1]', 'Array'],
    ['nthRoot(16, [2, 4].valueOf())', '[4/1, 2/1]', 'Array'],
    // Two collections, element by element and broadcast.
    ['nthRoot([4, 9], [2, 2])', '[2/1, 3/1]', 'DenseMatrix'],
    ['nthRoot([4, 9].valueOf(), [2, 2].valueOf())', '[2/1, 3/1]', 'Array'],
    ['nthRoot([4, 9].valueOf(), [2, 2])', '[2/1, 3/1]', 'DenseMatrix'],
    ['nthRoot([16; 81], [2, 4])', '[[4/1, 2/1], [9/1, 3/1]]', 'DenseMatrix'],
    // The square root by default.
    ['nthRoot([4, 9])', '[2/1, 3/1]', 'DenseMatrix'],
    ['nthRoot([4, 9].valueOf())', '[2/1, 3/1]', 'Array'],
    // Nested past the first level.
    ['nthRoot([[4, 9], [16, 25/4]], 2)', '[[2/1, 3/1], [4/1, 5/2]]', 'DenseMatrix'],
    ['nthRoot([[4, 9], [16, 25]])', '[[2/1, 3/1], [4/1, 5/1]]', 'DenseMatrix'],
    ['nthRoot([[64, 729]], [[2, 3]])', '[[8/1, 9/1]]', 'DenseMatrix'],
    ['nthRoot([], 2)', '[]', 'DenseMatrix'],
  ] as const)('%s → %s, root by root', (expression, result, resultType) => {
    expect(evaluate(expression)).toEqual({ result, resultType });
  });

  it.each([
    ['nthRoot(sparse([4, 9]), 2)', '(0, 0) ==> 2/1\n    (1, 0) ==> 3/1', 'density: 1'],
    ['nthRoot(sparse([4, 9]))', '(0, 0) ==> 2/1\n    (1, 0) ==> 3/1', 'density: 1'],
    ['nthRoot(16, sparse([2, 4]))', '(0, 0) ==> 4/1\n    (1, 0) ==> 2/1', 'density: 1'],
    ['nthRoot(sparse([4, 9]), sparse([2, 2]))', '(0, 0) ==> 2/1\n    (1, 0) ==> 3/1', 'density: 1'],
    ['nthRoot(sparse([4, 9]), [2; 2])', '(0, 0) ==> 2/1\n    (1, 0) ==> 3/1', 'density: 1'],
    // A sparse matrix keeps its zeros, so a negative root never meets one.
    ['nthRoot(sparse([4, 0]), -2)', '(0, 0) ==> 1/2', 'density: 0.5'],
  ])('%s keeps a sparse matrix, root by root', (expression, entries, density) => {
    const { result, resultType } = evaluate(expression);
    expect(resultType).toBe('SparseMatrix');
    expect(result).toBe(`Sparse Matrix [2 x 1] ${density}\n\n    ${entries}`);
  });

  it.each([
    'nthRoot([4, 2], 2)',
    'nthRoot(2, [4, 9])',
    'nthRoot([16; 2], [2, 4])',
    'nthRoot(sparse([4, 2]), 2)',
    'nthRoot([[4, 9], [16, 2]])',
  ])('%s, with an irrational element, fails as its scalar form does', (expression) => {
    const { reason, message } = failure(expression);
    expect(reason).toBe('fraction_unsupported');
    expect(message).toBe(failure('nthRoot(2, 2)').message);
    expect(message).toContain('no exact rational value');
  });

  it('takes a number root of a Fraction exactly, alone or element by element', () => {
    expect(evaluate('nthRoot(4, number(2))')).toEqual({ result: '2/1', resultType: 'Fraction' });
    expect(evaluate('nthRoot([4, 9], number(2))').result).toBe('[2/1, 3/1]');
    expect(failure('nthRoot(2, number(2))').reason).toBe('fraction_unsupported');
  });

  it('keeps the number result of a number element', () => {
    expect(evaluate('nthRoot([number(4)])')).toEqual({ result: '[2]', resultType: 'DenseMatrix' });
    expect(evaluate('nthRoot(number(4))')).toEqual({ result: '2', resultType: 'number' });
  });

  it('agrees with mapping the scalar form', () => {
    expect(evaluate('map([4, 9], f(x) = nthRoot(x, 2))').result).toBe('[2/1, 3/1]');
    expect(evaluate('nthRoot([8, 27/8, 1/64], 3/2)').result).toBe('[4/1, 9/4, 1/16]');
    expect(
      evaluate('nthRoot([8, 27/8, 1/64], 3/2) - map([8, 27/8, 1/64], f(x) = nthRoot(x, 3/2))')
        .result,
    ).toBe('[0/1, 0/1, 0/1]');
  });

  it('returns roots of a collection through the calculate tool on both surfaces', async () => {
    const output = await runToolContract(calculateTool, {
      expression: 'nthRoot([4, 9], 2)',
      numericType: 'Fraction',
    });
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent).toMatchObject({
      result: '[2/1, 3/1]',
      resultType: 'DenseMatrix',
    });
    expect(textOf(output)).toContain('Result: [2/1, 3/1]');

    const failed = await runToolContract(calculateTool, {
      expression: 'nthRoot([4, 2], 2)',
      numericType: 'Fraction',
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      error: { data: { reason: 'fraction_unsupported' } },
    });
    expect(textOf(failed)).toContain('reason fraction_unsupported');
  });

  it.each([
    // Its 64-bit float would read as exact: 1, 1, 0, 1, 94906265, [94906265, -94906265].
    '(2+0i)^(1/10^30)',
    '(1+i)^(1/10^400)',
    '(2+0i)^(-10^400)',
    '(1/2+0i)^(1/10^30)',
    'sqrt(9007199136250226 + 0i)',
    'nthRoots(9007199136250226 + 0i, 2)',
    // Element-wise, and inside a callback.
    '[2+0i, 3+0i] .^ (1/10^30)',
    'map([2+0i], f(z) = z^(1/10^30))',
  ])(
    '%s, a complex power or root with no exact value, fails with fraction_unsupported',
    (expression) => {
      const { reason, message } = failure(expression);
      expect(reason).toBe('fraction_unsupported');
      expect(message).toContain('no exact rational value');
    },
  );

  it.each([
    // math.js's float power is -6575858790128649 - 8236061563332085i.
    ['(-60-6i)^9', '-6575858790128640 - 8236061563332096i'],
    ['(1+2i)^2', '-3 + 4i'],
    ['(3+4i)^3', '-117 + 44i'],
    ['i^(10^400)', '1'],
    ['i^(-1)', '-i'],
    ['(4+0i)^(1/2)', '2'],
    ['(-4+0i)^(1/2)', '2i'],
    ['(9+0i)^(3/2)', '27'],
    ['sqrt(5+12i)', '3 + 2i'],
    ['sqrt(-4+0i)', '2i'],
    ['cbrt(2+11i)', '2 + i'],
    ['(1+2i)*(3+4i)', '-5 + 10i'],
  ])('%s → %s, an exact Gaussian integer', (expression, expected) => {
    expect(evaluate(expression)).toEqual({ result: expected, resultType: 'Complex' });
  });

  it('settles every root of a list', () => {
    expect(evaluate('nthRoots(16+0i, 4)').result).toBe('[2, 2i, -2, -2i]');
    expect(evaluate('[1+i, 2+0i] .^ 2').result).toBe('[2i, 4]');
  });

  it.each(['(1+i)^(10^400)', '(1+i)^(10^20 + 0i)'])(
    '%s, a Gaussian integer power far past the safe range, fails without multiplying it out',
    (expression) => {
      // Raised one factor at a time, the power would run until the evaluation timeout.
      expect(failure(expression).reason).toBe('undefined_result');
    },
  );

  it.each(['(2+0i)^(1/2)', 'i^(1/2)', 'cbrt(-8+0i)', '(1/2 + 1/2 i)^2', 'nthRoots(8, 3)'])(
    '%s keeps its visibly inexact float, reported as one',
    (expression) => {
      const { reason, message } = failure(expression);
      expect(reason).toBe('fraction_unsupported');
      expect(message).toContain('64-bit float');
    },
  );

  it.each([
    ['number(4)^2', '16/1', 'Fraction'],
    ['number(4)^(1/2)', '2/1', 'Fraction'],
    ['polynomialRoot(-6, 11, -6, 1)', '[1, 3, 2]', 'Array'],
    ['polynomialRoot(1, 0, 1)', '[i, -i]', 'Array'],
  ] as const)('%s → %s, as before the complex signatures', (expression, result, resultType) => {
    expect(evaluate(expression)).toEqual({ result, resultType });
  });

  it.each(['0^(-1/2)', '0^(-1)', '0^(-10^30)'])(
    '%s, a negative power of zero, keeps undefined_result',
    (expression) => {
      expect(failure(expression).reason).toBe('undefined_result');
    },
  );

  it('classifies a failure re-wrapped by a callback', () => {
    expect(evaluate('map([4, 9], sqrt)').result).toBe('[2/1, 3/1]');
    expect(failure('map([4, 2], sqrt)').reason).toBe('fraction_unsupported');
    expect(failure('map([1, 0], gamma)').reason).toBe('undefined_result');
  });
});

describe('sqrtm under Fraction', () => {
  it.each([
    ['sqrtm([4, 0; 0, 9])', '[[2/1, 0/1], [0/1, 3/1]]'],
    ['sqrtm([5, 4; 4, 5])', '[[2/1, 1/1], [1/1, 2/1]]'],
    ['sqrtm([33, 24; 48, 57])', '[[5/1, 2/1], [4/1, 7/1]]'],
    ['sqrtm([1, 0; 0, 1])', '[[1/1, 0/1], [0/1, 1/1]]'],
    ['sqrtm([[4]])', '[[2/1]]'],
    ['sqrtm([4])', '[2/1]'],
  ])('%s → %s, its exact root', (expression, expected) => {
    expect(evaluate(expression)).toEqual({ result: expected, resultType: 'DenseMatrix' });
  });

  it.each(['sqrtm([2, 0; 0, 2])', 'sqrtm([1, 1; 1, 2])', 'sqrtm([2])'])(
    '%s has no rational root and fails with fraction_unsupported',
    (expression) => {
      expect(failure(expression).reason).toBe('fraction_unsupported');
    },
  );
});

describe('result size under Fraction', () => {
  it('cancels intermediates larger than the result limit', () => {
    expect(evaluate('10000! / 9999!').result).toBe('10000/1');
    expect(evaluate('30000! / 29999!').result).toBe('30000/1');
  });

  it('returns the largest factorial that fits the default result limit', () => {
    // 25205! has 99,996 digits; "/1" makes 99,998 characters.
    expect(evaluate('25205!').result).toHaveLength(99_998);
    expect(failure('25206!').reason).toBe('result_too_large');
  });

  it('fails a factorial of more than 1,000,000 digits before computing it', () => {
    evaluate('5!');
    const { reason, message, cpuMs } = failure('300000!');
    expect(reason).toBe('result_too_large');
    // 300000! has 1,512,852 digits.
    expect(message).toContain('factorial() would build 1,512,852 characters');
    expect(cpuMs).toBeLessThan(20);
  });

  it('fails a power of more than 1,000,000 digits before computing it', () => {
    evaluate('2^2');
    // 2^(10^7) has 3,010,300 digits.
    const integer = failure('2^(10^7)');
    expect(integer.reason).toBe('result_too_large');
    expect(integer.message).toContain('pow() would build 3,010,300 characters');
    expect(integer.cpuMs).toBeLessThan(20);
    // Numerator 9^(5 * 10^6) has 4,771,213 digits and denominator 4^(5 * 10^6) 3,010,300.
    const rational = failure('(9/4)^(5 * 10^6)');
    expect(rational.reason).toBe('result_too_large');
    expect(rational.message).toContain('pow() would build 7,781,513 characters');
    expect(rational.cpuMs).toBeLessThan(20);
  });

  it('counts numerator and denominator digits toward the limit', () => {
    // (4/9)^(-10^6): 9^(10^6) has 954,243 digits and 4^(10^6) 602,060.
    const { reason, message, cpuMs } = failure('nthRoot(4/9, -1/10^6)');
    expect(reason).toBe('result_too_large');
    expect(message).toContain('nthRoot() would build 1,556,303 characters');
    expect(cpuMs).toBeLessThan(20);
  });

  it('builds a large rational power without reducing it', { timeout: 0 }, () => {
    // 2^(10^6) has 301,030 digits and 3^(10^6) 477,122: inside the per-call digit
    // limit, outside the default result limit.
    const { reason, message, cpuMs } = failure('(2/3)^(10^6)');
    expect(reason).toBe('result_too_large');
    expect(message).toContain('Result exceeds maximum size');
    expect(cpuMs).toBeLessThan(2000);
    const service = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 30_000,
      maxResultLength: 1_000_000,
    });
    expect(evaluate('(2/3)^(10^6)', 'Fraction', undefined, service).result).toHaveLength(778_153);
    expect(evaluate('nthRoot((2/3)^(10^6), 10^6)', 'Fraction', undefined, service).result).toBe(
      '2/3',
    );
  });

  it.each([
    ['2^(10^9)', 'pow()'],
    ['2^(10^10)', 'pow()'],
    ['(-2)^(10^9 + 1)', 'pow()'],
    ['2^(-10^9)', 'pow()'],
    ['(2/3)^(10^7)', 'pow()'],
    ['(1/2)^(-10^30)', 'pow()'],
    ['4^((10^9 + 1)/2)', 'pow()'],
    ['(9/4)^(-(10^7 + 1)/2)', 'pow()'],
    ['2 .^ (10^9)', 'pow()'],
    ['(10^20)!', 'factorial()'],
    ['(10^400)!', 'factorial()'],
    ['gamma(10^20)', 'gamma()'],
    ['permutations(10^7, 10^6)', 'permutations()'],
    ['combinations(10^20, 10^6)', 'combinations()'],
    ['combinations(10^7, 5 * 10^6)', 'combinations()'],
    ['combinations(10^400, 10^6)', 'combinations()'],
    ['catalan(10^7)', 'catalan()'],
    ['catalan(10^400)', 'catalan()'],
    ['composition(10^7, 5 * 10^6)', 'composition()'],
    ['multinomial([10^6, 10^6, 10^6])', 'multinomial()'],
    ['nthRoot(4, 1/10^7)', 'nthRoot()'],
    ['nthRoot([4, 9], 1/10^7)', 'nthRoot()'],
    ['nthRoot(4, [2, 1/10^7])', 'nthRoot()'],
  ])('%s fails with result_too_large before computing', (expression, fn) => {
    const { reason, message } = failure(expression);
    expect(reason).toBe('result_too_large');
    expect(message).toContain(fn);
  });

  it('returns a binomial of a huge n with a small k', () => {
    expect(evaluate('combinations(10^400, 2) - (10^400) * (10^400 - 1) / 2').result).toBe('0/1');
  });

  it.each(['combinations(2^41, 2^41 - 3 * 10^6)', 'composition(2^41 + 1, 2^41 - 3 * 10^6 + 1)'])(
    'sizes %s by its smaller side, k = 3 * 10^6',
    (expression) => {
      // C(2^41, 2^41 − k) = C(2^41, k) ≥ (2^41 / k)^k, which has over 17,500,000 digits.
      const { reason, message } = failure(expression);
      expect(reason).toBe('result_too_large');
      const built = /would build ([\d,]+) characters/.exec(message)?.[1];
      expect(Number(built?.replaceAll(',', ''))).toBeGreaterThan(17_500_000);
    },
  );

  it('checks the per-call digit limit, not the result limit', { timeout: 0 }, () => {
    const service = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 30_000,
      maxResultLength: 1_000_000,
    });
    // 205021! has 999,994 digits, 205022! exactly 1,000,000, and 205023! 1,000,005.
    expect(evaluate('205021!', 'Fraction', undefined, service).result).toHaveLength(999_996);
    const atLimit = failure('205022!', 'Fraction', service);
    expect(atLimit.reason).toBe('result_too_large');
    expect(atLimit.message).toContain('Result exceeds maximum size');
    const pastLimit = failure('205023!', 'Fraction', service);
    expect(pastLimit.reason).toBe('result_too_large');
    expect(pastLimit.message).toContain('factorial() would build 1,000,005 characters');
  });

  it('charges the digits to the evaluation budget', { timeout: 0 }, () => {
    const service = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 30_000,
      maxResultLength: 100_000,
    });
    // Twenty-one factorials of 999,994 digits pass 20,000,000 in total.
    const { reason, message } = failure('factorial(205021 * ones(21))', 'Fraction', service);
    expect(reason).toBe('result_too_large');
    expect(message).toContain('in total while evaluating');
  });

  it('charges a power through an exact root to the evaluation budget', () => {
    // 4^(3321001/2) is 2^3321001, of 999,721 digits: twenty-one pass 20,000,000.
    const { reason, message } = failure('4 .^ (3321001/2 * ones(21))');
    expect(reason).toBe('result_too_large');
    expect(message).toContain('in total while evaluating');
  });

  it('charges the power an nthRoot takes to the evaluation budget', () => {
    // nthRoot(4, 2/3321001) = 2^3321001, of 999,721 digits: twenty fit 20,000,000, twenty-one do not.
    expect(evaluate('sum(map(ones(20), f(k) = nthRoot(4, 2/3321001))) > 0').result).toBe('true');
    const { reason, message } = failure('map(ones(21), f(k) = nthRoot(4, 2/3321001) > 0)');
    expect(reason).toBe('result_too_large');
    expect(message).toContain('in total while evaluating');
  });

  it.each(['Fraction', 'number'] as const)(
    'checks the broadcast of two collections against the per-call limit under %s',
    (numericType) => {
      evaluate('nthRoot(4, 2)', numericType);
      // A 2000×1 and a 1×2000 operand broadcast to 4,000,000 roots.
      const { reason, message, cpuMs } = failure(
        'nthRoot(transpose([range(1, 2000)]), range(1, 2000))',
        numericType,
      );
      expect(reason).toBe('result_too_large');
      expect(message).toContain('nthRoot() would build 4,000,000 elements');
      expect(cpuMs).toBeLessThan(200);
    },
  );

  it.each([
    ['Fraction', '43600/1'],
    ['number', '43600'],
  ] as const)(
    'charges the roots of a collection to the evaluation budget under %s',
    (numericType, sum) => {
      // The six full zeros matrices and the 1000×600 one charge their elements
      // three times each (built, grown, returned), 19,800,000 in all. ones(s)
      // charges s three times, and nthRoot charges its s roots twice, as built
      // and as returned: s = 30,000 fits the 20,000,000 budget and s = 45,000 does
      // not. Uncharged as built, nthRoot would let s reach about 50,000.
      const filler = Array(6).fill('sum(size(zeros(1000, 1000)))').join(' + ');
      const roots = (s: number) =>
        `${filler} + sum(size(zeros(1000, 600))) + sum(nthRoot(ones(${s}), 2))`;
      expect(evaluate(roots(30_000), numericType).result).toBe(sum);
      const { reason, message } = failure(roots(45_000), numericType);
      expect(reason).toBe('result_too_large');
      expect(message).toContain('in total while evaluating');
    },
  );

  it('keeps an integer power off the evaluation budget', () => {
    // The powers k^50 for k = 1..10^5 hold 22,878,297 digits, past 20,000,000 if charged.
    let expected = 0n;
    for (let k = 1n; k <= 100_000n; k++) expected += k ** 50n;
    expect(evaluate('sum(range(1, 10^5) .^ 50)').result).toBe(`${expected}/1`);
  });
});

describe('other numeric types are unchanged', () => {
  it.each([
    ['10!', 'number', '3628800', 'number'],
    ['combinations(10, 3)', 'number', '120', 'number'],
    ['sqrt(4)', 'number', '2', 'number'],
    ['cbrt(-8)', 'number', '-2', 'number'],
    ['(1/2)!', 'number', '0.8862269254527576', 'number'],
    ['sqrtm([4, 0; 0, 9])', 'number', '[[2, 0], [0, 3]]', 'DenseMatrix'],
    ['nthRoot([4, 9], 2)', 'number', '[2, 3]', 'DenseMatrix'],
    ['nthRoot([4, 9])', 'number', '[2, 3]', 'DenseMatrix'],
    ['nthRoot(16, [2, 4])', 'number', '[4, 2]', 'DenseMatrix'],
    ['nthRoot([16; 81], [2, 4])', 'number', '[[4, 2], [9, 3]]', 'DenseMatrix'],
    ['nthRoot(2, [4, 9])', 'number', '[1.189207115002721, 1.080059738892306]', 'DenseMatrix'],
    ['nthRoot([4, 9].valueOf(), 2)', 'number', '[2, 3]', 'Array'],
    [
      'nthRoot(sparse([4, 0]), -2)',
      'number',
      'Sparse Matrix [2 x 1] density: 0.5\n\n    (0, 0) ==> 0.5',
      'SparseMatrix',
    ],
    ['10!', 'BigNumber', '3628800', 'BigNumber'],
    ['nthRoot([4, 9], 2)', 'BigNumber', '[2, 3]', 'DenseMatrix'],
    ['nthRoot([4, 9])', 'BigNumber', '[2, 3]', 'DenseMatrix'],
    ['nthRoot(16, [2, 4])', 'BigNumber', '[4, 2]', 'DenseMatrix'],
    ['sqrt(4)', 'BigNumber', '2', 'BigNumber'],
    [
      '10000! / 9999!',
      'BigNumber',
      '9999.999999999999999999999999999999999999999999999999999999999996',
      'BigNumber',
    ],
  ] as const)('%s under %s → %s', (expression, numericType, result, resultType) => {
    expect(evaluate(expression, numericType)).toEqual({ result, resultType });
  });
});

describe('fractionFailureIn', () => {
  it('reads the reason from the error', () => {
    expect(fractionFailureIn(new FractionResultError('fraction_unsupported', 'sqrt(2)'))).toBe(
      'fraction_unsupported',
    );
    expect(fractionFailureIn(new FractionResultError('undefined_result', 'gamma(0)'))).toBe(
      'undefined_result',
    );
  });

  it('reads the reason from a message that embeds the error', () => {
    const inner = new FractionResultError('undefined_result', 'gamma has a pole at 0.');
    const wrapped = new TypeError(
      `Function map cannot apply callback arguments to function gamma: ${inner.message}`,
    );
    expect(fractionFailureIn(wrapped)).toBe('undefined_result');
  });

  it('returns undefined for any other error', () => {
    expect(fractionFailureIn(new Error('Value must be non-negative'))).toBeUndefined();
    expect(fractionFailureIn('Division by Zero')).toBeUndefined();
  });

  it('is consulted only under numericType "Fraction"', () => {
    expect(failure('number("No exact Fraction result: x")', 'number').reason).toBe(
      'evaluation_failed',
    );
  });
});
