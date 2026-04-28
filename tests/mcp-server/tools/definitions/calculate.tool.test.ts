/**
 * @fileoverview Tests for the calculate tool.
 * @module mcp-server/tools/definitions/calculate.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { initMathService, MathService } from '@/services/math/math-service.js';

function parse(input: Record<string, unknown>) {
  return calculateTool.input.parse(input);
}

function mockCtx() {
  return createMockContext({ errors: calculateTool.errors });
}

function call(input: Record<string, unknown>) {
  return Promise.resolve(calculateTool.handler(parse(input), mockCtx()));
}

function expectMcpError(fn: () => unknown, code: JsonRpcErrorCode, reason: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(McpError);
  expect((caught as McpError).code).toBe(code);
  expect((caught as McpError).data?.reason).toBe(reason);
}

beforeAll(() => {
  initMathService(getServerConfig());
});

describe('calculate tool', () => {
  describe('evaluate (default)', () => {
    it('evaluates basic arithmetic', async () => {
      const result = await call({ expression: '2 + 3 * 4' });
      expect(result).toEqual({ result: '14', resultType: 'number', expression: '2 + 3 * 4' });
    });

    it('evaluates trigonometric functions', async () => {
      const result = await call({ expression: 'sin(pi / 2)' });
      expect(result).toEqual({ result: '1', resultType: 'number', expression: 'sin(pi / 2)' });
    });

    it('evaluates with variable scope', async () => {
      const result = await call({ expression: 'a^2 + b^2', scope: { a: 3, b: 4 } });
      expect(result).toEqual({ result: '25', resultType: 'number', expression: 'a^2 + b^2' });
    });

    it('evaluates unit conversion', async () => {
      const result = await call({ expression: '100 celsius to fahrenheit' });
      expect(result.resultType).toBe('Unit');
      expect(result.result).toContain('fahrenheit');
    });

    it('evaluates matrix operations', async () => {
      const result = await call({ expression: 'det([1, 2; 3, 4])' });
      expect(result).toEqual({
        result: '-2',
        resultType: 'number',
        expression: 'det([1, 2; 3, 4])',
      });
    });

    it('evaluates statistics functions', async () => {
      const result = await call({ expression: 'mean([85, 90, 78, 92, 88])' });
      expect(result.result).toBe('86.6');
    });

    it('evaluates complex numbers', async () => {
      const result = await call({ expression: 'sqrt(-4)' });
      expect(result.result).toBe('2i');
      expect(result.resultType).toBe('Complex');
    });

    it('applies precision parameter', async () => {
      const result = await call({ expression: '1 / 3', precision: 4 });
      expect(result.result).toBe('0.3333');
    });

    it('ignores blank precision values from form-based clients', async () => {
      const result = await call({ expression: '1 / 3', precision: '' });
      expect(result.result).toBe('0.3333333333333333');
    });

    it('ignores blank variable values for non-derivative operations', async () => {
      const result = await call({ expression: '2 + 2', operation: 'evaluate', variable: '' });
      expect(result).toEqual({ result: '4', resultType: 'number', expression: '2 + 2' });
    });

    it('throws for 1/0 (Infinity)', () => {
      expect(() => calculateTool.handler(parse({ expression: '1 / 0' }), mockCtx())).toThrow(
        'mathematically undefined',
      );
    });

    it('throws for 0/0 (NaN)', () => {
      expect(() => calculateTool.handler(parse({ expression: '0 / 0' }), mockCtx())).toThrow(
        'mathematically undefined',
      );
    });
  });

  describe('simplify', () => {
    it('simplifies algebraic expressions', async () => {
      const result = await call({ expression: '2x + 3x', operation: 'simplify' });
      expect(result).toEqual({
        result: '5 * x',
        resultType: 'string',
        expression: '2x + 3x',
      });
    });

    it('simplifies polynomial expressions', async () => {
      const result = await call({ expression: '2x + 3x + x^2 - x^2', operation: 'simplify' });
      expect(result.result).toBe('5 * x');
    });

    it('applies Pythagorean identity', async () => {
      const result = await call({ expression: 'sin(x)^2 + cos(x)^2', operation: 'simplify' });
      expect(result.result).toBe('1');
    });

    it('simplifies 1 - sin^2 to cos^2', async () => {
      const result = await call({ expression: '1 - sin(x)^2', operation: 'simplify' });
      expect(result.result).toBe('cos(x) ^ 2');
    });

    it('simplifies double-angle identity', async () => {
      const result = await call({ expression: '2 * sin(x) * cos(x)', operation: 'simplify' });
      expect(result.result).toBe('sin(2 * x)');
    });

    it('simplifies tan^2 + 1 to sec^2', async () => {
      const result = await call({ expression: 'tan(x)^2 + 1', operation: 'simplify' });
      expect(result.result).toBe('sec(x) ^ 2');
    });
  });

  describe('derivative', () => {
    it('computes symbolic derivatives', async () => {
      const result = await call({
        expression: '3*x^2 + 2*x + 1',
        operation: 'derivative',
        variable: 'x',
      });
      expect(result.resultType).toBe('string');
      expect(result.result).toContain('x');
    });

    it('throws when variable is missing', () => {
      expect(() =>
        calculateTool.handler(parse({ expression: 'x^2', operation: 'derivative' }), mockCtx()),
      ).toThrow("The 'variable' parameter is required");
    });

    it('treats blank variable values as missing for derivative operations', () => {
      expect(() =>
        calculateTool.handler(
          parse({ expression: 'x^2', operation: 'derivative', variable: '' }),
          mockCtx(),
        ),
      ).toThrow("The 'variable' parameter is required");
    });
  });

  describe('error handling', () => {
    it('rejects expressions exceeding max length', () => {
      const longExpr = '1 +'.repeat(500);
      expect(() => calculateTool.handler(parse({ expression: longExpr }), mockCtx())).toThrow(
        'exceeds maximum length',
      );
    });

    it('rejects multiple expressions separated by semicolons', () => {
      expect(() => calculateTool.handler(parse({ expression: '1 + 2; 3 + 4' }), mockCtx())).toThrow(
        'Multiple expressions are not allowed',
      );
    });

    it('rejects invalid syntax', () => {
      expect(() => calculateTool.handler(parse({ expression: '2 +* 3' }), mockCtx())).toThrow();
    });

    it('rejects disabled functions in expressions', () => {
      expect(() =>
        calculateTool.handler(parse({ expression: 'evaluate("2+3")' }), mockCtx()),
      ).toThrow('disabled');
    });

    it('rejects unknown functions', () => {
      expect(() => calculateTool.handler(parse({ expression: 'foo(5)' }), mockCtx())).toThrow();
    });
  });

  describe('format', () => {
    it('renders all output fields', () => {
      const formatted = calculateTool.format?.({
        result: '42',
        resultType: 'number',
        expression: '6 * 7',
      });
      expect(formatted).toEqual([
        {
          type: 'text',
          text: '**Expression:** `6 * 7`\n**Result:** 42\n**Type:** number',
        },
      ]);
    });
  });

  /**
   * Wire-shape conformance: every contract entry in `calculateTool.errors`
   * must be reachable, and the thrown `McpError` must carry the declared
   * `code` and `data.reason`. The contract conformance lint can't see
   * service-layer throws, so this suite is the compensating control.
   */
  describe('error contract wire-shape', () => {
    it('empty_expression', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '   ' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'empty_expression',
      );
    });

    it('expression_too_long', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '1+'.repeat(700) }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'expression_too_long',
      );
    });

    it('multiple_expressions', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '1 + 2; 3 + 4' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'multiple_expressions',
      );
    });

    it('reserved_scope_key', () => {
      expectMcpError(
        () =>
          calculateTool.handler(parse({ expression: 'x', scope: { constructor: 0 } }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'reserved_scope_key',
      );
    });

    it('disallowed_result_type', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: 'f(x) = x^2' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'disallowed_result_type',
      );
    });

    it('result_too_large', () => {
      // Construct a service with a tiny maxResultLength to trigger this deterministically.
      const svc = new MathService({
        maxExpressionLength: 1000,
        evaluationTimeoutMs: 5000,
        maxResultLength: 5,
      });
      expectMcpError(
        () => svc.evaluateExpression('123456789'),
        JsonRpcErrorCode.ValidationError,
        'result_too_large',
      );
    });

    it('undefined_result', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '1 / 0' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'undefined_result',
      );
    });

    it('parse_failed', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '2 +* 3' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'parse_failed',
      );
    });

    it('derivative_missing_variable', () => {
      expectMcpError(
        () =>
          calculateTool.handler(parse({ expression: 'x^2', operation: 'derivative' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'derivative_missing_variable',
      );
    });

    it('evaluation_timeout', () => {
      // Tight timeout (1ms) + an expensive matrix op forces the vm to abort.
      const svc = new MathService({
        maxExpressionLength: 10_000,
        evaluationTimeoutMs: 1,
        maxResultLength: 1_000_000,
      });
      expectMcpError(
        () => svc.evaluateExpression('eigs(zeros(50, 50))'),
        JsonRpcErrorCode.ServiceUnavailable,
        'evaluation_timeout',
      );
    });
  });
});
