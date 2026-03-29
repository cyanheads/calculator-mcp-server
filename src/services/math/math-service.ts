/**
 * @fileoverview Hardened math.js wrapper for secure expression evaluation.
 * Creates a restricted math.js instance with dangerous functions disabled in
 * the expression scope, and wraps evaluation in a vm sandbox with timeout.
 * @module services/math/math-service
 */

import vm from 'node:vm';
import { invalidParams, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { all, create } from 'mathjs';
import type { ServerConfig } from '@/config/server-config.js';
import type { MathResult } from './types.js';

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
] as const;

/** Check for semicolons outside square brackets (matrix row separators use `;`). */
function hasTopLevelSemicolon(expr: string): boolean {
  let depth = 0;
  for (const ch of expr) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ';' && depth === 0) return true;
  }
  return false;
}

export class MathService {
  private readonly evaluate: (expr: string, scope?: Record<string, number>) => unknown;
  private readonly simplify: (expr: string) => { toString(): string };
  private readonly derivative: (expr: string, variable: string) => { toString(): string };
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
    this.format = math.format.bind(math);
    this.typeOf = math.typeOf.bind(math);

    // Disable dangerous functions in expression scope
    const disabled: Record<string, () => never> = {};
    for (const fn of DISABLED_FUNCTIONS) {
      disabled[fn] = () => {
        throw new Error(`Function "${fn}" is disabled for security.`);
      };
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
    const raw = this.runWithTimeout(() =>
      scope ? this.evaluate(expression, scope) : this.evaluate(expression),
    );
    const resultType = this.typeOf(raw);
    const result = precision != null ? this.format(raw, { precision }) : this.format(raw);
    return { result, resultType };
  }

  /** Simplify an algebraic expression symbolically. */
  simplifyExpression(expression: string): MathResult {
    this.validateInput(expression);
    const simplified = this.runWithTimeout(() => this.simplify(expression));
    return { result: simplified.toString(), resultType: 'string' };
  }

  /** Compute the symbolic derivative of an expression with respect to a variable. */
  differentiateExpression(expression: string, variable: string): MathResult {
    this.validateInput(expression);
    const derived = this.runWithTimeout(() => this.derivative(expression, variable));
    return { result: derived.toString(), resultType: 'string' };
  }

  /** Get formatted help content listing available functions, operators, and syntax. */
  getHelpContent(): string {
    return HELP_CONTENT;
  }

  private validateInput(expression: string): void {
    if (expression.length > this.config.maxExpressionLength) {
      throw invalidParams(
        `Expression exceeds maximum length of ${this.config.maxExpressionLength} characters.`,
      );
    }
    if (hasTopLevelSemicolon(expression)) {
      throw invalidParams(
        'Multiple expressions (semicolons) are not allowed. Submit one expression per call.',
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
      // Math.js errors (syntax, unknown function, dimension mismatch) → InvalidParams
      throw invalidParams(err instanceof Error ? err.message : String(err));
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

### Precision
Use the precision parameter (0-64 significant digits) for numeric results.

### Operations
- **evaluate** (default): Compute a numeric result
- **simplify**: Reduce algebraic expressions symbolically (e.g., "2x + 3x" => "5 * x")
- **derivative**: Compute symbolic derivative (requires variable parameter, e.g., variable: "x")
`;
