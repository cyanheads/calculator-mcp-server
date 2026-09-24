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
  describe('input contract', () => {
    it('rejects undeclared root fields', () => {
      expect(() => parse({ expression: '2 + 2', unexpected: true })).toThrow('Unrecognized key');
    });
  });

  describe('evaluate (default)', () => {
    it('evaluates basic arithmetic', async () => {
      const result = await call({ expression: '2 + 3 * 4' });
      expect(result).toEqual({
        result: '14',
        resultType: 'number',
        expression: '2 + 3 * 4',
        operation: 'evaluate',
      });
    });

    it('evaluates trigonometric functions', async () => {
      const result = await call({ expression: 'sin(pi / 2)' });
      expect(result).toEqual({
        result: '1',
        resultType: 'number',
        expression: 'sin(pi / 2)',
        operation: 'evaluate',
      });
    });

    it('evaluates with variable scope', async () => {
      const result = await call({ expression: 'a^2 + b^2', scope: { a: 3, b: 4 } });
      expect(result).toEqual({
        result: '25',
        resultType: 'number',
        expression: 'a^2 + b^2',
        operation: 'evaluate',
        scopeVars: ['a', 'b'],
      });
      // #14: scope supplied but full precision → precisionUsed omitted.
      expect(result).not.toHaveProperty('precisionUsed');
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
        operation: 'evaluate',
      });
    });

    it('evaluates statistics functions', async () => {
      const result = await call({ expression: 'mean([85, 90, 78, 92, 88])' });
      expect(result.result).toBe('86.6');
    });

    it('evaluates average() as alias for mean', async () => {
      const result = await call({ expression: 'average(1, 2, 3, 4, 5)' });
      expect(result.result).toBe('3');
    });

    it('evaluates avg() as alias for mean', async () => {
      const result = await call({ expression: 'avg([10, 20, 30])' });
      expect(result.result).toBe('20');
    });

    it('converts mph to m/s', async () => {
      const result = await call({ expression: '60 mph to m/s', precision: 5 });
      expect(result.resultType).toBe('Unit');
      expect(result.result).toContain('m / s');
    });

    it('converts lightyear to km', async () => {
      const result = await call({ expression: '1 lightyear to km', precision: 5 });
      expect(result.resultType).toBe('Unit');
      expect(result.result).toContain('km');
    });

    it('converts knots to m/s', async () => {
      const result = await call({ expression: '10 knots to m/s', precision: 5 });
      expect(result.resultType).toBe('Unit');
      expect(result.result).toContain('m / s');
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
      expect(result).toEqual({
        result: '4',
        resultType: 'number',
        expression: '2 + 2',
        operation: 'evaluate',
      });
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

  // #17: statistics/combinatorics synonyms from other ecosystems (Excel/NumPy/
  // calculator notation) resolve to their math.js names, so an agent's natural
  // guess returns a result instead of an "undefined function" error.
  describe('statistics & combinatorics aliases (#17)', () => {
    const aliasCases = [
      ['stdev([2, 4, 6])', '2', 'std'],
      ['stddev([2, 4, 6])', '2', 'std'],
      ['permute(5, 2)', '20', 'permutations'],
      ['nPr(5, 2)', '20', 'permutations'],
      ['choose(5, 2)', '10', 'combinations'],
      ['nCr(5, 2)', '10', 'combinations'],
      // #20: length/len are agents' natural guess for element count → math.js count.
      ['length([1, 2, 3])', '3', 'count'],
      ['len("abc")', '3', 'count'],
      ['length([1, 2; 3, 4])', '4', 'count'],
    ];

    for (const [expression, expected, canonical] of aliasCases) {
      it(`evaluates ${expression} as alias for ${canonical}`, async () => {
        const result = await call({ expression });
        expect(result.result).toBe(expected);
      });
    }
  });

  describe('simplify', () => {
    it('simplifies algebraic expressions', async () => {
      const result = await call({ expression: '2x + 3x', operation: 'simplify' });
      expect(result).toEqual({
        result: '5 * x',
        resultType: 'string',
        expression: '2x + 3x',
        operation: 'simplify',
        unchanged: false,
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

    // #1: unchanged flag — simplifier no-op detection
    it('sets unchanged: false when simplification makes progress', async () => {
      const result = await call({ expression: '2x + 3x', operation: 'simplify' });
      expect(result.unchanged).toBe(false);
    });

    it('sets unchanged: true when the simplifier cannot reduce the expression', async () => {
      // Rational expression requiring polynomial factoring — beyond math.js's built-in simplifier.
      const result = await call({ expression: '(x^2 - 1) / (x - 1)', operation: 'simplify' });
      expect(result.unchanged).toBe(true);
      // Result is returned unchanged — the expression is not empty or errored.
      expect(result.result).toBeTruthy();
    });

    it('sets unchanged: false for expressions the simplifier collapses to a constant', async () => {
      const result = await call({ expression: 'sin(x)^2 + cos(x)^2', operation: 'simplify' });
      expect(result.result).toBe('1');
      expect(result.unchanged).toBe(false);
    });

    it('always includes unchanged in simplify output', async () => {
      const result = await call({ expression: 'x + 0', operation: 'simplify' });
      expect(result).toHaveProperty('unchanged');
    });

    it('omits unchanged for evaluate', async () => {
      const result = await call({ expression: '2 + 2' });
      expect(result).not.toHaveProperty('unchanged');
    });

    it('omits unchanged for derivative', async () => {
      const result = await call({ expression: 'x^2', operation: 'derivative', variable: 'x' });
      expect(result).not.toHaveProperty('unchanged');
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
      expect(() => calculateTool.handler(parse({ expression: 'parse("2+3")' }), mockCtx())).toThrow(
        'disabled',
      );
    });

    it('rejects unknown functions', () => {
      expect(() => calculateTool.handler(parse({ expression: 'foo(5)' }), mockCtx())).toThrow();
    });
  });

  describe('string literals and statements', () => {
    it('keeps a notation alias inside a string literal (#24)', async () => {
      const result = await call({ expression: 'concat("ln(", "x)")' });
      expect(result.result).toBe('"ln(x)"');
      expect(result.resultType).toBe('string');
    });

    it('treats a semicolon in a single-quoted string as data (#32)', async () => {
      const result = await call({ expression: "concat('a;b', 'c')" });
      expect(result.result).toBe('"a;bc"');
    });
  });

  describe('format', () => {
    it('renders omitted context fields as none/full', () => {
      const formatted = calculateTool.format?.({
        result: '42',
        resultType: 'number',
        expression: '6 * 7',
        operation: 'evaluate',
      });
      expect(formatted).toEqual([
        {
          type: 'text',
          text: '**Expression:** `6 * 7`\n**Operation:** evaluate\n**Result:** `42`\n**Type:** number\n**Scope variables:** none\n**Precision:** full',
        },
      ]);
    });

    it('renders active scope variables and applied precision', () => {
      const formatted = calculateTool.format?.({
        result: '11',
        resultType: 'number',
        expression: 'x^2 + y',
        operation: 'evaluate',
        scopeVars: ['x', 'y'],
        precisionUsed: 4,
      });
      expect(formatted).toEqual([
        {
          type: 'text',
          text: '**Expression:** `x^2 + y`\n**Operation:** evaluate\n**Result:** `11`\n**Type:** number\n**Scope variables:** `x`, `y`\n**Precision:** 4',
        },
      ]);
    });

    /** The text block `format()` renders for an evaluate output with these fields. */
    function rendered(fields: {
      expression?: string;
      result?: string;
      scopeVars?: string[];
      operation?: 'evaluate' | 'simplify' | 'derivative';
    }): string {
      const { format } = calculateTool;
      if (!format) throw new Error('calculate defines no format()');
      const [block] = format({
        expression: '1',
        result: '1',
        resultType: 'string',
        operation: 'evaluate',
        ...fields,
      });
      return (block as { text: string }).text;
    }

    it.each([
      ['"a`b"', '``"a`b"``'],
      ['"a``b"', '```"a``b"```'],
      ['"a```b"', '````"a```b"````'],
      ['"a`b``c```d"', '````"a`b``c```d"````'],
      ['`lead', '`` `lead ``'],
      ['trail`', '`` trail` ``'],
      ['``both``', '``` ``both`` ```'],
      [' lead', '`  lead `'],
      ['trail ', '` trail  `'],
      ['"[click](https://example.com)"', '`"[click](https://example.com)"`'],
      ['"<script>alert(1)</script>"', '`"<script>alert(1)</script>"`'],
      ['["<b>x</b>", "[l](u)"]', '`["<b>x</b>", "[l](u)"]`'],
      ['{"a": {"b": ["<i>", "*x*"]}}', '`{"a": {"b": ["<i>", "*x*"]}}`'],
      ['5 * x_1^2', '`5 * x_1^2`'],
    ])('renders the result %s as the code span %s', (result, span) => {
      expect(rendered({ result })).toContain(`\n**Result:** ${span}\n`);
    });

    it('sizes the expression span the same way and keeps a backtick-free expression byte-identical', () => {
      expect(rendered({ expression: '"a`b"' })).toMatch(/^\*\*Expression:\*\* ``"a`b"``\n/);
      expect(rendered({ expression: '2 + 3 * 4' })).toMatch(/^\*\*Expression:\*\* `2 \+ 3 \* 4`\n/);
    });

    it('renders each scope-variable name as its own code span', () => {
      expect(rendered({ scopeVars: ['<img src=x>', 'a`b', '[l](u)', 'x'] })).toContain(
        '\n**Scope variables:** `<img src=x>`, ``a`b``, `[l](u)`, `x`\n',
      );
    });

    it('renders an all-space name unpadded and an empty name as a marker', () => {
      expect(rendered({ scopeVars: ['  ', ''] })).toContain(
        '\n**Scope variables:** `  `, (empty)\n',
      );
    });

    it('puts a multi-line result in a fenced block sized past its longest backtick run', () => {
      const sparse = 'Sparse Matrix [2 x 2] density: 0.5\n\n    (0, 0) ==> 1\n    (1, 1) ==> 1';
      expect(rendered({ result: sparse })).toContain(
        `\n**Result:**\n\`\`\`\n${sparse}\n\`\`\`\n**Type:** string\n`,
      );
      expect(rendered({ result: 'a\n````\nb' })).toContain(
        '\n**Result:**\n`````\na\n````\nb\n`````\n**Type:**',
      );
    });

    it('puts a multi-line expression in a fenced block', () => {
      expect(rendered({ expression: '"a\nb"' })).toMatch(
        /^\*\*Expression:\*\*\n```\n"a\nb"\n```\n/,
      );
    });

    it('puts a value holding a lone carriage return in a fenced block unchanged', () => {
      // CommonMark reads the CR as a line ending; the fence keeps it from closing early.
      expect(rendered({ expression: '"a\r```b"' })).toMatch(
        /^\*\*Expression:\*\*\n````\n"a\r```b"\n````\n/,
      );
    });

    it('omits the scope and precision lines for derivative', () => {
      const text = rendered({ operation: 'derivative', result: '2 * x' });
      expect(text).toBe(
        '**Expression:** `1`\n**Operation:** derivative\n**Result:** `2 * x`\n**Type:** string',
      );
    });
  });

  describe('output context fields', () => {
    it('echoes operation, scope keys, and applied precision on evaluate', async () => {
      const result = await call({ expression: 'x^2 + y', scope: { x: 3, y: 2 }, precision: 4 });
      expect(result).toEqual({
        result: '11',
        resultType: 'number',
        expression: 'x^2 + y',
        operation: 'evaluate',
        scopeVars: ['x', 'y'],
        precisionUsed: 4,
      });
    });

    it('omits scopeVars and precisionUsed when neither is provided', async () => {
      const result = await call({ expression: '2 + 2' });
      expect(result.operation).toBe('evaluate');
      // #14: the keys are absent from the payload, not present-as-null.
      expect(result).not.toHaveProperty('scopeVars');
      expect(result).not.toHaveProperty('precisionUsed');
    });

    it('omits both context fields for derivative', async () => {
      const result = await call({ expression: 'x^2', operation: 'derivative', variable: 'x' });
      expect(result.operation).toBe('derivative');
      expect(result).not.toHaveProperty('scopeVars');
      expect(result).not.toHaveProperty('precisionUsed');
    });

    it('omits both context fields for simplify', async () => {
      const result = await call({ expression: '2x + 3x', operation: 'simplify' });
      expect(result.operation).toBe('simplify');
      expect(result).not.toHaveProperty('scopeVars');
      expect(result).not.toHaveProperty('precisionUsed');
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
        () => svc.evaluateExpression('123456789', mockCtx()),
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

    it('fraction_unsupported', () => {
      expectMcpError(
        () =>
          calculateTool.handler(
            parse({ expression: 'sqrt(2)', numericType: 'Fraction' }),
            mockCtx(),
          ),
        JsonRpcErrorCode.ValidationError,
        'fraction_unsupported',
      );
    });

    it('parse_failed', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '2 +* 3' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'parse_failed',
      );
    });

    it('operation_as_function', () => {
      expectMcpError(
        () =>
          calculateTool.handler(parse({ expression: 'derivative("0.2*x + 5", "x")' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'operation_as_function',
      );
    });

    it('type_mismatch', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '5 kg + 3' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'type_mismatch',
      );
    });

    it('evaluation_failed', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: 'factorial(-1)' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'evaluation_failed',
      );
    });

    it('undefined_result under BigNumber and Fraction', () => {
      for (const numericType of ['BigNumber', 'Fraction']) {
        expectMcpError(
          () => calculateTool.handler(parse({ expression: '1 / 0', numericType }), mockCtx()),
          JsonRpcErrorCode.ValidationError,
          'undefined_result',
        );
      }
    });

    it('disallowed_result_type for help()', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: 'help("sin")' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'disallowed_result_type',
      );
    });

    it('multiple_expressions after a single-quoted string', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: `'"' ; 1+1` }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'multiple_expressions',
      );
    });

    it('result_too_large from a size limit', () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: 'range(1, 5e6)' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'result_too_large',
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
      // A million-iteration map takes hundreds of milliseconds, far past a 1 ms timeout.
      const svc = new MathService({
        maxExpressionLength: 10_000,
        evaluationTimeoutMs: 1,
        maxResultLength: 1_000_000,
      });
      expectMcpError(
        () => svc.evaluateExpression('sum(map(range(1, 1e6), x^2))', mockCtx()),
        JsonRpcErrorCode.Timeout,
        'evaluation_timeout',
      );
    });
  });

  // #7: numericType parameter — BigNumber and Fraction escalation
  describe('numericType parameter', () => {
    it('defaults to "number" (no numericType specified)', async () => {
      const result = await call({ expression: '2 + 2' });
      expect(result.result).toBe('4');
      expect(result.resultType).toBe('number');
    });

    it('evaluates with explicit numericType: "number"', async () => {
      const result = await call({ expression: '1 / 3', numericType: 'number', precision: 4 });
      expect(result.result).toBe('0.3333');
      expect(result.resultType).toBe('number');
    });

    it('evaluates with numericType: "BigNumber" and returns BigNumber type', async () => {
      const result = await call({ expression: '2 + 2', numericType: 'BigNumber' });
      expect(result.result).toBe('4');
      expect(result.resultType).toBe('BigNumber');
    });

    it('resolves factorial ratio that overflows 64-bit float using BigNumber', async () => {
      // 10000! / 9999! overflows as IEEE 754 (Infinity / Infinity = NaN → undefined_result).
      // BigNumber arithmetic computes it incrementally without overflow.
      const result = await call({ expression: '10000! / 9999!', numericType: 'BigNumber' });
      // Result is mathematically 10000 — BigNumber gives a close high-precision approximation.
      expect(result.resultType).toBe('BigNumber');
      // The result should be close to 10000 (BigNumber precision is ~64 digits).
      expect(parseFloat(result.result)).toBeCloseTo(10000, 0);
    });

    it('default "number" mode still rejects factorial ratio overflow as undefined_result', () => {
      // Regression: escalating to BigNumber must not change the default path behavior.
      expectMcpError(
        () => calculateTool.handler(parse({ expression: '10000! / 9999!' }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'undefined_result',
      );
    });

    it('evaluates with numericType: "Fraction" for exact rational results', async () => {
      // 0.1 + 0.2 in IEEE 754 produces 0.30000000000000004; Fraction eliminates rounding.
      // math.format() for Fraction values renders in fraction notation (e.g. "3/10"),
      // not decimal notation — the important property is that the result is exact.
      const result = await call({ expression: '0.1 + 0.2', numericType: 'Fraction' });
      expect(result.resultType).toBe('Fraction');
      // 0.1 + 0.2 as exact Fraction is 3/10 — no floating-point error.
      expect(result.result).toMatch(/3\/10|0\.3/);
    });

    it('rejects invalid numericType via Zod schema', () => {
      expect(() => parse({ expression: '2 + 2', numericType: 'double' })).toThrow();
    });

    // #19: an irrational/transcendental result under Fraction mode surfaces a
    // dedicated fraction_unsupported error, not the misleading parse_failed.
    it('maps a transcendental Fraction result (sin) to fraction_unsupported', () => {
      expectMcpError(
        () =>
          calculateTool.handler(
            parse({ expression: 'sin(1)', numericType: 'Fraction' }),
            mockCtx(),
          ),
        JsonRpcErrorCode.ValidationError,
        'fraction_unsupported',
      );
    });

    it('maps an irrational Fraction result (sqrt) to fraction_unsupported with retry guidance', () => {
      let caught: McpError | undefined;
      try {
        calculateTool.handler(parse({ expression: 'sqrt(2)', numericType: 'Fraction' }), mockCtx());
      } catch (err) {
        caught = err as McpError;
      }
      expect(caught?.data?.reason).toBe('fraction_unsupported');
      expect(caught?.message).toContain('number');
      expect(caught?.message).toContain('BigNumber');
      // The internal math.js workaround must not be surfaced to the caller.
      expect(caught?.message).not.toContain('fraction(x)');
    });

    it('keeps a genuine parse error as parse_failed under Fraction mode', () => {
      expectMcpError(
        () =>
          calculateTool.handler(
            parse({ expression: '2 +* 3', numericType: 'Fraction' }),
            mockCtx(),
          ),
        JsonRpcErrorCode.ValidationError,
        'parse_failed',
      );
    });

    it('still resolves an exactly-rational Fraction expression', async () => {
      const result = await call({ expression: '1/3 + 1/6', numericType: 'Fraction' });
      expect(result.resultType).toBe('Fraction');
      expect(result.result).toBe('1/2');
    });

    it('does not remap sqrt(2) under number mode (only Fraction triggers the remap)', async () => {
      const result = await call({ expression: 'sqrt(2)', numericType: 'number', precision: 6 });
      expect(result.resultType).toBe('number');
      expect(result.result).toMatch(/^1\.41421/);
    });

    it('security guards remain active on BigNumber instance', () => {
      // Disabled functions must throw even on the BigNumber-configured instance.
      expectMcpError(
        () =>
          calculateTool.handler(
            parse({ expression: 'parse("2+3")', numericType: 'BigNumber' }),
            mockCtx(),
          ),
        JsonRpcErrorCode.ValidationError,
        'parse_failed',
      );
    });
  });

  describe('format (updated for simplify)', () => {
    it('renders "reduced" status when unchanged is false', () => {
      const formatted = calculateTool.format?.({
        result: '5 * x',
        resultType: 'string',
        expression: '2x + 3x',
        operation: 'simplify',
        unchanged: false,
      });
      expect(formatted?.[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('unchanged: false'),
      });
    });

    it('renders "unchanged" status when unchanged is true', () => {
      const formatted = calculateTool.format?.({
        result: '(x ^ 2 - 1) / (x - 1)',
        resultType: 'string',
        expression: '(x^2 - 1) / (x - 1)',
        operation: 'simplify',
        unchanged: true,
      });
      expect(formatted?.[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('could not be reduced further'),
      });
    });

    it('omits scope/precision lines for simplify', () => {
      const formatted = calculateTool.format?.({
        result: '5 * x',
        resultType: 'string',
        expression: '2x + 3x',
        operation: 'simplify',
        unchanged: false,
      });
      expect(formatted?.[0]).toMatchObject({
        type: 'text',
        text: expect.not.stringContaining('Scope variables'),
      });
      expect(formatted?.[0]).toMatchObject({
        type: 'text',
        text: expect.not.stringContaining('Precision'),
      });
    });
  });
});
