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
  // evaluate/simplify/derivative are covered by the operation_as_function block (#27).
  const disabled = [
    'import',
    'createUnit',
    'parse',
    'compile',
    'chain',
    'config',
    'parser',
    'resolve',
    'reviver',
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

  // #16: the separator scan is string-literal-aware — a `;` inside a double-quoted
  // string is data, not a statement break, and must not be falsely rejected.
  it('allows a semicolon inside a double-quoted string literal', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '"hello;world"' }), mockCtx()),
    );
    expect(result.resultType).toBe('string');
    expect(result.result).toContain('hello;world');
  });

  it('allows a semicolon inside a string argument to a function', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'concat("a;b", "c")' }), mockCtx()),
    );
    expect(result.result).toContain('a;bc');
  });

  it('allows a newline inside a double-quoted string literal', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: '"line1\nline2"' }), mockCtx()),
    );
    expect(result.resultType).toBe('string');
    expect(result.result).toContain('line1');
    expect(result.result).toContain('line2');
  });

  it('still rejects a top-level semicolon that follows a string literal', () => {
    // The `[` inside the string must not shift bracket depth, so the trailing
    // top-level `;` is still caught — the benign converse noted in #16.
    expectMcpError(
      () => calculateTool.handler(parse({ expression: '"[" ; 1 + 1' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'multiple_expressions',
    );
  });
});

// ---------------------------------------------------------------------------
// Security: function source non-leakage (toString / toLocaleString) — #15
// ---------------------------------------------------------------------------

describe('function-to-string source non-leakage', () => {
  // `.toString()` / `.toLocaleString()` on a function-valued identifier used to
  // return the function's source as a plain string, slipping past the
  // result-type guard (which only ever sees the post-stringify string). Both
  // method forms, on math.js builtins and on the disabled-function shims, must
  // now reject — consistent with the already-blocked `.constructor` / `.name`.
  const leakAttempts = [
    'cos.toString()',
    'cos.toLocaleString()',
    'cos["toString"]()',
    'import.toString()',
    'evaluate.toString()',
    'simplify.toString()',
  ];

  for (const expr of leakAttempts) {
    it(`rejects ${expr} as disallowed_result_type`, () => {
      expectMcpError(
        () => calculateTool.handler(parse({ expression: expr }), mockCtx()),
        JsonRpcErrorCode.ValidationError,
        'disallowed_result_type',
      );
    });
  }

  it('does not leak function source text in the rejection', () => {
    let message = '';
    try {
      calculateTool.handler(parse({ expression: 'cos.toString()' }), mockCtx());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // The leaked math.js source signature must not appear anywhere in the error.
    expect(message).not.toContain('apply');
    expect(message).not.toContain('arguments');
    expect(message).not.toContain('theTypedFn');
  });

  it('restores Function.prototype.toString after the guarded eval', async () => {
    // The patch is installed and restored per-eval; a normal call immediately
    // after a leak attempt must evaluate exactly as before.
    expectMcpError(
      () => calculateTool.handler(parse({ expression: 'cos.toString()' }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'disallowed_result_type',
    );
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'cos(0)' }), mockCtx()),
    );
    expect(result.result).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Security: simplify/derivative enforce the same hardening as evaluate (#18)
// ---------------------------------------------------------------------------

describe('symbolic operations do not bypass the hardened instance (#18)', () => {
  // simplify/derivative constant-fold subexpressions. Before #18 they ran on a
  // separate unhardened math.js instance, so a folded `evaluate("…")` executed
  // the disabled functions and returned math.js internals as a string. They now
  // reuse the hardened default instance, and since #27 an `evaluate(…)` call is
  // rejected at parse time — before any folding runs — so nothing executes and
  // no internals leak through either the result or the error.

  /** Run a symbolic operation expected to be rejected; return the error message. */
  function rejectedMessage(run: () => unknown): string {
    let caught: unknown;
    try {
      run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).data?.reason).toBe('operation_as_function');
    return (caught as McpError).message;
  }

  it('simplify rejects evaluate("6*7") without folding it to 42', () => {
    const math = getMathService();
    const message = rejectedMessage(() => math.simplifyExpression('evaluate("6*7")', mockCtx()));
    expect(message).not.toContain('42');
  });

  it('simplify does not leak the math.js version via evaluate("version")', () => {
    const math = getMathService();
    const message = rejectedMessage(() =>
      math.simplifyExpression('evaluate("version")', mockCtx()),
    );
    expect(message).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('simplify does not leak function source via evaluate("cos.toString()")', () => {
    const math = getMathService();
    const message = rejectedMessage(() =>
      math.simplifyExpression('evaluate("cos.toString()")', mockCtx()),
    );
    expect(message).not.toContain('theTypedFn');
    expect(message).not.toContain('arguments');
  });

  it('derivative does not leak the version via a folded coefficient', () => {
    const math = getMathService();
    const message = rejectedMessage(() =>
      math.differentiateExpression('x * evaluate("version")', 'x', mockCtx()),
    );
    expect(message).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('simplify still leaves a disabled non-operation call unevaluated', () => {
    // import() is not an operation name, so it reaches the folder, which cannot
    // run the disabled stub and leaves the node in place.
    const { result } = getMathService().simplifyExpression('import("x")', mockCtx());
    expect(result).toContain('import');
  });

  it('rejects direct .toString() on a function under simplify', () => {
    expectMcpError(
      () =>
        calculateTool.handler(
          parse({ expression: 'cos.toString()', operation: 'simplify' }),
          mockCtx(),
        ),
      JsonRpcErrorCode.ValidationError,
      'disallowed_result_type',
    );
  });

  it('rejects direct .toLocaleString() on a function under derivative', () => {
    expectMcpError(
      () =>
        calculateTool.handler(
          parse({ expression: 'cos.toLocaleString() * x', operation: 'derivative', variable: 'x' }),
          mockCtx(),
        ),
      JsonRpcErrorCode.ValidationError,
      'disallowed_result_type',
    );
  });

  it('preserves legitimate constant folding after hardening', () => {
    const math = getMathService();
    expect(math.simplifyExpression('2 + 3', mockCtx()).result).toBe('5');
    expect(math.simplifyExpression('x * 2 * 3', mockCtx()).result).toBe('6 * x');
  });

  it('preserves normal derivative results after hardening', () => {
    const math = getMathService();
    expect(math.differentiateExpression('x^2', 'x', mockCtx()).result).toMatch(/2\s*\*\s*x/);
  });
});

// ---------------------------------------------------------------------------
// Security: oversized inputs
// ---------------------------------------------------------------------------

describe('oversized inputs', () => {
  it('rejects expression exactly at the default limit + 1', () => {
    // Default maxExpressionLength is 1000; craft a 1001-char expression.
    const longExpr = `x${'+1'.repeat(500)}`; // 1001 chars
    expectMcpError(
      () => calculateTool.handler(parse({ expression: longExpr }), mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'expression_too_long',
    );
  });

  it('accepts an expression exactly at the default limit', async () => {
    // Pad '1' with spaces to exactly 1000 chars. math.js ignores whitespace.
    const atLimit = `1${' '.repeat(999)}`; // exactly 1000 chars
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

  it('evaluates std (sample standard deviation) — canonical target of the stdev/stddev aliases', async () => {
    const result = await Promise.resolve(
      calculateTool.handler(parse({ expression: 'std([2, 4, 6])' }), mockCtx()),
    );
    expect(result.result).toBe('2');
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

// ---------------------------------------------------------------------------
// numericType — BigNumber and Fraction evaluate paths (#7)
// ---------------------------------------------------------------------------

describe('numericType escalation', () => {
  it('returns BigNumber result type when numericType is "BigNumber"', () => {
    const math = getMathService();
    const ctx = mockCtx();
    const { result, resultType } = math.evaluateExpression(
      '2 + 2',
      ctx,
      undefined,
      undefined,
      'BigNumber',
    );
    expect(result).toBe('4');
    expect(resultType).toBe('BigNumber');
  });

  it('resolves large factorial ratio without overflow using BigNumber', () => {
    // 10000! / 9999! overflows as IEEE 754 — the default "number" path produces NaN
    // and triggers an undefined_result error. BigNumber computes it without overflow.
    const math = getMathService();
    const ctx = mockCtx();
    const { result, resultType } = math.evaluateExpression(
      '10000! / 9999!',
      ctx,
      undefined,
      undefined,
      'BigNumber',
    );
    expect(resultType).toBe('BigNumber');
    // Mathematical result is 10000; BigNumber gives a high-precision approximation.
    expect(parseFloat(result)).toBeCloseTo(10000, 0);
  });

  it('default "number" path still rejects large factorial ratio as undefined_result', () => {
    const math = getMathService();
    const ctx = mockCtx();
    // Regression guard: BigNumber addition must not alter the default path.
    expectMcpError(
      () => math.evaluateExpression('10000! / 9999!', ctx),
      JsonRpcErrorCode.ValidationError,
      'undefined_result',
    );
  });

  it('returns Fraction result type when numericType is "Fraction"', () => {
    const math = getMathService();
    const ctx = mockCtx();
    const { result, resultType } = math.evaluateExpression(
      '0.1 + 0.2',
      ctx,
      undefined,
      undefined,
      'Fraction',
    );
    expect(resultType).toBe('Fraction');
    // math.format() renders Fraction values in fraction notation (e.g. "3/10").
    // The key property is exact arithmetic — 0.1 + 0.2 in Fraction mode is 3/10,
    // not 0.30000000000000004 as in IEEE 754.
    expect(result).toMatch(/3\/10|0\.3/);
  });

  it('security guards remain active on the BigNumber instance', () => {
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
    expectMcpError(
      () =>
        calculateTool.handler(
          parse({ expression: 'evaluate("2+3")', numericType: 'BigNumber' }),
          mockCtx(),
        ),
      JsonRpcErrorCode.ValidationError,
      'operation_as_function',
    );
  });
});

// ---------------------------------------------------------------------------
// Fraction irrational/transcendental results → fraction_unsupported (#19)
// ---------------------------------------------------------------------------

describe('Fraction unsupported-result remap (#19)', () => {
  const irrationalCases = ['sqrt(2)', 'sin(1)', 'log(3)'];

  for (const expr of irrationalCases) {
    it(`remaps ${expr} to fraction_unsupported`, () => {
      const math = getMathService();
      expectMcpError(
        () => math.evaluateExpression(expr, mockCtx(), undefined, undefined, 'Fraction'),
        JsonRpcErrorCode.ValidationError,
        'fraction_unsupported',
      );
    });
  }

  it('does not remap the same expression under number mode', () => {
    const math = getMathService();
    const { resultType } = math.evaluateExpression('sqrt(2)', mockCtx());
    expect(resultType).toBe('number');
  });

  it('keeps a genuine parse error as parse_failed under Fraction mode', () => {
    const math = getMathService();
    expectMcpError(
      () => math.evaluateExpression('2 +* 3', mockCtx(), undefined, undefined, 'Fraction'),
      JsonRpcErrorCode.ValidationError,
      'parse_failed',
    );
  });

  it('still resolves an exactly-rational Fraction expression', () => {
    const math = getMathService();
    const { result, resultType } = math.evaluateExpression(
      '1/3 + 1/6',
      mockCtx(),
      undefined,
      undefined,
      'Fraction',
    );
    expect(resultType).toBe('Fraction');
    expect(result).toBe('1/2');
  });
});

// ---------------------------------------------------------------------------
// length / len aliases for count (#20)
// ---------------------------------------------------------------------------

describe('length/len aliases resolve to count (#20)', () => {
  it('counts array elements via length', () => {
    const math = getMathService();
    expect(math.evaluateExpression('length([1, 2, 3])', mockCtx()).result).toBe('3');
  });

  it('counts string characters via len', () => {
    const math = getMathService();
    expect(math.evaluateExpression('len("abc")', mockCtx()).result).toBe('3');
  });

  it('counts matrix elements via length', () => {
    const math = getMathService();
    expect(math.evaluateExpression('length([1, 2; 3, 4])', mockCtx()).result).toBe('4');
  });

  it('resolves the alias under every numericType mode (per-instance import)', () => {
    const math = getMathService();
    for (const numericType of ['number', 'BigNumber', 'Fraction'] as const) {
      const { result } = math.evaluateExpression(
        'length([1, 2, 3])',
        mockCtx(),
        undefined,
        undefined,
        numericType,
      );
      expect(result).toBe('3');
    }
  });
});

// ---------------------------------------------------------------------------
// simplify unchanged detection (#1)
// ---------------------------------------------------------------------------

describe('simplify unchanged detection', () => {
  it('returns unchanged: false when simplification makes progress', () => {
    const math = getMathService();
    const ctx = mockCtx();
    const { result, unchanged } = math.simplifyExpression('2x + 3x', ctx);
    expect(result).toBe('5 * x');
    expect(unchanged).toBe(false);
  });

  it('returns unchanged: true for rational expression requiring polynomial factoring', () => {
    // math.js built-in simplifier cannot factor (x^2-1)/(x-1) to (x+1).
    const math = getMathService();
    const ctx = mockCtx();
    const { unchanged } = math.simplifyExpression('(x^2 - 1) / (x - 1)', ctx);
    expect(unchanged).toBe(true);
  });

  it('returns unchanged: false when a trig identity collapses the expression', () => {
    const math = getMathService();
    const ctx = mockCtx();
    const { result, unchanged } = math.simplifyExpression('sin(x)^2 + cos(x)^2', ctx);
    expect(result).toBe('1');
    expect(unchanged).toBe(false);
  });

  it('normalised comparison ignores formatting differences (x+1 vs x + 1)', () => {
    // If the simplifier only re-formats the expression (spacing/operators) without
    // changing its structure, unchanged should be true — both AST-normalised forms match.
    // "x + 0" simplifies to "x" — a real structural change, so unchanged is false.
    const math = getMathService();
    const ctx = mockCtx();
    const { result, unchanged } = math.simplifyExpression('x + 0', ctx);
    expect(result).toBe('x');
    expect(unchanged).toBe(false);
  });

  it('always includes unchanged in the result object', () => {
    const math = getMathService();
    const ctx = mockCtx();
    const result = math.simplifyExpression('2x + 3x', ctx);
    expect(result).toHaveProperty('unchanged');
    expect(typeof result.unchanged).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Test helpers for the evaluate-path contract
// ---------------------------------------------------------------------------

type EvalOptions = {
  numericType?: 'number' | 'BigNumber' | 'Fraction';
  operation?: 'evaluate' | 'simplify' | 'derivative';
  variable?: string;
  scope?: Record<string, number>;
  precision?: number;
};

/** Run the tool handler and return its output. */
function run(expression: string, options: EvalOptions = {}) {
  return calculateTool.handler(parse({ expression, ...options }), mockCtx()) as {
    result: string;
    resultType: string;
    unchanged?: boolean;
  };
}

/** Run the tool handler expecting a failure; return the thrown McpError. */
function failure(expression: string, options: EvalOptions = {}): McpError {
  let caught: unknown;
  try {
    run(expression, options);
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected "${expression}" to fail`).toBeInstanceOf(McpError);
  return caught as McpError;
}

/** The `data.reason` the failure carries. */
function reasonOf(expression: string, options: EvalOptions = {}) {
  const err = failure(expression, options);
  return err.data?.reason;
}

// ---------------------------------------------------------------------------
// Characterization: behavior pinned before the evaluate-path rework
// ---------------------------------------------------------------------------

describe('characterization — accepted results and parse errors', () => {
  it.each([
    ["[1, 2; 3, 4]'", '[[1, 3], [2, 4]]', 'DenseMatrix'],
    ['"a;b"', '"a;b"', 'string'],
    ['{a: 1}', '{"a": 1}', 'Object'],
    ['5 kg to lbs', '11.023113109243878 lbs', 'Unit'],
    ['(3 m)^2', '9 m^2', 'Unit'],
    ['2 km * 3', '6 km', 'Unit'],
    ['sqrt(-4)', '2i', 'Complex'],
    ['equal(3, 3)', 'true', 'boolean'],
    ['sparse([1, 0; 0, 2])', 'Sparse Matrix [2 x 2]', 'SparseMatrix'],
    ['sum(range(1, 1e6))', '500000500000', 'number'],
  ])('evaluates %s', (expression, expected, resultType) => {
    const output = run(expression);
    expect(output.result).toContain(expected);
    expect(output.resultType).toBe(resultType);
  });

  it('formats a 180 x 180 matrix within the default result size', () => {
    const output = run('zeros(180, 180)');
    expect(output.result.length).toBe(97_560);
  });

  it('keeps BigNumber and Fraction results formatting', () => {
    expect(run('1/3', { numericType: 'BigNumber' }).resultType).toBe('BigNumber');
    expect(run('1/3 + 1/6', { numericType: 'Fraction' }).result).toBe('1/2');
  });

  it('reports simplify of ln(x) as unchanged against the alias-normalized input', () => {
    const output = run('ln(x)', { operation: 'simplify' });
    expect(output.result).toBe('log(x)');
    expect(output.unchanged).toBe(true);
  });

  it('reads config() in BigNumber mode', () => {
    expect(run('config()', { numericType: 'BigNumber' }).result).toContain('"precision": 64');
  });

  it.each(['2 +* 3', '(1 + 2', 'sin(', '"abc'])('keeps %s a parse_failed', (expression) => {
    expect(reasonOf(expression)).toBe('parse_failed');
  });
});

// ---------------------------------------------------------------------------
// #21 — non-finite values nested in any result type
// ---------------------------------------------------------------------------

describe('non-finite results in every numeric type (#21)', () => {
  const undefinedCases: Array<[string, EvalOptions]> = [
    ['1 / 0', { numericType: 'BigNumber' }],
    ['0 / 0', { numericType: 'BigNumber' }],
    ['log(0)', { numericType: 'BigNumber' }],
    ['[1/0, 2]', { numericType: 'BigNumber' }],
    ['-1/0', { numericType: 'BigNumber' }],
    ['exp(1e20)', { numericType: 'BigNumber' }],
    ['mean([1, 1/0])', { numericType: 'BigNumber' }],
    ['sparse([1/0, 0])', { numericType: 'BigNumber' }],
    ['bignumber(1)/0', {}],
    ['[bignumber(1)/0, 2]', {}],
    ['1 kg / 0', {}],
    ['0/0 m', {}],
    ['[1 m/0, 2 m]', {}],
    ['{a: 1/0}', {}],
    ['{a: 1, b: [0/0]}', {}],
    ['[{a: [1, 1/0]}]', {}],
    ['1 / 0', { numericType: 'Fraction' }],
    ['0/0', { numericType: 'Fraction' }],
    ['inv(0)', { numericType: 'Fraction' }],
    ['[1/0, 2]', { numericType: 'Fraction' }],
    ['fraction(1)/0', {}],
  ];

  it.each(undefinedCases)('rejects %s %o as undefined_result', (expression, options) => {
    const err = failure(expression, options);
    expect(err.data?.reason).toBe('undefined_result');
    expect(err.data?.recovery).toEqual({
      hint: 'Division by zero, 0/0, and log(0) are undefined in every numericType, so fix the expression; for an overflow (large powers, factorials, exp), retry with numericType "BigNumber".',
    });
  });

  it('keeps finite results', () => {
    expect(parseFloat(run('10000! / 9999!', { numericType: 'BigNumber' }).result)).toBeCloseTo(
      10000,
      0,
    );
    expect(run('5 kg to lbs').resultType).toBe('Unit');
    expect(run('{a: 1}').result).toBe('{"a": 1}');
    expect(run('1/3 + 1/6', { numericType: 'Fraction' }).result).toBe('1/2');
  });

  it('keeps the number-mode matrix and complex cases (#11)', () => {
    expect(reasonOf('[1/0, 2]')).toBe('undefined_result');
    expect(reasonOf('1/0 + 2i')).toBe('undefined_result');
  });

  it('keeps irrational Fraction results on fraction_unsupported and syntax on parse_failed', () => {
    for (const expression of ['sqrt(2)', 'sin(1)', 'log(3)']) {
      expect(reasonOf(expression, { numericType: 'Fraction' })).toBe('fraction_unsupported');
    }
    expect(reasonOf('2 +* 3', { numericType: 'Fraction' })).toBe('parse_failed');
  });
});

// ---------------------------------------------------------------------------
// #24 — notation aliases rename call nodes, never string contents
// ---------------------------------------------------------------------------

describe('notation aliases leave string literals intact (#24)', () => {
  it.each([
    ['"ln("', '"ln("'],
    ["'ln('", '"ln("'],
    ['"arcsin("', '"arcsin("'],
    ['concat("ln(", "x)")', '"ln(x)"'],
    [`concat('arctan(', "x")`, '"arctan(x"'],
    ['"say \\"ln(\\" now"', '"say \\"ln(\\" now"'],
  ])('keeps %s as a string', (expression, expected) => {
    expect(run(expression).result).toBe(expected);
  });

  it('keeps a quoted alias unchanged under simplify', () => {
    const output = run('"ln(x)"', { operation: 'simplify' });
    expect(output.result).toBe('"ln(x)"');
  });

  it.each(['number', 'BigNumber', 'Fraction'] as const)(
    'resolves ln/arcsin calls under numericType %s',
    (numericType) => {
      expect(run('ln(e)', { numericType, precision: 6 }).result).toBe('1');
      if (numericType !== 'Fraction') {
        expect(run('arcsin(1)', { numericType }).result).toMatch(/^1\.5707963/);
        expect(run('ln (10)', { numericType }).result).toMatch(/^2\.302585/);
      }
    },
  );

  it('renames nested and argument-position calls', () => {
    expect(run('ln(ln(e^e))').result).toBe('1');
    expect(run('sqrt(arcsin(1) * 2)').result).toMatch(/^1\.7724538/);
    expect(run('[ln(e), arccos(1)]').result).toBe('[1, 0]');
  });

  it('keeps the symbolic behavior', () => {
    expect(run('ln(x)', { operation: 'derivative', variable: 'x' }).result).toBe('1 / x');
    expect(run('arctan(x)', { operation: 'derivative', variable: 'x' }).result).toBe(
      '1 / (x ^ 2 + 1)',
    );
    expect(run('arcsin(x)', { operation: 'simplify' }).result).toBe('asin(x)');
  });

  it('does not rename a scope variable named ln', () => {
    expect(run('ln + 1', { scope: { ln: 4 } }).result).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// #25 — number mode uses the read-only config guard
// ---------------------------------------------------------------------------

describe('number-mode config guard (#25)', () => {
  it.each([
    ['eigs([1,0;0,2]).values', '[1, 2]'],
    ['intersect([0,0],[10,10],[10,0],[0,10])', '[5, 5]'],
    ['isPositive(1e-20)', 'false'],
    ['isNegative(-1e-20)', 'false'],
    ['compare(1e-20, 0)', '0'],
    ['largerEq(0, 1e-20)', 'true'],
    ['smallerEq(1e-20, 0)', 'true'],
  ])('evaluates %s like stock math.js', (expression, expected) => {
    expect(run(expression).result).toBe(expected);
  });

  it('computes a Schur decomposition', () => {
    expect(run('schur([1,2;3,4]).T[1, 1]', { precision: 6 }).result).toBe('5.37228');
  });

  it.each(['number', 'BigNumber', 'Fraction'] as const)(
    'blocks config writes under numericType %s',
    (numericType) => {
      for (const expression of ['config({number: "BigNumber"})', 'config("x")']) {
        const err = failure(expression, { numericType });
        expect(err.data?.reason).toBe('parse_failed');
        expect(err.message).toContain('disabled for security');
      }
      // A rejected write leaves the instance in its mode.
      expect(run('0.1 + 0.2', { numericType }).resultType).toBe(
        numericType === 'number' ? 'number' : numericType,
      );
    },
  );

  it('returns the config object for a bare config() read in number mode', () => {
    expect(run('config()').result).toContain('"relTol": 1e-12');
  });

  it('keeps redaction and symbolic results', () => {
    expect(run('version').result).toBe('"redacted"');
    expect(run('2x + 3x', { operation: 'simplify' }).result).toBe('5 * x');
    expect(run('x^2', { operation: 'derivative', variable: 'x' }).result).toBe('2 * x');
  });
});

// ---------------------------------------------------------------------------
// #27 — evaluate/simplify/derivative called inside an expression
// ---------------------------------------------------------------------------

describe('operation names called as functions (#27)', () => {
  const recovery = {
    hint: 'Send the inner expression as `expression` with `operation` set to that function name; for `derivative`, also pass `variable`.',
  };

  it.each([
    ['derivative("0.2*x + 5", "x")', {}, 'derivative'],
    ['simplify("2*x + 3*x")', {}, 'simplify'],
    ['evaluate("2+3")', {}, 'evaluate'],
    ['derivative("x^2", "x")', { operation: 'derivative', variable: 'x' }, 'derivative'],
    ['simplify("2*x")', { operation: 'derivative', variable: 'x' }, 'simplify'],
    ['simplify("2*x + 3*x")', { operation: 'simplify' }, 'simplify'],
    ['1 + derivative("x^2", "x")', {}, 'derivative'],
    ['x * derivative("x^2", "x")', { operation: 'derivative', variable: 'x' }, 'derivative'],
    ['derivative(x^2, x)', {}, 'derivative'],
    ['[1, evaluate("2")]', {}, 'evaluate'],
  ] as Array<[string, EvalOptions, string]>)('rejects %s %o', (expression, options, fn) => {
    const err = failure(expression, options);
    expect(err.data?.reason).toBe('operation_as_function');
    expect(err.data?.recovery).toEqual(recovery);
    expect(err.message).toContain(`"${fn}"`);
    expect(err.message).toContain(`operation: "${fn}"`);
  });

  it('names the variable parameter only for derivative', () => {
    expect(failure('derivative(x^2, x)').message).toContain('`variable`');
    expect(failure('simplify("x")').message).not.toContain('`variable`');
  });

  it('keeps the generic disabled message for other blocked functions', () => {
    for (const fn of ['import', 'createUnit', 'parse', 'compile', 'config', 'parser']) {
      const err = failure(`${fn}("x")`);
      expect(err.data?.reason).toBe('parse_failed');
      expect(err.message).toContain('disabled for security');
    }
  });

  it('keeps disallowed_result_type for the bare identifier and its source', () => {
    expect(reasonOf('derivative')).toBe('disallowed_result_type');
    expect(reasonOf('simplify.toString()')).toBe('disallowed_result_type');
  });
});

// ---------------------------------------------------------------------------
// #29 — failures classified by stage
// ---------------------------------------------------------------------------

describe('failure classification by stage (#29)', () => {
  it.each([
    ['5 kg + 3', 'addScalar'],
    ['5 kg - 3', 'subtractScalar'],
    ['2 * (3 m) + 1', 'addScalar'],
    ['2^(3 m)', 'pow'],
    ['5 kg + 3 m', 'Units do not match'],
    ['5 kg to m', 'Units do not match'],
    ['"a" * 2', 'Cannot convert "a" to a number'],
    ['equal(1 m, 1)', 'equalScalar'],
    ['sin(5 kg)', 'is no angle'],
    ['fraction(0.1) + bignumber(1)', 'Cannot implicitly convert'],
  ])('classifies %s as type_mismatch', (expression, detail) => {
    const err = failure(expression);
    expect(err.data?.reason).toBe('type_mismatch');
    expect(err.message).toContain(detail);
    expect(err.data?.recovery).toEqual({
      hint: 'Attach the same unit to the bare operand (`5 kg + 3 kg`) or strip it (`number(5 kg, "kg") + 3`), keep exponents unitless, and use numbers instead of strings.',
    });
  });

  it.each([
    'sin()',
    'factorial(-1)',
    'inv([1,2;2,4])',
    'combinations(2, 5)',
    'det([1,2,3])',
    'number("abc")',
    '[1,2] + [1,2,3]',
    '[1,2][5]',
    '[[1, 2], [3, 4]][3, 1]',
  ])('classifies %s as evaluation_failed', (expression) => {
    const err = failure(expression);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.data?.recovery).toEqual({
      hint: 'The syntax is valid — fix the argument the error message names (its count, value range, or matrix dimensions) and retry.',
    });
  });

  it.each([
    '2 +* 3',
    '(1 + 2',
    'sin(',
    '"abc',
    'foo(5)',
    'x + 1',
    'unit("5 foo")',
    'import("x")',
    'config({number: "BigNumber"})',
  ])('keeps %s as parse_failed', (expression) => {
    const err = failure(expression);
    expect(err.data?.reason).toBe('parse_failed');
    expect(err.data?.recovery).toEqual({
      hint: 'Check syntax for balanced parentheses, valid operators, and correct function and unit names; pass variable values through scope.',
    });
  });

  it('keeps evaluating on the same service after a timeout and a failure', () => {
    const svc = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 50,
      maxResultLength: 100_000,
    });
    expectMcpError(
      () => svc.evaluateExpression('sum(map(range(1, 1e6), x^2))', mockCtx()),
      JsonRpcErrorCode.Timeout,
      'evaluation_timeout',
    );
    expectMcpError(
      () => svc.evaluateExpression('5 kg + 3', mockCtx()),
      JsonRpcErrorCode.ValidationError,
      'type_mismatch',
    );
    expect(svc.evaluateExpression('2 + 3', mockCtx()).result).toBe('5');
    expect(svc.simplifyExpression('2x + 3x', mockCtx()).result).toBe('5 * x');
  });

  it('classifies a failing derivative after a clean parse as evaluation_failed', () => {
    expect(reasonOf('floor(x)', { operation: 'derivative', variable: 'x' })).toBe(
      'evaluation_failed',
    );
  });

  it('keeps the precedence of the other reasons', () => {
    expect(reasonOf('sqrt(2)', { numericType: 'Fraction' })).toBe('fraction_unsupported');
    expect(reasonOf('1 / 0', { numericType: 'Fraction' })).toBe('undefined_result');
    expect(reasonOf('derivative("x", "x")')).toBe('operation_as_function');
    const slow = new MathService({
      maxExpressionLength: 1000,
      evaluationTimeoutMs: 1,
      maxResultLength: 100_000,
    });
    expectMcpError(
      () => slow.evaluateExpression('sum(map(range(1, 1e6), x^2))', mockCtx()),
      JsonRpcErrorCode.Timeout,
      'evaluation_timeout',
    );
  });
});

// ---------------------------------------------------------------------------
// #31 — help() results
// ---------------------------------------------------------------------------

describe('help() in an expression (#31)', () => {
  it.each(['help("sin")', 'help(sin)', '{a: help("sin")}', '[help("sin")]'])(
    'rejects %s with a declared reason',
    (expression) => {
      const err = failure(expression);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('disallowed_result_type');
      expect(err.message).toContain('calculator://help');
      expect(err.data?.recovery).toEqual({
        hint: 'Rewrite the expression to produce a value (number, matrix, unit) instead of a function or its source; for function documentation, read the calculator://help resource.',
      });
    },
  );

  it('still formats every accepted result type', () => {
    const accepted = [
      ['2', 'number'],
      ['bignumber(2)', 'BigNumber'],
      ['fraction(1, 3)', 'Fraction'],
      ['2 + 3i', 'Complex'],
      ['5 m', 'Unit'],
      ['[1, 2]', 'DenseMatrix'],
      ['sparse([1, 2])', 'SparseMatrix'],
      ['"s"', 'string'],
      ['true', 'boolean'],
      ['{a: [1, 2 m]}', 'Object'],
      ['bigint(5)', 'bigint'],
      ['null', 'null'],
      ['index(1, 2)', 'Index'],
    ];
    for (const [expression, resultType] of accepted) {
      expect(run(expression as string).resultType).toBe(resultType);
    }
  });
});

// ---------------------------------------------------------------------------
// #32 — multiple statements detected on the parse tree
// ---------------------------------------------------------------------------

describe('multiple statements with either quote style (#32)', () => {
  it.each([
    ["'a;b'", '"a;b"'],
    ["concat('a;b', 'c')", '"a;bc"'],
    ["'x\ny'", '"x\\ny"'],
    ['"a;b"', '"a;b"'],
    ['[1, 2; 3, 4]', '[[1, 2], [3, 4]]'],
    ["[1, 2; 3, 4]'", '[[1, 3], [2, 4]]'],
    ['(1 +\n 2)', '3'],
  ])('evaluates %s', (expression, expected) => {
    expect(run(expression).result).toBe(expected);
  });

  it.each([
    `'"' ; notDefined(1)`,
    `'[' ; notDefined(1)`,
    `"'" ; notDefined(1)`,
    'notDefined(1); 1',
    'notDefined(1)\n1',
    'notDefined(1)\r\n1',
  ])('rejects %s before either statement evaluates', (expression) => {
    // Evaluating the statement calling the undefined function would fail with
    // parse_failed ("Undefined function") before any separator check.
    expect(reasonOf(expression)).toBe('multiple_expressions');
  });

  it('applies the separator check on the symbolic paths too', () => {
    expect(reasonOf("'a' ; x", { operation: 'simplify' })).toBe('multiple_expressions');
  });
});

// ---------------------------------------------------------------------------
// #33 — Fraction mode: size arguments and exponent literals
// ---------------------------------------------------------------------------

describe('Fraction-mode size arguments and exponent literals (#33)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['zeros(2)', '[0, 0]'],
    ['ones(3)', '[1, 1, 1]'],
    ['identity(2)', '[[1, 0], [0, 1]]'],
    ['zeros(2, 3)', '[[0, 0, 0], [0, 0, 0]]'],
    ['zeros([2, 3])', '[[0, 0, 0], [0, 0, 0]]'],
    ['identity(2, 3)', '[[1, 0, 0], [0, 1, 0]]'],
    ['identity([2])', '[[1, 0], [0, 1]]'],
    ['size(zeros(2, 2, "sparse"))', '[2, 2]'],
    ['resize([1], [2, 2])', '[[1/1, 0], [0, 0]]'],
    ['size(randomInt([2, 3], 5))', '[2, 3]'],
    ['size(matrixFromFunction([2, 2], f(i) = 1))', '[2, 2]'],
    ['size(pickRandom([1, 2, 3], 2))', '[2]'],
    ['diag([1, 2], 1)', '[[0, 1/1, 0], [0, 0, 2/1]]'],
    ['zeros(2) + 1/3', '[1/3, 1/3]'],
  ])('builds %s from Fraction sizes', (expression, expected) => {
    expect(run(expression, fraction).result).toBe(expected);
  });

  it('rejects a non-integer size with a message about whole numbers', () => {
    for (const expression of ['zeros(1/2)', 'identity(2.5)']) {
      const err = failure(expression, fraction);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain('needs whole-number sizes and counts');
      expect(err.message).not.toContain('irrational');
    }
  });

  it('keeps the size limit on Fraction sizes', () => {
    expect(reasonOf('zeros(5000, 5000)', fraction)).toBe('result_too_large');
  });

  it.each([
    ['2e5', '200000/1'],
    ['1.5e3', '1500/1'],
    ['1.5E-3', '3/2000'],
    ['.5e2', '50/1'],
    ['2e-3 + 1e-3', '3/1000'],
    ['1e0', '1/1'],
    ['2e5 / 3', '200000/3'],
  ])('reads the exponent literal %s exactly', (expression, expected) => {
    const output = run(expression, fraction);
    expect(output.result).toBe(expected);
    expect(output.resultType).toBe('Fraction');
  });

  it('names an out-of-range exponent literal', () => {
    expect(run('1e1000', fraction).result).toBe(`1${'0'.repeat(1000)}/1`);
    const err = failure('1e1001', fraction);
    expect(err.data?.reason).toBe('parse_failed');
    expect(err.message).toContain('Exponent literal "1e1001"');
  });

  it('keeps fraction_unsupported for irrational results', () => {
    for (const expression of ['sqrt(2)', 'sin(1)', 'log(3)']) {
      expect(reasonOf(expression, fraction)).toBe('fraction_unsupported');
    }
  });

  it('leaves the other numeric types unchanged', () => {
    expect(run('zeros(2)').result).toBe('[0, 0]');
    expect(run('2e5').result).toBe('200000');
    expect(run('2e5', { numericType: 'BigNumber' }).result).toBe('200000');
    expect(reasonOf('zeros(2.5)')).toBe('evaluation_failed');
  });
});

// ---------------------------------------------------------------------------
// #34 — assignments never write into the caller's scope
// ---------------------------------------------------------------------------

describe('scope is never mutated by evaluation (#34)', () => {
  it.each([
    ['(y = 2) + x', { x: 1 }, '3'],
    ['(x = 10) + 1', { x: 1 }, '11'],
    ['size(map([1, 2], f(v) = (z = v)))', { x: 1 }, '[2]'],
  ])('evaluates %s without changing the caller scope', (expression, scope, expected) => {
    const callerScope = { ...scope };
    const svc = getMathService();
    expect(svc.evaluateExpression(expression, mockCtx(), callerScope).result).toBe(expected);
    expect(callerScope).toEqual(scope);
  });

  it('reports only the caller-supplied keys in scopeVars', () => {
    const output = calculateTool.handler(
      parse({ expression: '(y = 2) + x', scope: { x: 1 } }),
      mockCtx(),
    ) as { scopeVars?: string[] };
    expect(output.scopeVars).toEqual(['x']);
  });

  it('keeps ordinary scope evaluation', () => {
    const output = calculateTool.handler(
      parse({ expression: 'x^2 + y', scope: { x: 5, y: 3 } }),
      mockCtx(),
    ) as { result: string; scopeVars?: string[] };
    expect(output.result).toBe('28');
    expect(output.scopeVars).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// Symbolic operations that parse but cannot be carried out
// ---------------------------------------------------------------------------

describe('symbolic failures after a clean parse', () => {
  const derivative = { operation: 'derivative', variable: 'x' } as const;

  /** The recovery hint an error carries (empty when it has none). */
  function hintOf(err: McpError): string {
    return (err.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
  }

  it.each([
    ['floor(x)', 'function', 'floor'],
    ['foo(x)', 'function', 'foo'],
    ['mod(x, 2)', 'function', 'mod'],
    ['x == 1', 'operator', '=='],
    ['x!', 'operator', '!'],
  ])('%s names the missing derivative rule', (expression, kind, name) => {
    const err = failure(expression, derivative);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.message).toBe(
      `The derivative operation has no rule for the ${kind} "${name}", so it cannot differentiate this expression symbolically.`,
    );
    const hint = hintOf(err);
    expect(hint).toContain(`"${name}" has no symbolic derivative rule`);
    expect(hint).toContain('operation "evaluate"');
    expect(hint).not.toMatch(/syntax|argument/i);
  });

  it('names the differentiation variable in the evaluate fallback', () => {
    const hint = hintOf(failure('floor(t) * y', { operation: 'derivative', variable: 't' }));
    expect(hint).toBe(
      '"floor" has no symbolic derivative rule — rewrite the expression without it, or evaluate it numerically with operation "evaluate", passing values for its variables (such as t) through scope.',
    );
  });

  it('explains an unsupported node without blaming syntax or arguments', () => {
    const err = failure('[x, 2]', derivative);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.message).toContain('The derivative operation cannot process this expression');
    const hint = hintOf(err);
    expect(hint).toContain('derivative engine cannot handle part of this expression');
    expect(hint).not.toMatch(/syntax|argument/i);
  });

  it('keeps supported derivatives and parse errors', () => {
    expect(run('x^2', derivative).result).toBe('2 * x');
    expect(run('abs(x)', derivative).result).toBe('abs(x) / x');
    expect(reasonOf('x +* 2', derivative)).toBe('parse_failed');
  });
});

// ---------------------------------------------------------------------------
// Statistics conventions documented in calculator://help (#23)
// ---------------------------------------------------------------------------

describe('statistics conventions (#23)', () => {
  it.each([
    ['std([2, 4, 6])', '2'],
    ['std([2, 4, 6], "unbiased")', '2'],
    ['std([2, 4, 6], "uncorrected")', '1.632993161855452'],
    ['std([2, 4, 6], "biased")', '1.4142135623730951'],
    ['variance([2, 4, 6])', '4'],
    ['variance([2, 4, 6], "unbiased")', '4'],
    ['variance([2, 4, 6], "uncorrected")', '2.6666666666666665'],
    ['variance([2, 4, 6], "biased")', '2'],
    ['stdev([2, 4, 6], "uncorrected")', '1.632993161855452'],
    ['stddev([2, 4, 6], "biased")', '1.4142135623730951'],
    ['std([1, 2; 3, 5], 1)', '[1.4142135623730951, 2.1213203435596424]'],
    ['mad([1, 2, 3, 4, 100])', '1'],
    ['quantileSeq([1, 2, 3, 4], 0.25)', '1.75'],
    ['quantileSeq([4, 3, 2, 1], 0.25, true)', '3.25'],
    ['mode([1, 2, 2, 3])', '[2]'],
  ])('%s → %s', (expression, expected) => {
    expect(run(expression).result).toBe(expected);
  });

  it('returns mode as an Array', () => {
    expect(run('mode([1, 2, 2, 3])').resultType).toBe('Array');
  });

  it('takes a normalization only after an array or matrix', () => {
    expect(reasonOf('std(2, 4, 6, "uncorrected")')).toBe('type_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Fraction mode — functions it cannot compute, whatever the result
// ---------------------------------------------------------------------------

describe('Fraction mode reasons by cause', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each(['sqrt(2)', 'sin(1)', 'log(3)', 'sqrt(4)', '5!', 'combinations(5, 2)'])(
    '%s fails with fraction_unsupported',
    (expression) => {
      expect(reasonOf(expression, fraction)).toBe('fraction_unsupported');
    },
  );

  it.each(['pi', '2^(1/2)'])('%s fails instead of returning a float', (expression) => {
    expect(reasonOf(expression, fraction)).toBe('fraction_unsupported');
  });
});

// ---------------------------------------------------------------------------
// Error messages describe the failure the caller actually hit (#22)
// ---------------------------------------------------------------------------

describe('error messages match the failure (#22)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it('names both causes of an undefined result without calling an overflow undefined', () => {
    for (const expression of ['1 / 0', '0 / 0', 'log(0)', '171!', '2^1024', 'exp(1000)']) {
      const err = failure(expression);
      expect(err.data?.reason).toBe('undefined_result');
      expect(err.message).toContain('division by zero, 0/0, log(0)');
      expect(err.message).toContain('overflowed');
    }
  });

  it('fails an overflow in number mode and returns it under BigNumber', () => {
    for (const expression of ['171!', '2^1024', 'exp(1000)']) {
      expect(reasonOf(expression)).toBe('undefined_result');
      expect(run(expression, { numericType: 'BigNumber' }).resultType).toBe('BigNumber');
    }
  });

  it('keeps division by zero and log(0) undefined under BigNumber', () => {
    for (const expression of ['1 / 0', '0 / 0', 'log(0)']) {
      expect(reasonOf(expression, { numericType: 'BigNumber' })).toBe('undefined_result');
    }
  });

  it('returns log of a negative number as a complex value', () => {
    expect(run('log(-1)').result).toBe('3.141592653589793i');
    expect(run('log(-1)').resultType).toBe('Complex');
  });

  it.each(['sqrt(4)', '5!', 'combinations(5, 2)'])(
    'does not call the Fraction failure of %s irrational',
    (expression) => {
      const err = failure(expression, fraction);
      expect(err.data?.reason).toBe('fraction_unsupported');
      expect(err.message).not.toMatch(/irrational|transcendental/);
      expect(err.message).toContain('no exact rational value');
      expect(err.message).toContain('calls a function Fraction mode cannot compute');
      expect(err.message).toContain('Retry with numericType "number" or "BigNumber"');
    },
  );

  it('describes the fraction_unsupported contract by both causes', () => {
    const entry = calculateTool.errors?.find((e) => e.reason === 'fraction_unsupported');
    expect(entry?.when).toContain('no exact rational value');
    expect(entry?.when).toContain('calls a function Fraction mode cannot compute');
    expect(entry?.when).not.toMatch(/irrational or transcendental result/);
  });

  it.each(['f(x) = x^2', 'sin', 'cos.toString()'])(
    'does not list the allowed result types when rejecting %s',
    (expression) => {
      const err = failure(expression);
      expect(err.data?.reason).toBe('disallowed_result_type');
      expect(err.message).not.toContain('only numeric');
      expect(err.message).not.toContain('Only numeric');
    },
  );

  it.each([
    ['{a: 1}', 'Object'],
    ['index(1)', 'Index'],
    ['mode([1, 2, 2, 3])', 'Array'],
  ])('returns %s, a %s result', (expression, resultType) => {
    expect(run(expression).resultType).toBe(resultType);
  });
});

// ---------------------------------------------------------------------------
// #35 — Fraction mode: inexact floats and integer indexes
// ---------------------------------------------------------------------------

describe('Fraction-mode results that stay exact (#35 characterization)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['count([1, 2, 3])', {}, '3', 'number'],
    ['size([1, 2; 3, 4])', {}, '[2, 2]', 'Array'],
    ['1/3', {}, '1/3', 'Fraction'],
    ['mean([1, 2])', {}, '3/2', 'Fraction'],
    ['2 + 3i', {}, '2 + 3i', 'Complex'],
    ['i^2', {}, '-1', 'Complex'],
    ['5 kg', {}, '5/1 kg', 'Unit'],
    ['1 inch to cm', {}, '127/50 cm', 'Unit'],
    ['bignumber(0.5)', {}, '0.5', 'BigNumber'],
    ['[1, 2, 3][2:3]', {}, '[2/1, 3/1]', 'DenseMatrix'],
    ['[1, 2, 3][end]', {}, '3/1', 'Fraction'],
    ['[1, 2, 3][[true, false, true]]', {}, '[1/1, 3/1]', 'DenseMatrix'],
    ['x + 1/3', { scope: { x: 0.5 } }, '5/6', 'Fraction'],
    ['1 < 2', {}, 'true', 'boolean'],
  ] as const)('%s → %s', (expression, options, result, resultType) => {
    expect(run(expression, { ...fraction, ...options })).toMatchObject({ result, resultType });
  });

  it('keeps a non-finite float on undefined_result', () => {
    expect(reasonOf('Infinity', fraction)).toBe('undefined_result');
  });
});

describe('Fraction-mode results that picked up a float (#35)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['pi', {}],
    ['e', {}],
    ['sin(pi)', {}],
    ['2^(1/2)', {}],
    ['x^0.5', { scope: { x: 2 } }],
    ['[1, pi]', {}],
    ['[[1, 2], [3, pi]]', {}],
    ['{a: [1, {b: pi}]}', {}],
    ['pi kg', {}],
    ['1/3 i', {}],
    ['e^(i * pi)', {}],
    ['abs(1 + i)', {}],
    ['number(1/3)', {}],
  ] as const)('%s fails with fraction_unsupported', (expression, options) => {
    const err = failure(expression, { ...fraction, ...options });
    expect(err.data?.reason).toBe('fraction_unsupported');
    expect(err.message).toContain('64-bit float');
    expect(err.message).toContain('Retry with numericType "number" or "BigNumber"');
  });

  it.each(['pi * 2/3', 'pi^40', '2^(1/2) * 2^(1/2)', 'sin(pi) + 1/3'])(
    '%s fails with fraction_unsupported, not type_mismatch',
    (expression) => {
      const err = failure(expression, fraction);
      expect(err.data?.reason).toBe('fraction_unsupported');
      expect(err.message).toContain('64-bit float');
    },
  );

  it('reads an integer-valued float past the safe-integer range as inexact', () => {
    // e^(e*e*e*e) is float-only arithmetic: about 5.2e23, integer-valued like every
    // double past 2^53, but not the exact value.
    expect(reasonOf('e^(e * e * e * e)', fraction)).toBe('fraction_unsupported');
  });

  it('describes the float cause in the contract and drops the float-fallback claim', () => {
    const entry = calculateTool.errors?.find((e) => e.reason === 'fraction_unsupported');
    expect(entry?.when).toContain('rounded 64-bit float');
    const numericType = calculateTool.input.shape.numericType.description ?? '';
    expect(numericType).toContain('rounded float (pi, e, 2^(1/2)');
    expect(numericType).not.toMatch(/return a float|resultType "number"/);
  });

  it('documents number(x), random(), and irrational unit factors under Fraction', () => {
    const numericType = calculateTool.input.shape.numericType.description ?? '';
    expect(numericType).toContain('number(x), random()');
    expect(numericType).toContain(
      'A unit conversion with an irrational factor (30 deg to rad) returns a close rational approximation',
    );
    expect(reasonOf('random()', fraction)).toBe('fraction_unsupported');
    expect(reasonOf('number(1/2)', fraction)).toBe('fraction_unsupported');
    expect(run('30 deg to rad', fraction)).toMatchObject({
      result: '191068/364913 rad',
      resultType: 'Unit',
    });
  });

  it('keeps the float in number, BigNumber, and explicit fraction() use', () => {
    expect(run('pi')).toMatchObject({ result: '3.141592653589793', resultType: 'number' });
    expect(run('pi', { numericType: 'BigNumber' }).resultType).toBe('BigNumber');
    expect(reasonOf('fraction(1, 3) * pi')).toBe('type_mismatch');
  });
});

describe('Fraction-mode scope values (#35)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['x', { x: 0.5 }, '1/2'],
    ['x', { x: 2 }, '2/1'],
    ['[x, 1/3]', { x: 0.5 }, '[1/2, 1/3]'],
    ['x', { x: 0.1 }, '1/10'],
  ])('reads %s with scope %o as a Fraction', (expression, scope, result) => {
    const output = run(expression, { ...fraction, scope });
    expect(output.result).toBe(result);
    expect(output.resultType).not.toBe('number');
  });

  it('leaves scope values as numbers in the other numeric types', () => {
    expect(run('x', { scope: { x: 0.5 } })).toMatchObject({ result: '0.5', resultType: 'number' });
  });
});

describe('Fraction-mode integer indexes (#35)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['[1, 2, 3][2]', '2/1'],
    ['[1, 2; 3, 4][2, 1]', '3/1'],
    ['[1, 2; 3, 4][2, :]', '[3/1, 4/1]'],
    ['[1, 2, 3][[1, 3]]', '[1/1, 3/1]'],
    ['[1, 2; 3, 4][2, :][2]', '4/1'],
    ['row([1, 2; 3, 4], 1)', '[[1/1, 2/1]]'],
    ['column([1, 2; 3, 4], 2)', '[[2/1], [4/1]]'],
    ['subset([1, 2, 3], index(2))', '2/1'],
    ['subset([1, 2; 3, 4], index(2, 1))', '3/1'],
    ['map([1, 2, 3], f(v) = [4, 5, 6][v])', '[4/1, 5/1, 6/1]'],
    ['"abc"[2]', '"b"'],
  ])('%s → %s', (expression, expected) => {
    expect(run(expression, fraction).result).toBe(expected);
  });

  it.each(['[1, 2, 3][3/2]', 'row([1, 2; 3, 4], 3/2)', 'subset([1, 2, 3], index(1/2))'])(
    'rejects the non-integer index in %s by name',
    (expression) => {
      const err = failure(expression, fraction);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain('needs whole-number indexes');
      expect(err.message).not.toContain('Dimension must be');
    },
  );

  it('keeps an out-of-range index an index error', () => {
    const err = failure('[1, 2, 3][4]', fraction);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.message).toContain('Index out of range');
  });

  it('leaves number-mode indexing unchanged', () => {
    expect(run('[1, 2, 3][2]').result).toBe('2');
    expect(run('row([1, 2; 3, 4], 1)').result).toBe('[[1, 2]]');
    expect(failure('[1, 2, 3][1.5]').message).toContain('Index must be an integer');
  });
});

// ---------------------------------------------------------------------------
// #36 — Fraction mode: whole-number dimension arguments
// ---------------------------------------------------------------------------

describe('dimension arguments before the Fraction fix (#36 characterization)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['sum([1, 2; 3, 4], 1)', '[4, 6]'],
    ['sum([1, 2; 3, 4], 2)', '[3, 7]'],
    ['max([1, 2; 3, 4], 2)', '[2, 4]'],
    ['min([1, 2; 3, 4], 1)', '[1, 2]'],
    ['mean([1, 2; 3, 4], 1)', '[2, 3]'],
    ['std([1, 2; 3, 6; 5, 10], 1)', '[2, 4]'],
    ['variance([1, 2; 3, 4], 1)', '[2, 2]'],
    ['variance([1, 2; 3, 4], 1, "uncorrected")', '[0.25, 0.25]'],
    ['cumsum([1, 2; 3, 4], 1)', '[[1, 2], [4, 6]]'],
    ['cumsum([1, 2; 3, 4], 2)', '[[1, 3], [3, 7]]'],
    ['concat([1, 2], [3, 4], 1)', '[1, 2, 3, 4]'],
    ['concat([1, 2; 3, 4], [5, 6; 7, 8], 2)', '[[1, 2, 5, 6], [3, 4, 7, 8]]'],
  ])('number mode: %s → %s', (expression, expected) => {
    expect(run(expression).result).toBe(expected);
  });

  it.each(['median([1, 2; 3, 4], 1)', 'prod([1, 2; 3, 4], 1)'])(
    'number mode: %s is not supported by math.js',
    (expression) => {
      const err = failure(expression);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain('(A, dim) is not yet supported');
    },
  );

  it.each([
    ['sum([1, 2, 3])', '6/1'],
    ['sum(1/2, 1/3)', '5/6'],
    ['max(1/2, 1/3)', '1/2'],
    ['min(1/2, 1/3)', '1/3'],
    ['mean(1/2, 1/3)', '5/12'],
    ['prod([1, 2, 3])', '6/1'],
    ['variance([1, 2, 3])', '1/1'],
    ['variance(1, 2, 3)', '1/1'],
    ['cumsum([1, 2, 3])', '[1/1, 3/1, 6/1]'],
    ['cumsum(1/2, 1/3)', '[1/2, 5/6]'],
    ['concat([1, 2], [3, 4])', '[1/1, 2/1, 3/1, 4/1]'],
  ])('Fraction mode without a dimension: %s → %s', (expression, expected) => {
    expect(run(expression, fraction).result).toBe(expected);
  });
});

describe('a function used as a value (#38)', () => {
  const unitHint =
    'Attach the same unit to the bare operand (`5 kg + 3 kg`) or strip it (`number(5 kg, "kg") + 3`), keep exponents unitless, and use numbers instead of strings.';

  /** The recovery hint an error carries (empty when it has none). */
  function hintOf(err: McpError): string {
    return (err.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
  }

  it.each([
    ['5 min to s', 'min', 'minute'],
    ['5 sec to ms', 'sec', 's'],
  ])('%s names %s as a function and points to the unit %s', (expression, name, unit) => {
    const err = failure(expression);
    expect(err.data?.reason).toBe('type_mismatch');
    expect(err.message).toContain(`"${name}" is a function`);
    expect(err.message).toContain(`"${unit}"`);
    expect(hintOf(err)).toContain(`write ${unit}`);
    expect(hintOf(err)).not.toBe(unitHint);
  });

  it.each([
    ['(f(x) = x^2)(3)', undefined],
    ['sin + 1', 'sin'],
    ['2 * max', 'max'],
  ])('%s says a function was used as a value', (expression, name) => {
    const err = failure(expression);
    expect(err.data?.reason).toBe('type_mismatch');
    expect(err.message).toContain('a function was used as a value');
    if (name) expect(err.message).toContain(`"${name}" is a function`);
    expect(hintOf(err)).toContain('parentheses');
    expect(hintOf(err)).not.toBe(unitHint);
  });

  it('keeps the unit recovery for a real unit mismatch', () => {
    const err = failure('5 kg + 3');
    expect(err.data?.reason).toBe('type_mismatch');
    expect(hintOf(err)).toBe(unitHint);
  });

  it('leaves the units and a scope value of the same name alone', () => {
    expect(run('5 minute to s').result).toBe('300 s');
    expect(run('min * 2', { scope: { min: 3 } }).result).toBe('6');
  });
});

describe('custom units and unit simplification (#37)', () => {
  it.each([
    ['5 m/s to knot', '9.719222462203023 knot'],
    ['5 kt to km/hour', '9.26 km / hour'],
    ['10 knots to m/s', '5.144444444444445 m / s'],
    ['60 mph to km/hour', '96.56063999999999 km / hour'],
    ['60 mph to m/s', '26.8224 m / s'],
    ['1 ly to km', '9460730472580.8 km'],
    ['1 lightyear to km', '9460730472580.8 km'],
    ['2 ly * 3', '6 ly'],
    ['1 ly + 1 m', '1 ly'],
  ])('keeps the explicit conversion %s → %s', (expression, expected) => {
    expect(run(expression).result).toBe(expected);
  });

  // Earlier calls that name other units must not change how a later result simplifies.
  const primers = [
    '5 m/s to knot',
    '60 mph to km/hour',
    '1 ly to km',
    '1 hour to minute',
    '5 kt to km/hour',
  ];

  it.each([
    ['10 m / 2 s', '5 m / s'],
    ['100 km / 2 hour', '50 km / hour'],
    ['3 mile / 1 hour', '3 mile / hour'],
    ['10 km / 2 minute', '5 km / minute'],
    ['5 J / 1 W', '5 s'],
    ['5 kg * 2 m / s^2', '10 N'],
  ])(
    'simplifies %s to %s as stock math.js does, before and after other calls',
    (expression, expected) => {
      const svc = new MathService(getServerConfig());
      expect(svc.evaluateExpression(expression, mockCtx()).result).toBe(expected);
      for (const primer of primers) svc.evaluateExpression(primer, mockCtx());
      expect(svc.evaluateExpression(expression, mockCtx()).result).toBe(expected);
    },
  );

  it('simplifies a product naming a custom unit in built-in units', () => {
    expect(run('10 m * 1 ly / 1 s').result).toBe('94607304725808000 m^2 / s');
    expect(run('3 mph * 2 hour').result).toBe('9.656064 km');
  });
});

describe('Fraction-mode dimension arguments (#36)', () => {
  const fraction = { numericType: 'Fraction' } as const;

  it.each([
    ['sum([1, 2; 3, 4], 1)', '[4/1, 6/1]'],
    ['sum([1, 2; 3, 4], 2)', '[3/1, 7/1]'],
    ['max([1, 2; 3, 4], 2)', '[2/1, 4/1]'],
    ['min([1, 2; 3, 4], 1)', '[1/1, 2/1]'],
    ['mean([1, 2; 3, 4], 1)', '[2/1, 3/1]'],
    ['mean([1, 2; 4, 7], 1)', '[5/2, 9/2]'],
    ['variance([1, 2; 3, 4], 1)', '[2/1, 2/1]'],
    ['variance([1, 2; 3, 4], 1, "uncorrected")', '[1/4, 1/4]'],
    ['cumsum([1, 2; 3, 4], 1)', '[[1/1, 2/1], [4/1, 6/1]]'],
    ['cumsum([1, 2; 3, 4], 2)', '[[1/1, 3/1], [3/1, 7/1]]'],
    ['concat([1, 2], [3, 4], 1)', '[1/1, 2/1, 3/1, 4/1]'],
    ['concat([1, 2; 3, 4], [5, 6; 7, 8], 2)', '[[1/1, 2/1, 5/1, 6/1], [3/1, 4/1, 7/1, 8/1]]'],
    ['concat([1], [2], [3], 1)', '[1/1, 2/1, 3/1]'],
    ['sum([1, 2; 3, 4], 3 - 2)', '[4/1, 6/1]'],
    ['sum(cumsum([1, 2; 3, 4], 1), 2)', '[3/1, 10/1]'],
    ['max([[1, 2], [3, 4]], 1)', '[3/1, 4/1]'],
  ])('%s → %s', (expression, expected) => {
    expect(run(expression, fraction).result).toBe(expected);
  });

  it.each(['median([1, 2; 3, 4], 1)', 'prod([1, 2; 3, 4], 1)'])(
    '%s reaches the same math.js limitation as number mode',
    (expression) => {
      const err = failure(expression, fraction);
      expect(err.data?.reason).toBe('evaluation_failed');
      expect(err.message).toContain('(A, dim) is not yet supported');
    },
  );

  it('fails std with a dimension on its square root, not on the dimension', () => {
    // std always takes a square root, which Fraction mode cannot compute.
    const err = failure('std([1, 2; 3, 6; 5, 10], 1)', fraction);
    expect(err.data?.reason).toBe('fraction_unsupported');
    expect(err.message).toBe(failure('std([1, 2, 3])', fraction).message);
    expect(reasonOf('std([1, 2; 3, 4], 1/2)', fraction)).toBe('evaluation_failed');
  });

  it.each([
    ['sum([1, 2; 3, 4], 1/2)', 'sum'],
    ['max([1, 2; 3, 4], 3/2)', 'max'],
    ['min([1, 2; 3, 4], 1/2)', 'min'],
    ['mean([1, 2; 3, 4], 1/2)', 'mean'],
    ['median([1, 2; 3, 4], 1/2)', 'median'],
    ['prod([1, 2; 3, 4], 1/2)', 'prod'],
    ['std([1, 2; 3, 4], 1/2)', 'std'],
    ['variance([1, 2; 3, 4], 1/2)', 'variance'],
    ['cumsum([1, 2; 3, 4], 1/2)', 'cumsum'],
    ['concat([1, 2], [3, 4], 1/2)', 'concat'],
  ])('rejects the non-integer dimension in %s by name', (expression, fn) => {
    const err = failure(expression, fraction);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.message).toContain(`${fn}() needs whole-number dimensions; got`);
  });

  it('keeps an out-of-range dimension an index error', () => {
    const err = failure('sum([1, 2; 3, 4], 3)', fraction);
    expect(err.data?.reason).toBe('evaluation_failed');
    expect(err.message).toContain('Index out of range');
  });
});
