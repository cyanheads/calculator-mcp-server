/**
 * @fileoverview Hardened math.js wrapper for secure expression evaluation.
 * Creates a restricted math.js instance with dangerous functions disabled in
 * the expression scope, and wraps evaluation in a vm sandbox with timeout.
 * @module services/math/math-service
 */

import vm from 'node:vm';
import { invalidParams, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { all, create, type SimplifyRule } from 'mathjs';
import type { ServerConfig } from '@/config/server-config.js';
import type { MathResult } from './types.js';

/**
 * Custom simplification rules extending math.js defaults.
 * math.js ships with algebraic rules only — these add common trig identities.
 * The `n` wildcard matches any sub-expression (e.g., sin(2x+1)^2).
 */
const TRIG_SIMPLIFY_RULES: SimplifyRule[] = [
  // Pythagorean identities
  'sin(n)^2 + cos(n)^2 -> 1',
  'cos(n)^2 + sin(n)^2 -> 1',
  '1 - sin(n)^2 -> cos(n)^2',
  '1 - cos(n)^2 -> sin(n)^2',
  // tan / sec / csc / cot relationships
  'tan(n)^2 + 1 -> sec(n)^2',
  '1 + tan(n)^2 -> sec(n)^2',
  'sec(n)^2 - 1 -> tan(n)^2',
  '1 + cot(n)^2 -> csc(n)^2',
  'cot(n)^2 + 1 -> csc(n)^2',
  'csc(n)^2 - 1 -> cot(n)^2',
  // Double-angle identities
  '2 * sin(n) * cos(n) -> sin(2 * n)',
  'cos(n)^2 - sin(n)^2 -> cos(2 * n)',
];

/**
 * Functions disabled in the expression scope for security.
 * These are overridden via math.import() — expressions cannot call them.
 * simplify/derivative are called programmatically by the tool handler, not from expressions.
 */
const DISABLED_FUNCTIONS = [
  'import',
  'createUnit',
  'evaluate',
  'parse',
  'simplify',
  'derivative',
  'resolve',
  'reviver',
  'compile',
  'chain',
  'config',
  'parser',
] as const;

/**
 * `typed` is NOT disabled here — it's used internally by math.js for function dispatch.
 * Overriding it breaks trig/simplify/etc. Instead, `typed()` calls from expressions are
 * caught by the BLOCKED_RESULT_TYPES check (resultType "function" is rejected).
 */

/**
 * Constants/properties overridden in the expression scope to prevent info leakage.
 * `version` exposes the exact math.js version (enables targeted CVE research).
 */
const REDACTED_CONSTANTS: Record<string, string> = {
  version: 'redacted',
};

/**
 * Result types that must never be returned to clients.
 * Function references leak internal source code via toString().
 * ResultSet indicates multi-expression evaluation (newline bypass).
 */
const BLOCKED_RESULT_TYPES = new Set(['function', 'Function', 'ResultSet', 'Parser']);

/**
 * Scope key names that could pollute the object prototype chain or shadow
 * critical Object.prototype methods. Validated before passing to math.js.
 */
const BLOCKED_SCOPE_KEYS = new Set([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

/**
 * Check for expression separators outside square brackets.
 * Semicolons inside `[...]` are valid matrix row separators.
 * Newlines (`\n`, `\r`) are also expression separators in math.js.
 */
function hasExpressionSeparator(expr: string): boolean {
  let depth = 0;
  for (const ch of expr) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '\n' || ch === '\r') return true;
    else if (ch === ';' && depth === 0) return true;
  }
  return false;
}

export class MathService {
  private readonly evaluate: (expr: string, scope?: Record<string, number>) => unknown;
  private readonly simplify: (expr: string, rules?: SimplifyRule[]) => { toString(): string };
  private readonly derivative: (expr: string, variable: string) => { toString(): string };
  private readonly simplifyRules: SimplifyRule[];
  private readonly format: (value: unknown, options?: { precision?: number }) => string;
  private readonly typeOf: (value: unknown) => string;
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    // biome-ignore lint/style/noNonNullAssertion: math.js types declare `all` as potentially undefined, but it's always defined at runtime
    const math = create(all!);

    // Save references before overriding — these bypass the expression scope restrictions
    this.evaluate = math.evaluate.bind(math);
    this.simplify = math.simplify.bind(math);
    this.derivative = math.derivative.bind(math);
    this.simplifyRules = [...math.simplify.rules, ...TRIG_SIMPLIFY_RULES];
    this.format = math.format.bind(math);
    this.typeOf = math.typeOf.bind(math);

    // Disable dangerous functions in expression scope
    const disabled: Record<string, unknown> = {};
    for (const fn of DISABLED_FUNCTIONS) {
      disabled[fn] = () => {
        throw new Error(`Function "${fn}" is disabled for security.`);
      };
    }
    // Redact constants that leak implementation details
    for (const [key, value] of Object.entries(REDACTED_CONSTANTS)) {
      disabled[key] = value;
    }
    math.import(disabled, { override: true });
  }

  /** Evaluate a math expression with optional variable scope and precision. */
  evaluateExpression(
    expression: string,
    scope?: Record<string, number>,
    precision?: number,
  ): MathResult {
    this.validateInput(expression);
    const sanitizedScope = scope ? this.sanitizeScope(scope) : undefined;
    const raw = this.runWithTimeout(() =>
      sanitizedScope ? this.evaluate(expression, sanitizedScope) : this.evaluate(expression),
    );
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      throw invalidParams(
        `Expression evaluated to ${raw} — this typically means the operation is mathematically undefined (e.g., division by zero, log of zero). Check the expression.`,
      );
    }
    const resultType = this.typeOf(raw);
    this.validateResultType(resultType);
    const result = precision != null ? this.format(raw, { precision }) : this.format(raw);
    this.validateResultSize(result);
    return { result, resultType };
  }

  /** Simplify an algebraic expression symbolically. */
  simplifyExpression(expression: string): MathResult {
    this.validateInput(expression);
    const simplified = this.runWithTimeout(() => this.simplify(expression, this.simplifyRules));
    const result = simplified.toString();
    this.validateResultSize(result);
    return { result, resultType: 'string' };
  }

  /** Compute the symbolic derivative of an expression with respect to a variable. */
  differentiateExpression(expression: string, variable: string): MathResult {
    this.validateInput(expression);
    const derived = this.runWithTimeout(() => this.derivative(expression, variable));
    const result = derived.toString();
    this.validateResultSize(result);
    return { result, resultType: 'string' };
  }

  /** Get formatted help content listing available functions, operators, and syntax. */
  getHelpContent(): string {
    return HELP_CONTENT;
  }

  private validateInput(expression: string): void {
    if (!expression.trim()) {
      throw invalidParams('Expression cannot be empty.');
    }
    if (expression.length > this.config.maxExpressionLength) {
      throw invalidParams(
        `Expression exceeds maximum length of ${this.config.maxExpressionLength} characters.`,
      );
    }
    if (hasExpressionSeparator(expression)) {
      throw invalidParams('Multiple expressions are not allowed. Submit one expression per call.');
    }
  }

  /** Reject scope keys that could pollute the object prototype chain. */
  private sanitizeScope(scope: Record<string, number>): Record<string, number> {
    for (const key of Object.keys(scope)) {
      if (BLOCKED_SCOPE_KEYS.has(key)) {
        throw invalidParams(
          `Scope key "${key}" is not allowed — it conflicts with a reserved property name.`,
        );
      }
    }
    return scope;
  }

  /** Reject result types that leak internals (functions, parsers, multi-expression ResultSets). */
  private validateResultType(resultType: string): void {
    if (BLOCKED_RESULT_TYPES.has(resultType)) {
      throw invalidParams(
        `Expression produced a ${resultType} — only numeric, string, matrix, complex, unit, and boolean results are allowed.`,
      );
    }
  }

  /** Reject results that exceed the configured maximum size. */
  private validateResultSize(result: string): void {
    if (result.length > this.config.maxResultLength) {
      throw invalidParams(
        `Result exceeds maximum size (${this.config.maxResultLength} characters). Reduce matrix dimensions or simplify the expression.`,
      );
    }
  }

  /** Runs a synchronous function inside a vm sandbox with timeout protection. */
  private runWithTimeout<T>(fn: () => T): T {
    const sandbox = { fn, result: undefined as T };
    const context = vm.createContext(sandbox);
    try {
      vm.runInNewContext('result = fn()', context, { timeout: this.config.evaluationTimeoutMs });
      return sandbox.result;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw serviceUnavailable(
          `Expression evaluation timed out after ${this.config.evaluationTimeoutMs / 1000} seconds. Simplify the expression or reduce matrix dimensions.`,
        );
      }
      // All non-timeout errors from the VM are expression-related
      const message = err instanceof Error ? err.message : String(err);
      throw invalidParams(`Invalid expression: ${message}`);
    }
  }
}

