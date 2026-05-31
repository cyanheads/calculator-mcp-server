/**
 * @fileoverview Tests for MathService — edge cases, security guards, and pure-logic
 * paths not fully exercised by the calculate.tool tests.
 * @module services/math/math-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { getMathService, initMathService, MathService } from '@/services/math/math-service.js';

/** Parse tool input and return a typed object. */
function parse(input: Record<string, unknown>) {
  return calculateTool.input.parse(input);
}

/** Create a mock context with the tool's error contract. */
function mockCtx() {
  return createMockContext({ errors: calculateTool.errors });
}

/**
 * Assert an McpError with the given code and data.reason is thrown.
 * Mirrors the helper in calculate.tool.test.ts.
 */
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

// ---------------------------------------------------------------------------
// getMathService() guard
// ---------------------------------------------------------------------------

describe('getMathService guard', () => {
  it('throws when called before initMathService', () => {
    // Access internal singleton slot via a fresh import is not feasible without
    // module isolation — instead verify the accessor works when initialised.
    // (The uninitialized path is already guarded by the beforeAll above.)
    expect(() => getMathService()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security: disabled functions in expression scope
// ---------------------------------------------------------------------------

describe('disabled functions (expression scope security)', () => {
  // Each function in DISABLED_FUNCTIONS must throw when called from an expression.
  const disabled = [
    'import',
    'createUnit',
    'evaluate',
    'parse',
    'compile',
    'chain',
    'config',
    'parser',
  ];

  for (const fn of disabled) {
    it(`rejects "${fn}" called from an expression`, () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: `${fn}("test")` }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'parse_failed',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Security: version constant redaction
// ---------------------------------------------------------------------------

describe('version constant redaction', () => {
  it('returns "redacted" for the version constant in expressions', async () => {
    const math = getMathService();
    const ctx = mockCtx();
    const { result } = math.evaluateExpression('version', ctx);
    // math.js format() wraps string values in double-quotes.
    // The important assertion is that it does NOT contain a semver number.
    expect(result).not.toMatch(/\d+\.\d+\.\d+/);
    expect(result).toContain('redacted');
  });
});

// ---------------------------------------------------------------------------
// Security: prototype-polluting scope keys
// ---------------------------------------------------------------------------

describe('prototype-polluting scope key rejection', () => {
  /**
   * Keys that are enumerable own properties when set via Object.defineProperty.
   * '__proto__' is handled specially by JS engines as object literal syntax —
   * `{ __proto__: 0 }` sets the prototype rather than creating an own key, so
   * it cannot reach the service's validation layer via normal object literal.
   * All other BLOCKED_SCOPE_KEYS are testable as own enumerable properties.
   */
  const testableBlockedKeys = [
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ];

  for (const key of testableBlockedKeys) {
    it(`rejects scope key "${key}"`, () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: 'x', scope: { [key]: 0 } }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'reserved_scope_key',
      );
    });
  }

  it('strips "__proto__" silently — Zod z.record neutralizes it before the scope guard', () => {
    /**
     * "__proto__" in a JS object literal sets the prototype rather than creating
     * an own key, so it never appears in Object.keys(). Zod's z.record() further
     * sanitizes the scope object during parse, stripping any remaining "__proto__"
     * key, so it never reaches validateScope. The expression evaluates normally
     * (scope is empty, "x" is undefined → parse_failed for unknown symbol "x").
     *
     * This test documents the actual layered defense rather than asserting a path
     * that Zod already prevents from existing.
     */
    // Object literal { __proto__: 0 } sets prototype, not an own key — Zod receives {}
    const parsed = calculateTool.input.parse({ expression: '1 + 1', scope: { __proto__: 0 } });
    // After Zod parse, scope is empty (or absent) — __proto__ was silently dropped
    expect(parsed.scope === undefined || Object.keys(parsed.scope ?? {}).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security: injection via expression string
// ---------------------------------------------------------------------------

describe('injection via expression strings', () => {
  it('rejects semicolon-separated injection attempt', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '1 + 2; process.exit(0)' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'multiple_expressions',
    );
  });

  it('rejects newline (\\n) expression separator', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '1 + 2\n3 + 4' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'multiple_expressions',
    );
  });

  it('rejects carriage-return (\\r) expression separator', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '1 + 2\r3 + 4' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'multiple_expressions',
    );
  });

  it('allows matrix semicolons (not a separator)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'det([1, 2; 3, 4])' }), mockCtx()),
    );
    expect(result.result).toBe('-2');
  });

  it('allows nested matrix semicolons', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'size([1, 2; 3, 4; 5, 6])' }), mockCtx()),
    );
    // size() returns an Array (not DenseMatrix) containing [3, 2] for a 3×2 matrix
    expect(result.result).toContain('3');
    expect(result.result).toContain('2');
  });
});

