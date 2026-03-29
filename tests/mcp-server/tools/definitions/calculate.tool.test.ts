/**
 * @fileoverview Tests for the calculate tool.
 * @module mcp-server/tools/definitions/calculate.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { initMathService } from '@/services/math/math-service.js';

function parse(input: Record<string, unknown>) {
  return calculateTool.input.parse(input);
}

function call(input: Record<string, unknown>) {
  return Promise.resolve(calculateTool.handler(parse(input), createMockContext()));
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

    it('returns Infinity for 1/0', async () => {
      const result = await call({ expression: '1 / 0' });
      expect(result.result).toBe('Infinity');
    });

    it('returns NaN for 0/0', async () => {
      const result = await call({ expression: '0 / 0' });
      expect(result.result).toBe('NaN');
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
        calculateTool.handler(
          parse({ expression: 'x^2', operation: 'derivative' }),
          createMockContext(),
        ),
      ).toThrow("The 'variable' parameter is required");
    });
  });

  describe('error handling', () => {
    it('rejects expressions exceeding max length', () => {
      const longExpr = '1 +'.repeat(500);
      expect(() =>
        calculateTool.handler(parse({ expression: longExpr }), createMockContext()),
      ).toThrow('exceeds maximum length');
    });

    it('rejects semicolons', () => {
      expect(() =>
        calculateTool.handler(parse({ expression: '1 + 2; 3 + 4' }), createMockContext()),
      ).toThrow('semicolons');
    });

    it('rejects invalid syntax', () => {
      expect(() =>
        calculateTool.handler(parse({ expression: '2 +* 3' }), createMockContext()),
      ).toThrow();
    });

    it('rejects disabled functions in expressions', () => {
      expect(() =>
        calculateTool.handler(parse({ expression: 'evaluate("2+3")' }), createMockContext()),
      ).toThrow('disabled');
    });

    it('rejects unknown functions', () => {
      expect(() =>
        calculateTool.handler(parse({ expression: 'foo(5)' }), createMockContext()),
      ).toThrow();
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
});