// --- Init/accessor pattern ---

let _service: MathService | undefined;

/** Initialize the math service. Call once from createApp setup(). */
export function initMathService(config: ServerConfig): void {
  _service = new MathService(config);
}

/** Get the initialized math service instance. */
export function getMathService(): MathService {
  if (!_service) throw new Error('MathService not initialized — call initMathService() in setup()');
  return _service;
}

// --- Help content ---

const HELP_CONTENT = `# Calculator Help

## Operators

| Operator | Description | Example |
|:---------|:------------|:--------|
| + | Addition | 2 + 3 |
| - | Subtraction | 5 - 2 |
| * | Multiplication | 3 * 4 |
| / | Division | 10 / 3 |
| ^ | Exponentiation | 2 ^ 10 |
| % | Modulus | 17 % 5 |
| ! | Factorial | 5! |

## Constants

| Name | Value | Description |
|:-----|:------|:------------|
| pi | 3.14159... | Ratio of circumference to diameter |
| e | 2.71828... | Euler's number |
| phi | 1.61803... | Golden ratio |
| i | sqrt(-1) | Imaginary unit |
| Infinity | Infinity | Positive infinity |
| NaN | NaN | Not a number |
| true | true | Boolean true |
| false | false | Boolean false |

## Functions

### Arithmetic
abs, ceil, floor, round, sign, sqrt, cbrt, exp, expm1, log, log2, log10, log1p, pow, mod, gcd, lcm, nthRoot, hypot, fix, cube, square, unaryMinus, unaryPlus

### Trigonometry
sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh, sec, csc, cot, asec, acsc, acot, sech, csch, coth

### Statistics
mean, median, mode, std, variance, min, max, sum, prod, quantileSeq, mad, count

### Matrix
det, inv, transpose, trace, zeros, ones, identity, diag, size, reshape, flatten, concat, sort, cross, dot, eigs, expm, sqrtm, kron, pinv, range

### Combinatorics
factorial, gamma, permutations, combinations, catalan, bellNumbers, stirlingS2, composition, multinomial

### Complex Numbers
re, im, conj, arg, complex

### Logical
and, or, xor, not

### Comparison
equal, unequal, larger, largerEq, smaller, smallerEq, compare, deepEqual

### Unit Conversion
Syntax: \`value unit to targetUnit\`

Common units: m, cm, mm, km, inch, ft, yard, mile, kg, g, lb, oz, s, min, hour, day, celsius, fahrenheit, kelvin, liter, gallon, joule, watt, newton, pascal, bar, psi, radian, degree

## Syntax Examples

### Basic arithmetic
\`2 + 3 * 4\` => 14

### Functions
\`sqrt(144)\` => 12
\`sin(pi / 2)\` => 1
\`log(1000, 10)\` => 3

### Variables (via scope parameter)
Provide scope: { "x": 5, "y": 3 }
Expression: \`x^2 + y\` => 28

### Matrices
\`[1, 2; 3, 4]\` — 2x2 matrix
\`det([1, 2; 3, 4])\` => -2
\`inv([1, 2; 3, 4])\` => [[-2, 1], [1.5, -0.5]]

### Complex numbers
\`2 + 3i\` => 2 + 3i
\`sqrt(-4)\` => 2i
\`abs(3 + 4i)\` => 5

### Unit conversion
\`5 kg to lbs\` => 11.02 lbs
\`100 celsius to fahrenheit\` => 212 fahrenheit
\`1 mile to km\` => 1.60934 km

> **Note:** Unit conversions use IEEE 754 floating-point arithmetic. Results may include minor rounding artifacts (e.g., 211.99999999999997 instead of 212). Use the \`precision\` parameter to round.

### Precision
Use the precision parameter (1\u201316 significant digits) for numeric results.

### Operations
- **evaluate** (default): Compute a numeric result
- **simplify**: Reduce algebraic expressions symbolically (e.g., "2x + 3x" => "5 * x", "sin(x)^2 + cos(x)^2" => 1). Supports algebraic rules and common trigonometric identities (Pythagorean, double-angle, tan/sec/csc/cot relationships).
- **derivative**: Compute symbolic derivative (requires variable parameter, e.g., variable: "x")
`;