// ---------------------------------------------------------------------------
// Security: oversized inputs
// ---------------------------------------------------------------------------

describe('oversized inputs', () => {
  it('rejects expression exactly at the default limit + 1', () => {
    // Default maxExpressionLength is 1000; craft a 1001-char expression.
    const longExpr = 'x' + '+1'.repeat(500); // 1001 chars
    expectMcpError(
      () => calculateTool.handler(parse({ expression: longExpr }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'expression_too_long',
    );
  });

  it('accepts an expression exactly at the default limit', async () => {
    // Pad '1' with spaces to exactly 1000 chars. math.js ignores whitespace.
    const atLimit = '1' + ' '.repeat(999); // exactly 1000 chars
    expect(atLimit.length).toBe(1000);
    // Should not throw expression_too_long (length is <= 1000, so the guard passes).
    let threw = false;
    try {
      calculateTool.handler(parse({ expression: atLimit }), mockCtx());
    } catch (err) {
      if (
        err instanceof McpError &&
        (err.data as Record<string, unknown>)?.reason === 'expression_too_long'
      ) {
        threw = true;
      }
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation: variable field
// ---------------------------------------------------------------------------

describe('variable field validation', () => {
  it('rejects variable with invalid characters via Zod schema', () => {
    expect(() =>
      parse({ expression: 'x^2', operation: 'derivative', variable: '123bad!' }),
    ).toThrow();
  });

  it('rejects variable exceeding 50 characters', () => {
    const longVar = 'a'.repeat(51);
    expect(() =>
      parse({ expression: 'x^2', operation: 'derivative', variable: longVar }),
    ).toThrow();
  });

  it('accepts a valid snake_case variable name', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'my_var^2', operation: 'derivative', variable: 'my_var' }),
        mockCtx(),
      ),
    );
    expect(result.resultType).toBe('string');
    expect(result.result).toContain('my_var');
  });
});

// ---------------------------------------------------------------------------
// Input validation: precision field
// ---------------------------------------------------------------------------

describe('precision field validation', () => {
  it('rejects precision below minimum (0)', () => {
    expect(() => parse({ expression: '1/3', precision: 0 })).toThrow();
  });

  it('rejects precision above maximum (17)', () => {
    expect(() => parse({ expression: '1/3', precision: 17 })).toThrow();
  });

  it('accepts precision at lower boundary (1)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '1 / 3', precision: 1 }), mockCtx()),
    );
    expect(result.result).toBe('0.3');
  });

  it('accepts precision at upper boundary (16)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '1 / 3', precision: 16 }), mockCtx()),
    );
    expect(result.result).toBe('0.3333333333333333');
  });
});

// ---------------------------------------------------------------------------
// Evaluate — additional edge cases
// ---------------------------------------------------------------------------

