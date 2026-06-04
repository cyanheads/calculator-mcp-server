/**
 * @fileoverview Hardened math.js wrapper for secure expression evaluation.
 * Creates a restricted math.js instance with dangerous functions disabled in
 * the expression scope, and wraps evaluation in a vm sandbox with timeout.
 * @module services/math/math-service
 */

import vm from 'node:vm';
import type { Context } from '@cyanheads/mcp-ts-core';
import { timeout, validationError } from '@cyanheads/mcp-ts-core/errors';
import { all, create, type MathNode, type SimplifyRule, type UnitDefinition } from 'mathjs';
import type { ServerConfig } from '@/config/server-config.js';
import type { MathResult, NumericType } from './types.js';

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
 * Custom units registered during service init. math.js disables `createUnit`
 * in the expression scope, so these are added programmatically before the
 * disabling step. Definitions use exact SI-derived values where possible.
 */
const CUSTOM_UNITS: Record<string, string | UnitDefinition> = {
  mph: '1 mile/hour',
  knot: { definition: '1852 m/hour', aliases: ['knots', 'kt', 'kts'] },
  lightyear: { definition: '9460730472580800 m', aliases: ['lightyears', 'ly'] },
};

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
 * Method names that coerce a value to a string. Blocked at parse time on any
 * accessor: `.toString()` / `.toLocaleString()` on a function-valued identifier
 * (e.g. `cos.toString()`) otherwise returns internal source as a plain string,
 * slipping past {@link BLOCKED_RESULT_TYPES} (which only sees the value after
 * stringification). See {@link MathService.validateNoFunctionStringification}.
 */
const STRINGIFYING_METHODS = new Set(['toString', 'toLocaleString']);

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
 * Check for expression separators (`;` or newline) that split the input into
 * multiple statements. Three contexts are NOT separators and are skipped:
 *  - `;` inside `[...]` — a matrix row separator (`[1, 2; 3, 4]`).
 *  - `;` or a newline inside a double-quoted string literal — part of the data,
 *    not a statement break (`"a;b"`, `concat("a;b", "c")`).
 *  - `[` / `]` inside a string literal — they must not shift the bracket depth,
 *    or a string such as `"]"` would let a later top-level `;` slip past.
 *
 * Single quotes are NOT string delimiters in math.js — `'` is the transpose
 * operator (`A'`) — so only `"` opens a string span, and a backslash escapes the
 * next character within it (`"\""` stays open). The scan is intentionally
 * lexical rather than a full parse: it only has to recognize quoted spans, and a
 * genuine multi-statement input (`1+2; 3+4`) is still caught at depth 0.
 */
function hasExpressionSeparator(expr: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '\n' || ch === '\r') return true;
    else if (ch === ';' && depth === 0) return true;
  }
  return false;
}

/**
 * Recursively test whether a math.js result holds any non-finite number
 * (Infinity, -Infinity, NaN). The `undefined_result` guard must reach inside
 * compound types: a `DenseMatrix`/`SparseMatrix` element or the real/imaginary
 * part of a `Complex` can be non-finite while the outer value is an object — a
 * scalar `typeof === 'number'` check would skip it and leak `Infinity` to clients.
 */
function containsNonFinite(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsNonFinite);
  // Complex: re/im are plain numbers.
  if ('re' in value && 'im' in value) {
    return containsNonFinite(value.re) || containsNonFinite(value.im);
  }
  // DenseMatrix / SparseMatrix expose toArray() → nested JS arrays.
  if (typeof (value as { toArray?: unknown }).toArray === 'function') {
    return containsNonFinite((value as { toArray: () => unknown }).toArray());
  }
  return false;
}

/**
 * Matches standard-notation function names math.js does not define — natural log
 * `ln` and the inverse-trig `arc*` family — only at call sites (word boundary +
 * `(` lookahead), so identifiers and scope variables are never rewritten.
 */
