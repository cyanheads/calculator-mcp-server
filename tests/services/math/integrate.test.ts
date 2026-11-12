/**
 * @fileoverview Tests for `integrate` / `integral`, the numeric definite integral,
 * run through MathService so the parse-time checks, element metering, and timeout
 * apply.
 * @module tests/services/math/integrate.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { MathService } from '@/services/math/math-service.js';
import type { NumericType } from '@/services/math/types.js';

const CONFIG = { maxExpressionLength: 1000, evaluationTimeoutMs: 5000, maxResultLength: 100_000 };
const service = new MathService(CONFIG);

interface Options {
  numericType?: NumericType;
  precision?: number;
  scope?: Record<string, number>;
}

/** The result string of an evaluation. */
function evaluate(expression: string, { numericType, precision, scope }: Options = {}): string {
  return service.evaluateExpression(expression, scope, precision, numericType).result;
}

/** The McpError an evaluation throws. */
function failure(
  expression: string,
  { numericType, scope }: Options = {},
  svc = service,
): McpError {
  try {
    svc.evaluateExpression(expression, scope, undefined, numericType);
  } catch (err) {
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }
  throw new Error(`Expected ${expression} to fail`);
}

describe('integrate', () => {
  it.each([
    ['integrate(exp(-x^2), x, 0, 1)', { precision: 12 }, '0.746824132812'],
    ['integrate(1/x, x, 1, e)', { precision: 15 }, '1'],
    ['integrate(a*x^2, x, 0, 3)', { scope: { a: 2 } }, '18'],
    ['log10(integrate(exp(-x^2), x, 0, 1))', { precision: 12 }, '-0.126781656741'],
    ['integrate(1/sqrt(x), x, 0, 1)', { precision: 9 }, '2'],
    ['integrate(x^2, x, 1, 0)', { precision: 15 }, '-0.333333333333333'],
    ['integrate(ln(x), x, 1, e)', { precision: 15 }, '1'],
    ['integrate(x^2, x, 2, 2)', {}, '0'],
    ['integrate(x^2, x, 0, 1)', {}, '0.3333333333333333'],
    ['integrate(x^-0.9, x, 0, 1)', { precision: 6 }, '10'],
    ['integrate(sin(x), x, 0, pi)', { precision: 15 }, '2'],
    ['integrate(0, x, 0, 1)', {}, '0'],
  ] as const)('%s with %j => %s', (expression, options, result) => {
    expect(evaluate(expression, options)).toBe(result);
  });

  it('matches under the integral alias', () => {
    for (const [expression, options] of [
      ['exp(-x^2), x, 0, 1', { precision: 12 }],
      ['a*x^2, x, 0, 3', { scope: { a: 2 } }],
      ['x^2, x, 1, 0', {}],
    ] as const) {
      expect(evaluate(`integral(${expression})`, options)).toBe(
        evaluate(`integrate(${expression})`, options),
      );
    }
    expect(evaluate('integral(exp(-x^2), x, 0, 1)', { precision: 12 })).toBe('0.746824132812');
  });

  it('converges on an integral that cancels to zero', () => {
    expect(Math.abs(Number(evaluate('integrate(sin(x), x, 0, 2 pi)')))).toBeLessThan(1e-12);
  });

  describe('scope', () => {
    it('binds the variable over a scope value of the same name', () => {
      expect(evaluate('integrate(x^2, x, 0, 1)', { scope: { x: 5 }, precision: 15 })).toBe(
        '0.333333333333333',
      );
    });

    it('evaluates the bounds in the caller scope', () => {
      expect(evaluate('integrate(t, t, a, b)', { scope: { a: 0, b: 2 } })).toBe('2');
    });

    it('accepts BigNumber and Fraction bounds and samples under numericType "number"', () => {
      expect(evaluate('integrate(x, x, bignumber(0), bignumber(2))')).toBe('2');
      expect(evaluate('integrate(fraction(1, 2), x, 0, 2)')).toBe('1');
    });

    it('keeps a scope value named integrate', () => {
      expect(evaluate('integrate * 2', { scope: { integrate: 3 } })).toBe('6');
    });
  });

  describe('nesting', () => {
    it('integrates an integral, the inner integrand reading the outer variable', () => {
      expect(evaluate('integrate(integrate(x*y, y, 0, 1), x, 0, 1)', { precision: 15 })).toBe(
        '0.25',
      );
      expect(evaluate('integrate(integrate(x + y, y, 0, x), x, 0, 1)', { precision: 15 })).toBe(
        '0.5',
      );
    });

    it('reads the parameter of a user-defined function it is called from', () => {
      expect(evaluate('map([1, 2, 3], f(k) = integrate(x^k, x, 0, 1))')).toBe(
        '[0.5, 0.3333333333333333, 0.25]',
      );
    });
  });

  describe('failures name the cause', () => {
    it.each([
      ['integrate(1/x, x, -1, 1)', 'non-finite integrand (Infinity) at x = 0'],
      ['integrate(sin(x)/x, x, -1, 1)', 'non-finite integrand (NaN) at x = 0'],
      [
        'integrate(1/x, x, 0, 1)',
        'did not converge: after 500 subintervals the error estimate is 1.85, above the relative tolerance of 1e-10',
      ],
      ['integrate(abs(sin(x)), x, 0, 100 pi)', 'did not converge: after 500 subintervals'],
      ['integrate(exp(-x), x, 0, Infinity)', 'needs finite bounds; got [0, Infinity]'],
      ['integrate(x, x, NaN, 1)', 'needs finite bounds; got [NaN, 1]'],
      ['integrate(1e308, x, 0, 10)', 'passes the 64-bit floating-point range'],
      [
        'integrate(sqrt(x), x, -1, 1)',
        'needs the integrand at x = -0.9914553711208126 to be a real number; got a Complex',
      ],
      ['integrate(x m, x, 0, 1)', 'to be a real number; got a Unit'],
      ['integrate([x, x], x, 0, 1)', 'to be a real number; got a DenseMatrix'],
      ['integrate(x > 0.5, x, 0, 1)', 'to be a real number; got a boolean'],
      ['integrate(x, x, 0, 2 m)', 'needs the upper bound to be a real number; got a Unit'],
      ['integrate(x, x, 1i, 1)', 'needs the lower bound to be a real number; got a Complex'],
      ['integrate("x^2", x, 0, 1)', 'takes the integrand unquoted'],
      ['integrate(x^2, 2, 0, 1)', 'takes the integration variable as a bare name'],
      ['integrate(x^2, x, 0)', 'takes 4 arguments (integrand, variable, lower bound, upper bound)'],
      ['map([1, 2], integrate)', 'must be called directly'],
      ['apply([[1, 2]], 1, integrate)', 'must be called directly'],
    ])('%s fails with evaluation_failed', (expression, detail) => {
      const err = failure(expression);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain(detail);
    });
  });

  describe('numeric types', () => {
    const hint = 'Retry with numericType "number"; integrate() is available only there.';

    it('fails under Fraction with fraction_unsupported and the retry hint', () => {
      const err = failure('integrate(x^2, x, 0, 1)', { numericType: 'Fraction' });
      expect(err.data?.reason).toBe('fraction_unsupported');
      expect(err.data?.recovery).toEqual({ hint });
    });

    it('fails under BigNumber with evaluation_failed and the retry hint', () => {
      const err = failure('integrate(x^2, x, 0, 1)', { numericType: 'BigNumber' });
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.data?.recovery).toEqual({ hint });
    });
  });

  describe('bounds', () => {
    it('stops after 500 subintervals, 14,985 samples', () => {
      // The integrand counts its samples in n and turns non-finite past the limit-th one.
      const counted = (limit: number) =>
        `integrate(1/x + ((n = n + 1) > ${limit} ? 1/0 : 0), x, 0, 1)`;
      expect(failure(counted(14_985), { scope: { n: 0 } }).message).toContain(
        'did not converge: after 500 subintervals',
      );
      expect(failure(counted(14_984), { scope: { n: 0 } }).message).toContain(
        'sampled a non-finite integrand (Infinity)',
      );
    });

    it('charges the collections each sample builds to the element budget', () => {
      expect(failure('integrate(sum(ones(100000)) / sqrt(x), x, 0, 1)').data?.reason).toBe(
        'result_too_large',
      );
    });

    it('charges an object literal in the integrand on every sample', () => {
      // An object literal is charged only by the element metering on its own parse
      // node, a string value by its length, while building it costs the same at any
      // length: 5,000 characters a sample pass the 20,000,000 budget after about 4,000
      // of the cap's 14,985 samples, milliseconds of work, far inside the timeout.
      const wide = new MathService({ ...CONFIG, maxExpressionLength: 10_000 });
      const literal = `{a: 1, s: "${'x'.repeat(5000)}"}`;
      expect(failure(`integrate(0 * ${literal}.a + 1/x, x, 0, 1)`, {}, wide).data?.reason).toBe(
        'result_too_large',
      );
      // One 15-sample pass converges: the literal alone stays far under the budget.
      expect(wide.evaluateExpression(`integrate(0 * ${literal}.a + x, x, 0, 1)`).result).toBe(
        '0.5',
      );
    });

    it('stops at the evaluation timeout and the service keeps working', () => {
      const short = new MathService({ ...CONFIG, evaluationTimeoutMs: 50 });
      const err = failure(
        'integrate(integrate(integrate(1/sqrt(x*y*z), z, 0, 1), y, 0, 1), x, 0, 1)',
        {},
        short,
      );
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data?.reason).toBe('evaluation_timeout');
      expect(short.evaluateExpression('integrate(x^2, x, 0, 3)').result).toBe('9');
    });
  });

  describe('parse-time checks reach the integrand', () => {
    it.each([
      ['integrate(derivative(x^2, x), x, 0, 1)', 'operation_as_function'],
      ['integrate(cos.toString(), x, 0, 1)', 'disallowed_result_type'],
      ['integrate(x^2, x, 0, 1); 2', 'multiple_expressions'],
    ])('%s => %s', (expression, reason) => {
      expect(failure(expression).data?.reason).toBe(reason);
    });
  });

  describe('symbolic operations', () => {
    it('leaves an integral unchanged under simplify', () => {
      expect(service.simplifyExpression('integrate(x^2, x, 0, 1)')).toEqual({
        result: 'integrate(x ^ 2, x, 0, 1)',
        resultType: 'string',
        unchanged: true,
      });
    });

    it('treats an integral over another variable as a constant factor in a derivative', () => {
      expect(service.differentiateExpression('integrate(t^2, t, 0, 1) * x', 'x').result).toBe(
        'integrate(t ^ 2, t, 0, 1)',
      );
    });

    it('has no derivative rule for an integral over the differentiation variable', () => {
      let caught: unknown;
      try {
        service.differentiateExpression('integrate(x^2, x, 0, 1)', 'x');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(McpError);
      expect((caught as McpError).data?.reason).toBe('evaluation_failed');
      expect((caught as McpError).message).toContain('no rule for the function "integrate"');
    });
  });

  it('keeps no state across calls', () => {
    // An integrand that needs many bisections, so a leftover subinterval would show.
    const probe = 'integrate(1/sqrt(x), x, 0, 4)';
    const fresh = new MathService(CONFIG);
    expect(fresh.evaluateExpression(probe, undefined, 9).result).toBe('4');
    const unrounded = fresh.evaluateExpression(probe).result;
    const primed = new MathService(CONFIG);
    // Calls that stop at the subinterval cap, at a non-finite sample, and partway
    // through the integration at the element budget.
    for (const expression of [
      'integrate(1/x, x, 0, 1)',
      'integrate(1/x, x, -1, 1)',
      'integrate(sum(ones(100000)) / sqrt(x), x, 0, 1)',
    ]) {
      expect(() => primed.evaluateExpression(expression)).toThrow(McpError);
    }
    primed.evaluateExpression('integrate(exp(-x^2), x, -3, 3)');
    expect(primed.evaluateExpression(probe).result).toBe(unrounded);
    expect(primed.evaluateExpression(probe, undefined, 9).result).toBe('4');
  });
});