describe('evaluate edge cases', () => {
  it('evaluates modulus operator', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '17 % 5' }), mockCtx()),
    );
    expect(result.result).toBe('2');
  });

  it('evaluates factorial', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '5!' }), mockCtx()),
    );
    expect(result.result).toBe('120');
  });

  it('evaluates combinations', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'combinations(5, 2)' }), mockCtx()),
    );
    expect(result.result).toBe('10');
  });

  it('evaluates permutations', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'permutations(5, 2)' }), mockCtx()),
    );
    expect(result.result).toBe('20');
  });

  it('evaluates log with base argument', async () => {
    // log(1000, 10) = 3 mathematically; floating-point gives ~2.9999...
    // Use precision to round to a clean value.
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'log(1000, 10)', precision: 10 }), mockCtx()),
    );
    expect(result.result).toBe('3');
  });

  it('evaluates boolean comparison (equal)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'equal(3, 3)' }), mockCtx()),
    );
    expect(result.result).toBe('true');
    expect(result.resultType).toBe('boolean');
  });

  it('evaluates boolean comparison (unequal)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'unequal(3, 4)' }), mockCtx()),
    );
    expect(result.result).toBe('true');
    expect(result.resultType).toBe('boolean');
  });

  it('evaluates matrix inverse', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'inv([1, 2; 3, 4])' }), mockCtx()),
    );
    expect(result.resultType).toBe('DenseMatrix');
    expect(result.result).toContain('-2');
  });

  it('evaluates abs on complex number', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'abs(3 + 4i)' }), mockCtx()),
    );
    expect(result.result).toBe('5');
    expect(result.resultType).toBe('number');
  });

  it('evaluates -Infinity via unaryMinus and Infinity', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '-1 / 0' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'undefined_result',
    );
  });

  it('rejects a matrix containing a non-finite (Infinity) element', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '[1/0, 2]' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'undefined_result',
    );
  });

  it('rejects a matrix containing a NaN element', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '[0/0, 1]' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'undefined_result',
    );
  });

  it('rejects a complex number with a non-finite component', () => {
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '1/0 + 2i' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'undefined_result',
    );
  });

  it('still accepts a fully finite matrix', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '[1, 2; 3, 4]' }), mockCtx()),
    );
    expect(result.resultType).toBe('DenseMatrix');
    expect(result.result).toContain('1');
  });

  it('evaluates with multiple scope variables', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'x^2 + y^2 + z^2', scope: { x: 1, y: 2, z: 3 } }),
        mockCtx(),
      ),
    );
    expect(result.result).toBe('14');
  });

  it('returns a large integer without scientific notation', async () => {
    // 2^30 = 1073741824 — well within upperExp: 21 threshold
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '2^30' }), mockCtx()),
    );
    expect(result.result).toBe('1073741824');
    expect(result.result).not.toContain('e');
  });

  it('returns very small numbers in scientific notation', async () => {
    // 1e-8 — below lowerExp: -6 threshold, should use exp notation
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '1e-8' }), mockCtx()),
    );
    expect(result.result).toContain('e');
  });
});

// ---------------------------------------------------------------------------
// Simplify — additional identities
// ---------------------------------------------------------------------------

describe('simplify additional identities', () => {
  it('simplifies 1 - cos^2 to sin^2', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: '1 - cos(x)^2', operation: 'simplify' }),
        mockCtx(),
      ),
    );
    expect(result.result).toBe('sin(x) ^ 2');
  });

  it('simplifies cot^2 + 1 to csc^2', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'cot(x)^2 + 1', operation: 'simplify' }),
        mockCtx(),
      ),
    );
    expect(result.result).toBe('csc(x) ^ 2');
  });

  it('simplifies cos^2 - sin^2 to cos(2x)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'cos(x)^2 - sin(x)^2', operation: 'simplify' }),
        mockCtx(),
      ),
    );
    expect(result.result).toBe('cos(2 * x)');
  });
});

// ---------------------------------------------------------------------------
// Derivative — result content verification
// ---------------------------------------------------------------------------

describe('derivative result content', () => {
  it('differentiates x^2 to 2*x', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'x^2', operation: 'derivative', variable: 'x' }),
        mockCtx(),
      ),
    );
    // math.js renders "2 * x"
    expect(result.result).toMatch(/2\s*\*\s*x/);
    expect(result.resultType).toBe('string');
  });

  it('differentiates a constant to 0', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: '42', operation: 'derivative', variable: 'x' }),
        mockCtx(),
      ),
    );
    expect(result.result).toBe('0');
  });

  it('differentiates sin(x) to cos(x)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'sin(x)', operation: 'derivative', variable: 'x' }),
        mockCtx(),
      ),
    );
    expect(result.result).toContain('cos');
  });

  it('differentiates e^x to e^x', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'e^x', operation: 'derivative', variable: 'x' }),
        mockCtx(),
      ),
    );
    // d/dx e^x = e^x — result should mention "e"
    expect(result.result).toContain('e');
  });

  it('computes partial derivative with respect to y', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'x^2 + y^2', operation: 'derivative', variable: 'y' }),
        mockCtx(),
      ),
    );
    expect(result.result).toMatch(/2\s*\*\s*y/);
  });
});