const NOTATION_ALIAS_PATTERN = /\b(ln|arc(?:sin|cos|tan|sec|csc|cot)h?)(?=\s*\()/g;

/**
 * Rewrite standard mathematical notation to math.js canonical names before
 * parsing: `ln` → `log` (natural log) and `arc<fn>` → `a<fn>` for inverse trig
 * (`arcsin` → `asin`, `arctanh` → `atanh`, …). All 12 `a*` targets are math.js
 * builtins, so every operation resolves them.
 *
 * The rewrite is name-level (not a `math.import` alias) deliberately: symbolic
 * `derivative` matches on builtin function names, and an imported alias is not in
 * its differentiation table — so an alias would fix evaluate/simplify but leave
 * `derivative('ln(x)')` throwing. A pre-parse rewrite covers all three operations.
 */
function normalizeNotation(expression: string): string {
  return expression.replace(NOTATION_ALIAS_PATTERN, (name) =>
    name === 'ln' ? 'log' : `a${name.slice(3)}`,
  );
}

/** Bundled references extracted from a single math.js instance. */
interface MathInstance {
  evaluate: (expr: string, scope?: Record<string, number>) => unknown;
  format: (
    value: unknown,
    options?: { precision?: number; lowerExp?: number; upperExp?: number },
  ) => string;
  typeOf: (value: unknown) => string;
}

/** Create and harden a math.js instance with the given numeric type. */
function createMathInstance(number: 'number' | 'BigNumber' | 'Fraction'): MathInstance {
  // biome-ignore lint/style/noNonNullAssertion: math.js types declare `all` as potentially undefined, but it's always defined at runtime
  const math = create(all!, { number });

  // Capture references BEFORE the override step — the import shim replaces these
  // on the instance, so binding after would capture the disabled stubs.
  const evaluate = math.evaluate.bind(math);
  const format = math.format.bind(math);
  const typeOf = math.typeOf.bind(math);
  // Capture math.import before it's disabled — needed to install the config guard below.
  const mathImport = math.import.bind(math);

  // For BigNumber/Fraction instances, also capture config before the override.
  // math.js BigNumber arithmetic reads config() internally to get the Decimal.js precision.
  // Replacing config with a throwing stub breaks that and causes:
  //   [DecimalError] Invalid argument: precision: NaN
  // Instead, we install a read-only guard after the disable step: reads pass through,
  // writes throw — blocking expression-scope config mutations while preserving internal access.
  const realConfig = number !== 'number' ? math.config.bind(math) : null;

  // Register custom units and natural-language function aliases.
  // Must run before createUnit/import are disabled below.
  math.createUnit(CUSTOM_UNITS);
  mathImport({ average: math.mean, avg: math.mean });

  // Disable dangerous functions in expression scope.
  // `config` is excluded here for BigNumber/Fraction instances — installed as a
  // read-only guard via mathImport after this block (import is also disabled here).
  const disabled: Record<string, unknown> = {};
  for (const fn of DISABLED_FUNCTIONS) {
    if (fn === 'config' && number !== 'number') continue; // read-only guard installed below
    disabled[fn] = () => {
      throw new Error(`Function "${fn}" is disabled for security.`);
    };
  }
  // Redact constants that leak implementation details
  for (const [key, value] of Object.entries(REDACTED_CONSTANTS)) {
    disabled[key] = value;
  }
  mathImport(disabled, { override: true });

  // For BigNumber/Fraction: install a read-only config guard using the pre-captured
  // mathImport reference (math.import is now disabled in the expression scope).
  //
  // Two access patterns must be preserved for math.js internals:
  //   1. config()          — gamma/factorial call this to read the full config object
  //   2. config.precision  — gamma accesses precision directly as a property on the function
  //
  // Replacing config with a plain stub breaks both; the guard function below satisfies
  // both patterns while blocking write access (calls with a non-empty options object).
  if (realConfig !== null) {
    const currentConfig = (
      realConfig as unknown as (o: Record<string, unknown>) => Record<string, unknown>
    )({});
    const configGuard = Object.assign(
      (options?: Record<string, unknown>) => {
        if (options !== undefined && Object.keys(options).length > 0) {
          throw new Error('"config" is disabled for security.');
        }
        return currentConfig;
      },
      currentConfig, // spread all config props (precision, relTol, …) onto the function object
    );
    mathImport({ config: configGuard }, { override: true });
  }

  return { evaluate, format, typeOf };
}

export class MathService {
  /** Default IEEE 754 instance — used for the vast majority of evaluations. */
  private readonly defaultInstance: MathInstance;
  /** BigNumber instance — arbitrary precision; selected via numericType: "BigNumber". */
  private readonly bigNumberInstance: MathInstance;
  /** Fraction instance — exact rational arithmetic; selected via numericType: "Fraction". */
  private readonly fractionInstance: MathInstance;

  private readonly parse: (expr: string) => MathNode;
  private readonly simplify: (expr: string, rules?: SimplifyRule[]) => { toString(): string };
  private readonly derivative: (expr: string, variable: string) => { toString(): string };
  private readonly simplifyRules: SimplifyRule[];
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;

    // biome-ignore lint/style/noNonNullAssertion: math.js types declare `all` as potentially undefined, but it's always defined at runtime
    const baseMath = create(all!);

    // Save references for symbolic operations — these don't need numeric-type variants.
    // parse / simplify / derivative operate on the AST, not numeric values.
    this.parse = baseMath.parse.bind(baseMath);
    this.simplify = baseMath.simplify.bind(baseMath);
    this.derivative = baseMath.derivative.bind(baseMath);
    this.simplifyRules = [...baseMath.simplify.rules, ...TRIG_SIMPLIFY_RULES];

    // Pre-initialize one hardened instance per numeric type so numeric-type selection
    // at evaluation time is a simple Map lookup, not a per-request reconfiguration.
    this.defaultInstance = createMathInstance('number');
    this.bigNumberInstance = createMathInstance('BigNumber');
    this.fractionInstance = createMathInstance('Fraction');
  }

  /** Select the pre-initialized evaluate/format/typeOf bundle for a given numeric type. */
  private instanceFor(numericType: NumericType): MathInstance {
    switch (numericType) {
      case 'BigNumber':
        return this.bigNumberInstance;
      case 'Fraction':
        return this.fractionInstance;
      default:
        return this.defaultInstance;
    }
  }

  /** Evaluate a math expression with optional variable scope, precision, and numeric type. */
  evaluateExpression(
    expression: string,
    ctx: Context,
    scope?: Record<string, number>,
    precision?: number,
    numericType: NumericType = 'number',
  ): MathResult {
    this.validateInput(expression, ctx);
    if (scope) this.validateScope(scope, ctx);
    const normalized = normalizeNotation(expression);
    this.validateNoFunctionStringification(normalized, ctx);
    const inst = this.instanceFor(numericType);
    const raw = this.runWithTimeout(
      () => (scope ? inst.evaluate(normalized, scope) : inst.evaluate(normalized)),
      ctx,
    );
    const resultType = inst.typeOf(raw);
    this.validateResultType(resultType, ctx);
    this.validateFinite(raw, ctx);
    // Match JS Number.toString thresholds — math.js defaults to exp ≥ 5,
    // which would render 83810205 as "8.3810205e+7".
    const result = inst.format(raw, {
      lowerExp: -6,
      upperExp: 21,
      ...(precision != null && { precision }),
    });
    this.validateResultSize(result, ctx);
    return { result, resultType };
  }

  /** Simplify an algebraic expression symbolically. */
  simplifyExpression(expression: string, ctx: Context): MathResult {
    this.validateInput(expression, ctx);
    const normalized = normalizeNotation(expression);
    // Capture the AST-normalized form of the input before simplification so we
    // can detect whether the simplifier made any progress. String comparison is
    // not sufficient — formatting-only changes like `x+1` vs `x + 1` should not
    // count as progress. We parse both sides and compare their `.toString()` output,
    // which normalises whitespace and operator representation consistently.
    let inputNormalized: string;
    try {
      inputNormalized = this.parse(normalized).toString();
    } catch {
      // If the expression cannot be parsed, let the simplify step surface the error
      // with full math.js context. Set to the raw input so the unchanged flag is
      // false (we don't know, but a parse error is not a no-op simplification).
      inputNormalized = '';
    }
    const simplified = this.runWithTimeout(
      () => this.simplify(normalized, this.simplifyRules),
      ctx,
    );
    const result = simplified.toString();
    this.validateResultSize(result, ctx);
    const unchanged = inputNormalized !== '' && inputNormalized === result;
    return { result, resultType: 'string', unchanged };
  }

  /** Compute the symbolic derivative of an expression with respect to a variable. */
  differentiateExpression(expression: string, variable: string, ctx: Context): MathResult {
    this.validateInput(expression, ctx);
    const normalized = normalizeNotation(expression);
    const derived = this.runWithTimeout(() => this.derivative(normalized, variable), ctx);
    const result = derived.toString();
    this.validateResultSize(result, ctx);
    return { result, resultType: 'string' };
  }

  /** Get formatted help content listing available functions, operators, and syntax. */
  getHelpContent(): string {
    return HELP_CONTENT;
  }

  private validateInput(expression: string, ctx: Context): void {
    if (!expression.trim()) {
      throw validationError('Expression cannot be empty.', {
        reason: 'empty_expression',
        ...ctx.recoveryFor('empty_expression'),
      });
    }
    if (expression.length > this.config.maxExpressionLength) {
      throw validationError(
        `Expression exceeds maximum length of ${this.config.maxExpressionLength} characters.`,
        { reason: 'expression_too_long', ...ctx.recoveryFor('expression_too_long') },
      );
    }
    if (hasExpressionSeparator(expression)) {
      throw validationError(
        'Multiple expressions are not allowed. Submit one expression per call.',
        { reason: 'multiple_expressions', ...ctx.recoveryFor('multiple_expressions') },
      );
    }
  }

  /** Reject scope keys that could pollute the object prototype chain. */
  private validateScope(scope: Record<string, number>, ctx: Context): void {
    for (const key of Object.keys(scope)) {
      if (BLOCKED_SCOPE_KEYS.has(key)) {
        throw validationError(
          `Scope key "${key}" is not allowed — it conflicts with a reserved property name.`,
          { reason: 'reserved_scope_key', ...ctx.recoveryFor('reserved_scope_key') },
        );
      }
    }
  }

  /** Reject result types that leak internals (functions, parsers, multi-expression ResultSets). */
  private validateResultType(resultType: string, ctx: Context): void {
    if (BLOCKED_RESULT_TYPES.has(resultType)) {
      throw validationError(
        `Expression produced a ${resultType} — only numeric, string, matrix, complex, unit, and boolean results are allowed.`,
        { reason: 'disallowed_result_type', ...ctx.recoveryFor('disallowed_result_type') },
      );
    }
  }

  /** Reject results holding a non-finite value (Infinity, -Infinity, NaN), including inside matrices and complex numbers. */
  private validateFinite(raw: unknown, ctx: Context): void {
    if (containsNonFinite(raw)) {
      throw validationError(
        'Expression evaluated to a non-finite result (Infinity, -Infinity, or NaN) — this typically means the operation is mathematically undefined (e.g., division by zero, log of zero). Check the expression.',
        { reason: 'undefined_result', ...ctx.recoveryFor('undefined_result') },
      );
    }
  }

  /** Reject results that exceed the configured maximum size. */
  private validateResultSize(result: string, ctx: Context): void {
    if (result.length > this.config.maxResultLength) {
      throw validationError(
        `Result exceeds maximum size (${this.config.maxResultLength} characters). Reduce matrix dimensions or simplify the expression.`,
        { reason: 'result_too_large', ...ctx.recoveryFor('result_too_large') },
      );
    }
  }

  /**
   * Reject expressions that access `.toString` / `.toLocaleString` on any value.
   * math.js permits these methods on function-valued identifiers (`cos.toString()`,
   * `import.toString()`), returning the function's source as a plain string — which
   * slips past {@link validateResultType}, whose function defense only inspects the
   * value AFTER stringification. The check is parse-time and AST-based rather than a
   * runtime `Function.prototype` patch: math.js itself calls `toString` on functions
   * internally while evaluating units, statistics, and complex results, so patching
   * the prototype would reject legitimate expressions. No real calculator expression
   * needs `.toString()`/`.toLocaleString()`, so blocking the accessor outright (dot
   * or bracket form, on any operand) is both sufficient and side-effect-free. String
   * literals that merely contain the text "toString" parse as ConstantNodes, not
   * accessors, so they are unaffected.
   */
  private validateNoFunctionStringification(expr: string, ctx: Context): void {
    let ast: MathNode;
    try {
      ast = this.parse(expr);
    } catch {
      // Let the evaluate path surface parse errors with full mathjs context.
      return;
    }
    const accessesStringifier = ast.filter((node) => {
      if (node.type !== 'IndexNode') return false;
      const { dimensions } = node as unknown as {
        dimensions: Array<{ type: string; value?: unknown }>;
      };
      return dimensions.some(
        (dim) => dim.type === 'ConstantNode' && STRINGIFYING_METHODS.has(String(dim.value)),
      );
    });
    if (accessesStringifier.length > 0) {
      throw validationError(
        'Converting a function to a string is not allowed — it would expose internal source. Only numeric, string, matrix, complex, unit, and boolean results are allowed.',
        { reason: 'disallowed_result_type', ...ctx.recoveryFor('disallowed_result_type') },
      );
    }
  }

  /** Runs a synchronous function inside a vm sandbox with timeout protection. */
  private runWithTimeout<T>(fn: () => T, ctx: Context): T {
    const sandbox = { fn, result: undefined as T };
    try {
      vm.runInNewContext('result = fn()', sandbox, { timeout: this.config.evaluationTimeoutMs });
      return sandbox.result;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw timeout(
          `Expression evaluation timed out after ${this.config.evaluationTimeoutMs / 1000} seconds. Simplify the expression or reduce matrix dimensions.`,
          { reason: 'evaluation_timeout', ...ctx.recoveryFor('evaluation_timeout') },
        );
      }
      // All non-timeout errors from the VM are expression-related
      const message = err instanceof Error ? err.message : String(err);
      throw validationError(`Invalid expression: ${message}`, {
        reason: 'parse_failed',
        ...ctx.recoveryFor('parse_failed'),
      });
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

> **Standard notation accepted:** \`ln\` works as natural log (canonical \`log\`), and the \`arc*\` inverse-trig names (\`arcsin\`, \`arccos\`, \`arctan\`, \`arcsinh\`, …) work as their \`a*\` equivalents (\`asin\`, \`acos\`, \`atan\`, …). Both forms are valid across evaluate, simplify, and derivative.

### Arithmetic
abs, ceil, floor, round, sign, sqrt, cbrt, exp, expm1, log (also: ln), log2, log10, log1p, pow, mod, gcd, lcm, nthRoot, hypot, fix, cube, square, unaryMinus, unaryPlus

### Trigonometry
sin, cos, tan, asin (arcsin), acos (arccos), atan (arctan), atan2, sinh, cosh, tanh, asinh (arcsinh), acosh (arccosh), atanh (arctanh), sec, csc, cot, asec (arcsec), acsc (arccsc), acot (arccot), sech (arcsech), csch (arccsch), coth (arccoth)

### Statistics
mean (aliases: average, avg), median, mode, std, variance, min, max, sum, prod, quantileSeq, mad, count

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

Common units: m, cm, mm, km, inch, ft, yard, mile, lightyear (ly), kg, g, lb, oz, s, min, hour, day, mph, knot (kt), celsius, fahrenheit, kelvin, liter, gallon, joule, watt, newton, pascal, bar, psi, radian, degree

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

- **evaluate** (default): Compute a numeric result. Use the \`numericType\` parameter to control precision:
  - \`"number"\` (default): 64-bit IEEE 754 float — fastest. Standard for most calculations.
  - \`"BigNumber"\`: Arbitrary-precision decimal — use when intermediate values overflow (e.g. \`10000! / 9999!\` overflows as a 64-bit float but evaluates correctly as a BigNumber). Slower than \`"number"\`.
  - \`"Fraction"\`: Exact rational arithmetic — eliminates floating-point rounding (e.g. \`0.1 + 0.2 = 0.3\` exactly). Limited to expressions without transcendental functions (sin, log, etc.).

  When \`"number"\` evaluation returns an \`undefined_result\` error (division by zero, overflow), retry with \`numericType: "BigNumber"\`.

- **simplify**: Reduce algebraic expressions symbolically (e.g., "2x + 3x" => "5 * x", "sin(x)^2 + cos(x)^2" => 1). Supports algebraic rules and common trigonometric identities (Pythagorean, double-angle, tan/sec/csc/cot relationships).

  **Known limits:** The built-in simplifier does not perform polynomial factoring or rational cancellation. Expressions like \`(x^2 - 1) / (x - 1)\` are returned unchanged (\`unchanged: true\` in the output). For these cases, consider rewriting by hand or using \`evaluate\` with a numeric scope.

- **derivative**: Compute symbolic derivative (requires variable parameter, e.g., variable: "x")
`;