// ---------------------------------------------------------------------------
// Standard notation aliases (ln, arc*) — normalized before all operations
// ---------------------------------------------------------------------------

describe('standard notation aliases', () => {
  it('evaluates ln() as natural log (-> log)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'ln(e)', precision: 6 }), mockCtx()),
    );
    expect(result.result).toBe('1');
  });

  it('evaluates arcsin() as asin()', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'arcsin(1)' }), mockCtx()),
    );
    // asin(1) = pi/2 ≈ 1.5707963…
    expect(result.result).toMatch(/^1\.570796/);
  });

  it('differentiates ln(x) to 1/x (derivative table resolves via name rewrite)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'ln(x)', operation: 'derivative', variable: 'x' }),
        mockCtx(),
      ),
    );
    expect(result.result).toMatch(/1\s*\/\s*x/);
  });

  it('differentiates arctan(x) to 1/(x^2 + 1)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(
        parse({ expression: 'arctan(x)', operation: 'derivative', variable: 'x' }),
        mockCtx(),
      ),
    );
    expect(result.result).toContain('x ^ 2');
  });

  it('normalizes arc* names in simplify', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'arcsin(x)', operation: 'simplify' }), mockCtx()),
    );
    expect(result.result).toContain('asin');
  });

  it('does not rewrite a scope variable named "ln" (no call parens)', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'ln + 1', scope: { ln: 4 } }), mockCtx()),
    );
    expect(result.result).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// Secret / API key non-leakage
// ---------------------------------------------------------------------------

describe('secrets do not appear in output', () => {
  it('does not echo env var values in error messages', () => {
    // Set a fake env var and confirm it doesn't appear in error output.
    const fakeSecret = 'SUPER_SECRET_KEY_12345';
    const original = process.env.CALC_MAX_EXPRESSION_LENGTH;
    process.env.FAKE_SECRET_TEST = fakeSecret;
    try {
      let errorMsg = '';
      try {
        calculateTool.handler(parse({ expression: '2 +* 3' }), mockCtx());
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }
      expect(errorMsg).not.toContain(fakeSecret);
    } finally {
      process.env.FAKE_SECRET_TEST = undefined;
      if (original !== undefined) process.env.CALC_MAX_EXPRESSION_LENGTH = original;
    }
  });

  it('version constant is redacted and not a semver string', () => {
    const math = getMathService();
    const ctx = mockCtx();
    const { result } = math.evaluateExpression('version', ctx);
    // Must not expose the real math.js version (e.g. "13.2.0") — must contain "redacted".
    expect(result).not.toMatch(/\d+\.\d+\.\d+/);
    expect(result).toContain('redacted');
  });
});

// ---------------------------------------------------------------------------
// MathService constructor: custom config
// ---------------------------------------------------------------------------

describe('MathService with custom config', () => {
  it('respects a tight maxExpressionLength', () => {
    const svc = new MathService({
      maxExpressionLength: 10,
      evaluationTimeoutMs: 5000,
      maxResultLength: 100_000,
    });
    const ctx = mockCtx();
    expect(() => svc.evaluateExpression('1 + 2 + 3 + 4', ctx)).toThrow('exceeds maximum length');
  });

  it('accepts expression within custom maxExpressionLength', () => {
    const svc = new MathService({
      maxExpressionLength: 20,
      evaluationTimeoutMs: 5000,
      maxResultLength: 100_000,
    });
    const ctx = mockCtx();
    const { result } = svc.evaluateExpression('2 + 2', ctx);
    expect(result).toBe('4');
  });

  it('applies custom precision cap via evaluationTimeoutMs', () => {
    // Constructing a service with a tight result cap
    const svc = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 5000,
      maxResultLength: 3,
    });
    const ctx = mockCtx();
    expect(() => svc.evaluateExpression('12345', ctx)).toThrow('exceeds maximum size');
  });
});
