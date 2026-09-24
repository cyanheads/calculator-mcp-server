/**
 * @fileoverview Hardened math.js wrapper for secure expression evaluation.
 * Creates a restricted math.js instance with dangerous functions disabled in
 * the expression scope, parses each expression once and checks the tree before
 * anything runs, and evaluates, inspects, and formats the result inside a vm
 * sandbox with a timeout.
 * @module services/math/math-service
 */

import vm from 'node:vm';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, timeout, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  all,
  create,
  type Fraction,
  type FunctionNode,
  type IndexNode,
  isBigNumber,
  isComplex,
  isHelp,
  isMatrix,
  isSparseMatrix,
  isUnit,
  type MathNode,
  type SimplifyRule,
  type UnitDefinition,
} from 'mathjs';
import type { ServerConfig } from '@/config/server-config.js';
import {
  beginEvaluation,
  installSizeGuards,
  isPlainObject,
  meterNode,
  sizeLimitErrorIn,
} from './size-guard.js';
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
 * `config` is not listed: it gets a read-only guard instead (see createMathInstance).
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
 * stringification). See {@link inspectTree}.
 */
const STRINGIFYING_METHODS = new Set(['toString', 'toLocaleString']);

/**
 * The tool's `operation` values. Each is also a disabled function name, so a
 * call such as `derivative("x^2", "x")` inside an expression is a caller asking
 * for the operation the wrong way — rejected at parse time with a pointer to the
 * `operation` parameter rather than the generic disabled-function message.
 */
const OPERATION_FUNCTIONS = new Set(['evaluate', 'simplify', 'derivative']);

/**
 * Standard-notation function names math.js does not define — natural log `ln`
 * and the inverse-trig `arc*` family. Renamed on the parse tree (see
 * {@link inspectTree}) to their math.js builtins.
 */
const NOTATION_ALIAS = /^(?:ln|arc(?:sin|cos|tan|sec|csc|cot)h?)$/;

/**
 * Node types that compute a new value — a call, an operator, a matrix or object
 * literal, an indexed read, a range. Each is metered against the evaluation's
 * element budget; the rest (symbols, constants, parentheses, assignments,
 * conditionals) pass along a value some other node built.
 */
const VALUE_BUILDING_NODES = new Set([
  'AccessorNode',
  'ArrayNode',
  'FunctionNode',
  'ObjectNode',
  'OperatorNode',
  'RangeNode',
]);

/**
 * Lower bound on the characters one element of a collection result renders to:
 * at least one character plus the `, ` separator (a one-element matrix, `[0]`,
 * is three). A result with more than `maxResultLength / 3` elements can never
 * fit, so it is rejected before formatting.
 */
const MIN_CHARS_PER_ELEMENT = 3;

/**
 * math.js error thrown when a Fraction-mode expression calls a function with no
 * Fraction implementation: irrational and transcendental ones (`sqrt`, `sin`,
 * `log`, …) and some whose result can be rational (`sqrt(4)`, `5!`,
 * `combinations`). math.js reports it as an implicit type-conversion failure that
 * does not name the function; paired with a `numericType === 'Fraction'` guard it
 * maps to the actionable `fraction_unsupported` error instead of the misleading,
 * syntax-oriented `parse_failed`. See {@link MathService.classifyFailure}.
 */
const FRACTION_CONVERSION_ERROR = /Cannot implicitly convert a Fraction/;

/**
 * math.js error thrown when a 64-bit float meets a Fraction and has no Fraction
 * equal to it — `pi * 2/3`, `pi^40`, `sin(pi) + 1/3`. Under numericType
 * "Fraction" the float can only have come from a value Fraction mode holds
 * approximately, so it maps to `fraction_unsupported`, not `type_mismatch`.
 */
const FLOAT_TO_FRACTION_ERROR =
  /^Cannot implicitly convert a number to a Fraction when there will be a loss of precision/;

/** `fraction_unsupported` message for a function Fraction mode cannot compute. */
const FRACTION_FUNCTION_MESSAGE =
  'numericType "Fraction" cannot compute this expression: either its result has no exact rational value (e.g. sqrt(2), sin(1), log(3)), or it calls a function Fraction mode cannot compute, even for a rational result (e.g. sqrt(4), 5!, combinations(5, 2)). Retry with numericType "number" or "BigNumber".';

/** `undefined_result` message: a non-finite value, or a Fraction division by zero. */
const UNDEFINED_RESULT_MESSAGE =
  'Expression evaluated to a non-finite result (Infinity, -Infinity, or NaN): either the operation is mathematically undefined (division by zero, 0/0, log(0)), or a value overflowed its numeric range (under numericType "number", past about 1.8e308 — e.g. 171!, 2^1024, exp(1000)).';

/** `fraction_unsupported` message for a Fraction-mode evaluation that picked up a float. */
const FRACTION_FLOAT_MESSAGE =
  'numericType "Fraction" cannot return this result exactly: the expression uses a value Fraction mode holds only as a rounded 64-bit float — an irrational constant (pi, e), a non-integer power (2^(1/2)), a complex number with a non-integer part, or a float from number() or random(). Retry with numericType "number" or "BigNumber".';

/** math.js derivative error for a function or operator it has no differentiation rule for. */
const NO_DERIVATIVE_RULE = /^Cannot process (function|operator) "([^"]+)" in derivative/;

/** A symbolic operation's timed call; symbolic operations never touch numeric types or scope. */
type SymbolicStage =
  | { operation: 'simplify'; numericType?: undefined }
  | { operation: 'derivative'; numericType?: undefined; variable: string };

/** Which operation a timed call belongs to, for classifying its failure. */
type FailureStage =
  | {
      operation: 'evaluate';
      numericType: NumericType;
      /** Names the expression uses as values that resolve to functions (`min` in `5 min`). */
      functionValues: string[];
    }
  | SymbolicStage;

/**
 * Unit names math.js resolves to a function first — `5 min` multiplies by the
 * minimum function — paired with a unit name to write instead.
 */
const FUNCTION_SHADOWED_UNITS: Record<string, string> = { min: 'minute', sec: 's' };

/** Message of the vm timeout error (`ERR_SCRIPT_EXECUTION_TIMEOUT`), also when re-wrapped. */
const VM_TIMEOUT_ERROR = /Script execution timed out after/;

/**
 * fraction.js throws this for any Fraction division by zero — reachable in every
 * numericType through `fraction()`. Fractions never hold Infinity, so it is the
 * Fraction form of a non-finite result and maps to `undefined_result`.
 */
const FRACTION_DIVISION_BY_ZERO = /^Division by Zero$/;

/**
 * Evaluation-time errors that are about the expression's names rather than its
 * values: an undefined symbol, function, or unit, a disabled function, or a
 * blocked property. They stay `parse_failed`, whose recovery is about names.
 */
const NAME_ERROR =
  /^(?:Undefined (?:symbol|function) |Unit ".*" not found|No access to )|is disabled for security\.$/;

/**
 * Operand type and unit errors that math.js raises as plain messages (typed-function
 * `wrongType` errors are recognized by `data.category` instead).
 */
const TYPE_MISMATCH_ERROR =
  /^(?:Units do not match|Cannot convert |Cannot implicitly convert )|is no angle$/;

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

/** Findings of {@link inspectTree} that reject the expression before it runs. */
interface TreeInspection {
  /** First `evaluate` / `simplify` / `derivative` call found, if any. */
  operationCall: string | undefined;
  /** The expression accesses `.toString` / `.toLocaleString` on some value. */
  stringifies: boolean;
  /** Names used as values rather than called — `min` in `5 min`, `x` in `x + 1`. */
  valueNames: Set<string>;
}

/**
 * Walk a freshly parsed tree once: flag stringifier access and operation-named
 * calls, collect the names used as values, meter every value-building node against the element budget (so a node
 * in a loop body — a user-defined function or an inline `map` callback — is
 * charged on each iteration), and rename standard-notation calls in place —
 * `ln` → `log`, `arc<fn>` → `a<fn>` (`arcsin` → `asin`, `arctanh` → `atanh`, …).
 *
 * The rename works on `FunctionNode`s whose callee is a `SymbolNode`, so string
 * literals (`"ln("` is a `ConstantNode`) and scope variables named `ln` (a bare
 * `SymbolNode`) are never touched, and nested calls are reached because the walk
 * covers every node. It is name-level rather than a `math.import` alias because
 * symbolic `derivative` matches builtin names — an imported alias is not in its
 * differentiation table. The tree is evaluated as-is afterwards, never
 * re-stringified: a Fraction-mode tree prints `0.1` as `1/10`.
 */
function inspectTree(tree: MathNode): TreeInspection {
  const inspection: TreeInspection = {
    stringifies: false,
    operationCall: undefined,
    valueNames: new Set(),
  };
  tree.traverse((node, path) => {
    if (VALUE_BUILDING_NODES.has(node.type)) meterNode(node);
    if (node.type === 'SymbolNode' && path !== 'fn') {
      inspection.valueNames.add((node as MathNode & { name: string }).name);
    }
    if (node.type === 'IndexNode') {
      const { dimensions } = node as IndexNode;
      if (
        dimensions.some(
          (dim) =>
            dim.type === 'ConstantNode' &&
            STRINGIFYING_METHODS.has(String((dim as { value?: unknown }).value)),
        )
      ) {
        inspection.stringifies = true;
      }
      return;
    }
    if (node.type !== 'FunctionNode') return;
    const callee = (node as FunctionNode).fn as MathNode & { name?: string };
    if (callee.type !== 'SymbolNode' || callee.name === undefined) return;
    if (OPERATION_FUNCTIONS.has(callee.name)) {
      inspection.operationCall ??= callee.name;
    } else if (NOTATION_ALIAS.test(callee.name)) {
      callee.name = callee.name === 'ln' ? 'log' : `a${callee.name.slice(3)}`;
    }
  });
  return inspection;
}

/** What {@link scanResult} found while walking a result value. */
interface ResultScan {
  /** Leaf elements seen so far; the walk stops once this passes the limit. */
  elements: number;
  /** Whether to look for float approximations — set under numericType "Fraction". */
  readonly exactOnly: boolean;
  /** A `help()` object appears somewhere in the value. */
  help: boolean;
  /** With `exactOnly`, some number in the value is a float approximation. */
  inexact: boolean;
  /** Some number in the value is Infinity, -Infinity, or NaN. */
  nonFinite: boolean;
}

/** Whether a scalar math.js value is Infinity, -Infinity, or NaN. */
function isNonFiniteScalar(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (isBigNumber(value)) return !value.isFinite();
  if (isComplex(value)) return isNonFiniteScalar(value.re) || isNonFiniteScalar(value.im);
  return false;
}

/**
 * Whether a scalar is a 64-bit float that need not be the exact value: a
 * `number`, or a `Complex` part, that is not a safe integer. Under numericType
 * "Fraction" an exact value is a Fraction or a whole-number count (`count`,
 * `size`), so such a float came from an irrational constant, a non-integer
 * power, complex arithmetic, or an explicit float conversion. The test is
 * safe-integer rather than integer because every double past 2^53 is an integer.
 * A `BigNumber` only appears when an expression asks for one (`bignumber(x)`),
 * and a `Unit` is judged by its magnitude.
 */
function isFloatApproximation(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isSafeInteger(value);
  if (isComplex(value)) return isFloatApproximation(value.re) || isFloatApproximation(value.im);
  return false;
}

/** Record a scalar's non-finite and float-approximation findings on the scan. */
function scanScalar(value: unknown, scan: ResultScan): void {
  if (isNonFiniteScalar(value)) scan.nonFinite = true;
  if (scan.exactOnly && isFloatApproximation(value)) scan.inexact = true;
}

/**
 * Walk a result once, counting leaf elements (stopping past `limit`) and flagging
 * `help()` objects, non-finite numbers, and — with `exactOnly` — float
 * approximations. The number checks reach every container a result can nest a
 * number in — matrix elements (dense data, or a sparse matrix's stored values,
 * never densified), `Complex` parts, a `Unit`'s magnitude, `BigNumber`s, and
 * object-literal values. `Fraction`s are always finite (fraction.js throws
 * instead of producing Infinity) and always exact.
 */
function scanResult(value: unknown, limit: number, scan: ResultScan): void {
  if (scan.elements > limit) return;
  if (value === null || typeof value !== 'object') {
    scan.elements++;
    scanScalar(value, scan);
    return;
  }
  if (isHelp(value)) {
    scan.elements++;
    scan.help = true;
    return;
  }
  if (isSparseMatrix(value)) {
    scanResult((value as unknown as { _values?: unknown[] })._values ?? [], limit, scan);
    return;
  }
  if (isMatrix(value)) {
    const size = (value as unknown as { size(): number[] }).size();
    if (size.reduce((n, d) => n * d, 1) > limit) {
      scan.elements = limit + 1;
      return;
    }
    scanResult(value.valueOf(), limit, scan);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanResult(item, limit, scan);
      if (scan.elements > limit) return;
    }
    return;
  }
  if (isUnit(value)) {
    scan.elements++;
    scanScalar((value as unknown as { value: unknown }).value, scan);
    return;
  }
  // BigNumber, Complex, Fraction, and other class instances are scalars.
  if (!isPlainObject(value)) {
    scan.elements++;
    scanScalar(value, scan);
    return;
  }
  for (const item of Object.values(value)) {
    scanResult(item, limit, scan);
    if (scan.elements > limit) return;
  }
}

/** Script every timed call runs in the service's reused vm context. */
const TIMED_CALL = new vm.Script('result = fn()');

/** Globals of the reused vm context: the call to run and its return value. */
interface TimedCallSandbox extends vm.Context {
  fn?: (() => unknown) | undefined;
  result?: unknown;
}

/** Bundled references extracted from a single math.js instance. */
interface MathInstance {
  derivative: (expr: MathNode, variable: string) => MathNode;
  format: (
    value: unknown,
    options?: { precision?: number; lowerExp?: number; upperExp?: number },
  ) => string;
  /** Whether an expression name resolves to one of this instance's functions. */
  isFunction: (name: string) => boolean;
  parse: (expr: string) => MathNode;
  /** Return the auto unit system to its seed, so no earlier call shapes this one's units. */
  resetUnitSystem: () => void;
  /** A scope value in this instance's numeric type, where it converts exactly. */
  scopeValue: (value: number) => unknown;
  simplify: (expr: MathNode, rules?: SimplifyRule[]) => MathNode;
  /** math.js default simplify rules, captured before the hardening override. */
  simplifyRules: SimplifyRule[];
  typeOf: (value: unknown) => string;
}

/**
 * Largest decimal exponent a Fraction-mode literal may carry. `1e1000` already
 * spells out a 1001-digit integer; past this, an exponent only builds numbers too
 * large to return, so it fails fast instead of allocating.
 */
const MAX_FRACTION_LITERAL_EXPONENT = 1000;

/** A decimal literal in exponent notation: mantissa digits, fraction digits, exponent. */
const EXPONENT_LITERAL = /^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/;

/**
 * Rewrite an exponent-notation literal as the plain decimal it denotes
 * (`1.5e-3` → `0.0015`), which fraction.js reads exactly. Returns `undefined`
 * for anything that is not exponent notation.
 */
function expandExponentLiteral(literal: string): string | undefined {
  const match = EXPONENT_LITERAL.exec(literal);
  if (!match) return undefined;
  const [, whole = '', fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  if (Math.abs(exponent) > MAX_FRACTION_LITERAL_EXPONENT) {
    throw new SyntaxError(
      `Exponent literal "${literal}" is out of range for numericType "Fraction" (exponents up to ±${MAX_FRACTION_LITERAL_EXPONENT}); use numericType "BigNumber" for numbers this large or small.`,
    );
  }
  const digits = whole + fraction;
  const point = whole.length + exponent;
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Let a Fraction instance read exponent-notation literals exactly. `numeric` is
 * what the parser uses to turn a literal into a value; for a Fraction target, an
 * exponent literal is expanded to plain decimal first. Every other conversion is
 * passed through unchanged.
 */
function installExponentLiterals(
  math: ReturnType<typeof create>,
  mathImport: ReturnType<typeof create>['import'],
): void {
  const numeric = math.numeric.bind(math) as (value: unknown, outputType?: string) => unknown;
  const exactNumeric = (value: unknown, outputType?: string) => {
    const expanded =
      outputType === 'Fraction' && typeof value === 'string'
        ? expandExponentLiteral(value)
        : undefined;
    return numeric(expanded ?? value, outputType);
  };
  mathImport({ numeric: exactNumeric }, { override: true });
}

/**
 * Read Fraction-mode scope values the way the instance's own arithmetic does:
 * math.js converts a number to a Fraction implicitly when the Fraction equals it
 * exactly (0.5 → 1/2, 0.1 → 1/10), so `x + 0` already reads 0.5 as 1/2. Applying
 * that rule up front makes a bare `x` read the same. A number with no equal
 * Fraction stays a float, which the result scan then rejects.
 */
function fractionScopeValue(fraction: (value: number) => Fraction): (value: number) => unknown {
  return (value) => {
    const exact = fraction(value);
    return exact.valueOf() === value ? exact : value;
  };
}

/** The math.js `Unit` statics that unit registration and simplification read. */
interface UnitRegistry {
  BASE_UNITS: Record<string, unknown>;
  UNIT_SYSTEMS: Record<string, Record<string, unknown>> & { auto: Record<string, unknown> };
  UNITS: Record<string, { base?: unknown }>;
}

/**
 * Register {@link CUSTOM_UNITS} without changing how other results simplify, and
 * return a function that resets the instance's auto unit system.
 *
 * math.js simplifies a combined result (`10 m / 2 s`) through its "auto" unit
 * system: one unit per base dimension, overwritten by every unit it parses. That
 * state lives on the instance, so it leaked between calls, and `createUnit`
 * disturbed it three ways. A unit whose dimensions match no base unit (a velocity)
 * got a base of its own (`mph_STUFF`), so every velocity then simplified to mph or
 * knot. A unit with a base enters the auto system whenever it is parsed, so a
 * `lightyear` elsewhere turned length results into `ly`. And parsing the
 * definitions re-seeded the system (`hour` as the time unit). So the new base is
 * removed, the custom units lose their base (they keep their dimensions, so
 * conversions and unit checks are unchanged), and the auto system is reset to its
 * seed before every call (#37).
 */
function registerCustomUnits(math: ReturnType<typeof create>): () => void {
  const registry = math.Unit as unknown as UnitRegistry;
  const auto = registry.UNIT_SYSTEMS.auto;
  const seed = { ...auto };
  const bases = new Set(Object.keys(registry.BASE_UNITS));
  const units = new Set(Object.keys(registry.UNITS));
  math.createUnit(CUSTOM_UNITS);
  for (const key of Object.keys(registry.BASE_UNITS)) {
    if (bases.has(key)) continue;
    delete registry.BASE_UNITS[key];
    for (const system of Object.values(registry.UNIT_SYSTEMS)) delete system[key];
  }
  for (const [name, unit] of Object.entries(registry.UNITS)) {
    if (!units.has(name)) delete unit.base;
  }
  return () => {
    for (const key of Object.keys(auto)) delete auto[key];
    Object.assign(auto, seed);
  };
}

/** Create and harden a math.js instance with the given numeric type. */
function createMathInstance(number: 'number' | 'BigNumber' | 'Fraction'): MathInstance {
  // biome-ignore lint/style/noNonNullAssertion: math.js types declare `all` as potentially undefined, but it's always defined at runtime
  const math = create(all!, { number });
  // Capture math.import before it's disabled — needed for the imports and guards below.
  const mathImport = math.import.bind(math);

  // fraction.js cannot read exponent notation, so a Fraction-mode literal such as
  // `2e5` fails to parse. The parser converts literals through `numeric`, which it
  // captures when first created — so the override must precede the `parse` capture.
  if (number === 'Fraction') installExponentLiterals(math, mathImport);

  // Capture references BEFORE the override step — the import shim replaces these
  // on the instance, so binding after would capture the disabled stubs.
  const format = math.format.bind(math);
  const typeOf = math.typeOf.bind(math);
  // Symbolic operations are captured here too so a hardened instance can back
  // simplify/derivative — constant-folding inside them then hits the same
  // disabled-function / redacted-constant overrides applied below (#18). `.rules`
  // must be read before binding, since bind() drops the function's own properties.
  const parse = math.parse.bind(math);
  const simplify = math.simplify.bind(math);
  const derivative = math.derivative.bind(math);
  const simplifyRules = [...math.simplify.rules] as SimplifyRule[];
  const scopeValue =
    number === 'Fraction' ? fractionScopeValue(math.fraction.bind(math)) : (value: number) => value;

  // Read the config before the override (an empty options object changes nothing).
  // math.js injects `config` into every factory it instantiates lazily, and reads it
  // both as a call (config()) and as properties (config.relTol, config.precision). A
  // throwing stub breaks those readers — BigNumber arithmetic fails with
  // `[DecimalError] precision: NaN`, and number-mode functions created after the
  // override (eigs, schur, intersect, isPositive, compare, …) see `relTol`/`absTol` as
  // undefined (#25). Every instance therefore gets a read-only guard (installed
  // below): reads pass through, writes throw.
  const currentConfig = math.config({}) as Record<string, unknown>;

  // Register custom units and function-name aliases (natural-language plus common
  // cross-ecosystem synonyms from Excel/NumPy/calculator notation). None are math.js
  // builtins, so the imports are purely additive — they turn an agent's natural guess
  // into a result instead of an "undefined function" error. Statistics/combinatorics
  // functions aren't differentiable, so a value-alias suffices (unlike ln/arc*, which
  // are renamed on the parse tree to stay in the derivative table — see inspectTree).
  // Must run before createUnit/import are disabled below.
  const resetUnitSystem = registerCustomUnits(math);
  mathImport({
    average: math.mean,
    avg: math.mean,
    stdev: math.std,
    stddev: math.std,
    permute: math.permutations,
    nPr: math.permutations,
    choose: math.combinations,
    nCr: math.combinations,
    length: math.count,
    len: math.count,
  });

  // Bound what an expression can build from a size argument, a product, a broadcast,
  // a repeated input, an index, or a formatting precision. Installed on the instance,
  // so simplify/derivative constant folding on this instance hits the same limits.
  installSizeGuards(math, mathImport, all as unknown as Record<string, unknown>);

  // Replace `config` with a read-only guard. Two access patterns must be preserved
  // for math.js internals:
  //   1. config()          — gamma/factorial call this to read the full config object
  //   2. config.precision  — gamma accesses precision directly as a property on the
  //      function; eigs, intersect, compare, … read config.relTol / config.absTol
  //
  // Replacing config with a plain stub breaks both; the guard function below satisfies
  // both patterns while blocking write access (calls with a non-empty options object).
  // A bare `config()` from an expression therefore returns the config object.
  const configGuard = Object.assign(
    (options?: Record<string, unknown>) => {
      if (options !== undefined && Object.keys(options).length > 0) {
        throw new Error('"config" is disabled for security.');
      }
      return currentConfig;
    },
    currentConfig, // spread all config props (precision, relTol, …) onto the function object
  );

  // Disable dangerous functions and redact constants that leak implementation details,
  // through the pre-captured import (this step disables math.import too).
  const overrides: Record<string, unknown> = { ...REDACTED_CONSTANTS, config: configGuard };
  for (const fn of DISABLED_FUNCTIONS) {
    overrides[fn] = () => {
      throw new Error(`Function "${fn}" is disabled for security.`);
    };
  }
  mathImport(overrides, { override: true });

  // The namespace an expression's names resolve in (before units), transforms included.
  const expressionNames = (
    math as unknown as { expression: { mathWithTransform: Record<string, unknown> } }
  ).expression.mathWithTransform;

  return {
    format,
    typeOf,
    parse,
    isFunction: (name) =>
      Object.hasOwn(expressionNames, name) && typeof expressionNames[name] === 'function',
    resetUnitSystem,
    scopeValue,
    simplify: simplify as MathInstance['simplify'],
    derivative: derivative as MathInstance['derivative'],
    simplifyRules,
  };
}

export class MathService {
  /** Default IEEE 754 instance — used for the vast majority of evaluations. */
  private readonly defaultInstance: MathInstance;
  /** BigNumber instance — 64 significant digits; selected via numericType: "BigNumber". */
  private readonly bigNumberInstance: MathInstance;
  /** Fraction instance — exact rational arithmetic; selected via numericType: "Fraction". */
  private readonly fractionInstance: MathInstance;

  private readonly simplify: MathInstance['simplify'];
  private readonly derivative: MathInstance['derivative'];
  private readonly simplifyRules: SimplifyRule[];
  private readonly config: ServerConfig;
  /** vm context reused by every timed call; see {@link runWithTimeout}. */
  private readonly sandbox = vm.createContext({}) as TimedCallSandbox;

  constructor(config: ServerConfig) {
    this.config = config;

    // Pre-initialize one hardened instance per numeric type so numeric-type selection
    // at evaluation time is a simple Map lookup, not a per-request reconfiguration.
    this.defaultInstance = createMathInstance('number');
    this.bigNumberInstance = createMathInstance('BigNumber');
    this.fractionInstance = createMathInstance('Fraction');

    // Symbolic operations (parse / simplify / derivative) operate on the AST and are
    // numeric-type-agnostic, so they reuse the hardened default instance rather than a
    // separate unhardened one. This ensures the constant-folding math.js performs inside
    // simplify/derivative resolves disabled functions to their throwing stubs and reads
    // the redacted `version` — closing the bypass where folded `evaluate("…")` ran on an
    // unhardened instance (#18).
    this.simplify = this.defaultInstance.simplify;
    this.derivative = this.defaultInstance.derivative;
    this.simplifyRules = [...this.defaultInstance.simplifyRules, ...TRIG_SIMPLIFY_RULES];
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
    const inst = this.instanceFor(numericType);
    // Parse with the instance for the requested numericType: constant nodes take
    // their numeric type at parse time.
    const { tree, functionValues } = this.parseExpression(expression, inst, ctx);
    // Evaluation, result inspection, and formatting all run inside the timeout, so
    // no result reaches formatting unchecked and no step runs unbounded (#31).
    return this.runWithTimeout(
      () => {
        // Evaluate against a copy: an assignment in the expression (`(y = 2) + x`)
        // writes into the scope it is given, and the caller's object must not change (#34).
        const variables = Object.entries(scope ?? {}).map(
          ([name, value]) => [name, inst.scopeValue(value)] as const,
        );
        const raw = tree.compile().evaluate(new Map(variables));
        const resultType = inst.typeOf(raw);
        this.validateResultType(resultType, ctx);
        this.validateResultValue(raw, ctx, numericType);
        // Match JS Number.toString thresholds — math.js defaults to exp ≥ 5,
        // which would render 83810205 as "8.3810205e+7".
        const result = inst.format(raw, {
          lowerExp: -6,
          upperExp: 21,
          ...(precision != null && { precision }),
        });
        this.validateResultSize(result, ctx);
        return { result, resultType };
      },
      ctx,
      {
        operation: 'evaluate',
        numericType,
        // A scope value shadows the function of the same name.
        functionValues: functionValues.filter((name) => !(scope && Object.hasOwn(scope, name))),
      },
    );
  }

  /** Simplify an algebraic expression symbolically. */
  simplifyExpression(expression: string, ctx: Context): MathResult {
    this.validateInput(expression, ctx);
    const { tree } = this.parseExpression(expression, this.defaultInstance, ctx);
    // Capture the alias-normalized input before simplification so we can detect
    // whether the simplifier made any progress. String comparison of the raw input
    // is not sufficient — formatting-only changes like `x+1` vs `x + 1` should not
    // count as progress — so both sides are compared as math.js renders them.
    const inputNormalized = tree.toString();
    const result = this.runWithTimeout(
      () => this.simplify(tree, this.simplifyRules).toString(),
      ctx,
      { operation: 'simplify' },
    );
    this.validateResultSize(result, ctx);
    return { result, resultType: 'string', unchanged: inputNormalized === result };
  }

  /** Compute the symbolic derivative of an expression with respect to a variable. */
  differentiateExpression(expression: string, variable: string, ctx: Context): MathResult {
    this.validateInput(expression, ctx);
    const { tree } = this.parseExpression(expression, this.defaultInstance, ctx);
    const result = this.runWithTimeout(() => this.derivative(tree, variable).toString(), ctx, {
      operation: 'derivative',
      variable,
    });
    this.validateResultSize(result, ctx);
    return { result, resultType: 'string' };
  }

  /** Get formatted help content listing available functions, operators, and syntax. */
  getHelpContent(): string {
    return HELP_CONTENT;
  }

  private validateInput(expression: string, ctx: Context): void {
    if (!expression.trim()) {
      throw declared(ctx, 'empty_expression', 'Expression cannot be empty.');
    }
    if (expression.length > this.config.maxExpressionLength) {
      throw declared(
        ctx,
        'expression_too_long',
        `Expression exceeds maximum length of ${this.config.maxExpressionLength} characters.`,
      );
    }
  }

  /**
   * Parse once and check the tree before anything evaluates. A parse failure is
   * `parse_failed`. Multiple statements are detected structurally — math.js parses
   * `a; b` and a top-level newline into a `BlockNode` — so `;` inside a matrix or
   * inside either quote style (`"a;b"`, `'a;b'`) is data, transpose `A'` stays an
   * operator, and a real separator is rejected before either statement runs (#32).
   * math.js treats a bare carriage return as a syntax error rather than a
   * separator; when it is what broke the parse, the input is re-parsed with line
   * feeds purely to report `multiple_expressions` — the rewritten text is never
   * evaluated. The same tree then gets the stringifier check, the
   * operation-as-function check (#27), and the notation rename (#24), and yields
   * the names it uses as values that resolve to functions (#38). Every operation
   * starts here, so it also resets the instance's auto unit system (#37).
   */
  private parseExpression(
    expression: string,
    inst: MathInstance,
    ctx: Context,
  ): { tree: MathNode; functionValues: string[] } {
    inst.resetUnitSystem();
    let tree: MathNode;
    try {
      tree = inst.parse(expression);
    } catch (err) {
      if (
        expression.includes('\r') &&
        this.parsesAsBlock(expression.replace(/\r\n?/g, '\n'), inst)
      ) {
        throw this.multipleExpressions(ctx);
      }
      throw declared(ctx, 'parse_failed', `Invalid expression: ${errorMessage(err)}`);
    }
    if (tree.type === 'BlockNode') throw this.multipleExpressions(ctx);

    const { stringifies, operationCall, valueNames } = inspectTree(tree);
    // `.toString()` / `.toLocaleString()` on a function-valued identifier
    // (`cos.toString()`) returns the function's source as a plain string, slipping
    // past validateResultType, which only sees the value after stringification. No
    // calculator expression needs either method, so the accessor is rejected on any
    // operand; a string literal containing "toString" is a ConstantNode, not an
    // accessor, and is unaffected.
    if (stringifies) {
      throw declared(
        ctx,
        'disallowed_result_type',
        'Converting a function to a string is not allowed — it would expose internal source.',
      );
    }
    if (operationCall !== undefined) {
      const variableHint = operationCall === 'derivative' ? ' and pass `variable`' : '';
      throw declared(
        ctx,
        'operation_as_function',
        `"${operationCall}" is an operation, not a function available inside expressions. Send the inner expression as \`expression\` with \`operation: "${operationCall}"\`${variableHint}.`,
      );
    }
    return { tree, functionValues: [...valueNames].filter(inst.isFunction) };
  }

  /** Whether `expression` parses to multiple statements. */
  private parsesAsBlock(expression: string, inst: MathInstance): boolean {
    try {
      return inst.parse(expression).type === 'BlockNode';
    } catch {
      return false;
    }
  }

  private multipleExpressions(ctx: Context): McpError {
    return declared(
      ctx,
      'multiple_expressions',
      'Multiple expressions are not allowed. Submit one expression per call.',
    );
  }

  /** Reject scope keys that could pollute the object prototype chain. */
  private validateScope(scope: Record<string, number>, ctx: Context): void {
    for (const key of Object.keys(scope)) {
      if (BLOCKED_SCOPE_KEYS.has(key)) {
        throw declared(
          ctx,
          'reserved_scope_key',
          `Scope key "${key}" is not allowed — it conflicts with a reserved property name.`,
        );
      }
    }
  }

  /** Reject result types that leak internals (functions, parsers, multi-expression ResultSets). */
  private validateResultType(resultType: string, ctx: Context): void {
    if (BLOCKED_RESULT_TYPES.has(resultType)) {
      throw declared(
        ctx,
        'disallowed_result_type',
        `Expression produced a ${resultType}, which cannot be returned — the result must be a value, not a function.`,
      );
    }
  }

  /**
   * Inspect a result before it is formatted: reject a `help()` object (its
   * rendering evaluates the documentation examples, #31), a collection too large
   * to ever fit `maxResultLength` (checked before formatting, so it is never
   * stringified), any non-finite number, scalar or nested (#21), and under
   * numericType "Fraction", any float approximation, scalar or nested (#35).
   */
  private validateResultValue(raw: unknown, ctx: Context, numericType: NumericType): void {
    const { maxResultLength } = this.config;
    if (typeof raw === 'string' && raw.length > maxResultLength) {
      throw this.resultTooLarge(ctx);
    }
    const elementLimit = Math.floor(maxResultLength / MIN_CHARS_PER_ELEMENT);
    const scan: ResultScan = {
      elements: 0,
      help: false,
      nonFinite: false,
      exactOnly: numericType === 'Fraction',
      inexact: false,
    };
    scanResult(raw, elementLimit, scan);
    if (scan.help) {
      throw declared(
        ctx,
        'disallowed_result_type',
        'help() is not available inside expressions — read the calculator://help resource for the function reference.',
      );
    }
    if (scan.elements > elementLimit) throw this.resultTooLarge(ctx);
    if (scan.nonFinite) throw declared(ctx, 'undefined_result', UNDEFINED_RESULT_MESSAGE);
    if (scan.inexact) throw declared(ctx, 'fraction_unsupported', FRACTION_FLOAT_MESSAGE);
  }

  /** Reject results that exceed the configured maximum size. */
  private validateResultSize(result: string, ctx: Context): void {
    if (result.length > this.config.maxResultLength) throw this.resultTooLarge(ctx);
  }

  private resultTooLarge(ctx: Context): McpError {
    return declared(
      ctx,
      'result_too_large',
      `Result exceeds maximum size (${this.config.maxResultLength} characters). Reduce matrix dimensions or simplify the expression.`,
    );
  }

  /**
   * Runs a synchronous function inside a vm sandbox with timeout protection and
   * maps anything it throws to a declared reason via {@link classifyFailure}.
   *
   * The context exists only to carry the timeout — `fn` and everything it calls
   * run in this realm — so one context is reused for every call and cleared
   * afterwards. A fresh context per call costs ~100 µs and, under Bun, retains
   * ~100 KB of memory per call.
   */
  private runWithTimeout<T>(fn: () => T, ctx: Context, stage: FailureStage): T {
    const { sandbox } = this;
    sandbox.fn = fn;
    beginEvaluation();
    try {
      TIMED_CALL.runInContext(sandbox, { timeout: this.config.evaluationTimeoutMs });
      return sandbox.result as T;
    } catch (err) {
      throw this.classifyFailure(err, ctx, stage);
    } finally {
      sandbox.fn = undefined;
      sandbox.result = undefined;
    }
  }

  /**
   * Classify a failure raised after the expression parsed (evaluation, result
   * inspection, formatting, or a symbolic operation). First match wins:
   *
   * 1. Already-classified `McpError`s (result checks) pass through.
   * 2. Timeout → `evaluation_timeout`.
   * 3. A size guard (see size-guard.ts) → `result_too_large`.
   * 4. Fraction mode calling a function with no Fraction implementation (sqrt,
   *    sin, log, factorial, …) → `fraction_unsupported` (#19); so does Fraction
   *    mode meeting a float with no equal Fraction (`pi * 2/3`, #35).
   * 5. fraction.js `Division by Zero`, in any numericType → `undefined_result` (#21).
   * 6. Name errors (undefined symbol/function/unit, disabled function, blocked
   *    property) → `parse_failed`.
   * 7. A symbolic operation (simplify, derivative) that cannot process the parsed
   *    tree → `evaluation_failed`, with a hint about the symbolic engine rather
   *    than about argument values (see {@link symbolicFailure}).
   * 8. Operand type/unit errors (typed-function `wrongType`, unit mismatch,
   *    string-to-number) → `type_mismatch`.
   * 9. Anything else — arity, domain, singular matrix, dimensions, index →
   *    `evaluation_failed` (#29). Stage decides, not error class: a runtime
   *    `SyntaxError` such as `number("abc")` lands here, never in `parse_failed`.
   */
  private classifyFailure(err: unknown, ctx: Context, stage: FailureStage): McpError {
    const { numericType } = stage;
    if (err instanceof McpError) return err;
    const message = errorMessage(err);
    // math.js's map/forEach/filter re-wrap a callback's error in a new one that
    // embeds its message, so a timeout inside a callback loses the error code.
    const timedOut =
      (err instanceof Error && 'code' in err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') ||
      VM_TIMEOUT_ERROR.test(message);
    if (timedOut) {
      return timeout(
        `Expression evaluation timed out after ${this.config.evaluationTimeoutMs / 1000} seconds. Simplify the expression or reduce matrix dimensions.`,
        { reason: 'evaluation_timeout', ...ctx.recoveryFor('evaluation_timeout') },
      );
    }
    const limitError = sizeLimitErrorIn(err);
    if (limitError) {
      return declared(ctx, 'result_too_large', `Size limit exceeded: ${limitError.message}`);
    }
    if (numericType === 'Fraction' && FRACTION_CONVERSION_ERROR.test(message)) {
      return declared(ctx, 'fraction_unsupported', FRACTION_FUNCTION_MESSAGE);
    }
    if (numericType === 'Fraction' && FLOAT_TO_FRACTION_ERROR.test(message)) {
      return declared(ctx, 'fraction_unsupported', FRACTION_FLOAT_MESSAGE);
    }
    if (FRACTION_DIVISION_BY_ZERO.test(message)) {
      return declared(ctx, 'undefined_result', UNDEFINED_RESULT_MESSAGE);
    }
    if (NAME_ERROR.test(message)) {
      return declared(ctx, 'parse_failed', `Invalid expression: ${message}`);
    }
    if (stage.operation !== 'evaluate') return symbolicFailure(stage, message);
    const data = (err as { data?: { category?: unknown; actual?: unknown } } | null)?.data;
    const category = data?.category;
    if (
      category === 'wrongType' &&
      Array.isArray(data?.actual) &&
      data.actual.includes('function')
    ) {
      return functionAsValue(stage.functionValues, message);
    }
    if (category === 'wrongType' || TYPE_MISMATCH_ERROR.test(message)) {
      return declared(ctx, 'type_mismatch', `Type mismatch: ${message}`);
    }
    return declared(ctx, 'evaluation_failed', `Evaluation failed: ${message}`);
  }
}

/**
 * `evaluation_failed` for a symbolic operation that parsed but could not be
 * carried out. The hint is written at the throw site: the contract hint is about
 * fixing an argument, but here the syntax and arguments are fine — the symbolic
 * engine has no rule for part of the expression (a function such as `floor` or
 * an operator such as `==` in a derivative, or a matrix or conditional node).
 */
function symbolicFailure(stage: SymbolicStage, message: string): McpError {
  const { operation } = stage;
  const noRule = operation === 'derivative' && NO_DERIVATIVE_RULE.exec(message);
  if (noRule) {
    const [, kind, name] = noRule;
    return validationError(
      `The derivative operation has no rule for the ${kind} "${name}", so it cannot differentiate this expression symbolically.`,
      {
        reason: 'evaluation_failed',
        recovery: {
          hint: `"${name}" has no symbolic derivative rule — rewrite the expression without it, or evaluate it numerically with operation "evaluate", passing values for its variables (such as ${stage.variable}) through scope.`,
        },
      },
    );
  }
  return validationError(
    `The ${operation} operation cannot process this expression symbolically: ${message}`,
    {
      reason: 'evaluation_failed',
      recovery: {
        hint: `The ${operation} engine cannot handle part of this expression (for example a matrix or conditional) — rewrite it with scalar functions and operators, or evaluate it numerically with operation "evaluate" and values passed through scope.`,
      },
    },
  );
}

/**
 * `type_mismatch` for a function where a value belongs: math.js reads a name or
 * definition next to a value as multiplication (`5 min` is 5 times the minimum
 * function, `(f(x) = x^2)(3)` is the function times 3). The contract hint is about
 * units, so the hint is written here (#38), naming the functions the expression
 * uses as values and the unit to write for one that shadows a unit name.
 */
function functionAsValue(names: string[], detail: string): McpError {
  const described = names.map((name) => {
    const unit = FUNCTION_SHADOWED_UNITS[name];
    return unit ? `"${name}" is a function, not the unit "${unit}"` : `"${name}" is a function`;
  });
  const unitHints = names.flatMap((name) => {
    const unit = FUNCTION_SHADOWED_UNITS[name];
    return unit
      ? [`"${name}" names a function here; for the unit, write ${unit} (\`5 ${unit}\`).`]
      : [];
  });
  return validationError(
    `Type mismatch: a function was used as a value${described.length ? ` (${described.join('; ')})` : ''}. ${detail}`,
    {
      reason: 'type_mismatch',
      recovery: {
        hint: [
          ...unitHints,
          'To call a function, use parentheses (`sin(1)`, `f(3)`); a function name or definition next to a value multiplies it instead.',
        ].join(' '),
      },
    },
  );
}

/** A validation error carrying `reason` and the recovery hint its contract entry declares. */
function declared(ctx: Context, reason: string, message: string): McpError {
  return validationError(message, { reason, ...ctx.recoveryFor(reason) });
}

/** Message of a thrown value, whatever its type. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
| Infinity | Infinity | Positive infinity — intermediate values only |
| NaN | NaN | Not a number — intermediate values only |
| true | true | Boolean true |
| false | false | Boolean false |

\`Infinity\` and \`NaN\` work inside an expression (\`1/Infinity\` => \`0\`, \`isNaN(NaN)\` => \`true\`), but a result that is Infinity, -Infinity, or NaN anywhere in it fails with \`undefined_result\`: \`Infinity\` and \`NaN\` on their own fail.

## Functions

> **Standard notation accepted:** \`ln\` works as natural log (canonical \`log\`), and the \`arc*\` inverse-trig names (\`arcsin\`, \`arccos\`, \`arctan\`, \`arcsinh\`, …) work as their \`a*\` equivalents (\`asin\`, \`acos\`, \`atan\`, …). Both forms are valid across evaluate, simplify, and derivative.

### Arithmetic
abs, ceil, floor, round, sign, sqrt, cbrt, exp, expm1, log (also: ln), log2, log10, log1p, pow, mod, gcd, lcm, nthRoot, hypot, fix, cube, square, unaryMinus, unaryPlus

### Trigonometry
sin, cos, tan, asin (arcsin), acos (arccos), atan (arctan), atan2, sinh, cosh, tanh, asinh (arcsinh), acosh (arccosh), atanh (arctanh), sec, csc, cot, asec (arcsec), acsc (arccsc), acot (arccot), sech, csch, coth, asech (arcsech), acsch (arccsch), acoth (arccoth)

### Statistics
mean (aliases: average, avg), median, mode, std (aliases: stdev, stddev), variance, min, max, sum, prod, quantileSeq, mad, count (aliases: length, len)

\`std\` and \`variance\` (and the \`stdev\`/\`stddev\` aliases) return the sample statistic by default. An optional normalization string after the array or matrix picks the divisor:

| Normalization | Divisor | \`std([2, 4, 6], …)\` | \`variance([2, 4, 6], …)\` |
|:--------------|:--------|:--------------------|:-------------------------|
| \`"unbiased"\` (default, sample) | n − 1 | \`2\` | \`4\` |
| \`"uncorrected"\` (population) | n | \`1.632993161855452\` | \`2.6666666666666665\` |
| \`"biased"\` | n + 1 | \`1.4142135623730951\` | \`2\` |

\`std([2, 4, 6], "uncorrected")\` => \`1.632993161855452\`. The normalization must follow an array or matrix: \`std(2, 4, 6, "uncorrected")\` fails.

- \`mad\` is the unscaled median absolute deviation (no 1.4826 factor): \`mad([1, 2, 3, 4, 100])\` => \`1\`
- \`quantileSeq\` interpolates linearly: \`quantileSeq([1, 2, 3, 4], 0.25)\` => \`1.75\`. A third argument \`true\` declares the data already sorted and skips sorting, so unsorted data then gives a wrong answer: \`quantileSeq([4, 3, 2, 1], 0.25, true)\` => \`3.25\`
- \`mode\` always returns an array, even with a single mode: \`mode([1, 2, 2, 3])\` => \`[2]\`

### Matrix
det, inv, transpose, trace, zeros, ones, identity, diag, size, reshape, flatten, concat, sort, cross, dot, eigs, expm, sqrtm, kron, pinv, range

### Combinatorics
factorial, gamma, permutations (aliases: permute, nPr), combinations (aliases: choose, nCr), catalan, bellNumbers, stirlingS2, composition, multinomial

### Complex Numbers
re, im, conj, arg, complex

### Logical
and, or, xor, not

### Comparison
equal, unequal, larger, largerEq, smaller, smallerEq, compare, deepEqual

### Unit Conversion
Syntax: \`value unit to targetUnit\`

Common units: m, cm, mm, km, inch, ft, yard, mile, lightyear (ly), kg, g, lb, oz, s, minute, hour, day, mph, knot (kt), celsius, fahrenheit, kelvin, liter, gallon, joule, watt, newton, Pa, bar, psi, radian, degree

\`min\` is the minimum function, not minutes, so write \`minute\`: \`5 minute to s\` => \`300 s\`. Pascals are \`Pa\`: \`1 bar to Pa\` => \`100000 Pa\`.

## Syntax Examples

Each example shows the exact result string \`calculate\` returns.

### Basic arithmetic
\`2 + 3 * 4\` => \`14\`

### Functions
\`sqrt(144)\` => \`12\`
\`sin(pi / 2)\` => \`1\`
\`log(1000, 10)\` => \`2.9999999999999996\` (floating-point rounding); with \`precision: 10\`, \`log(1000, 10)\` => \`3\`

### Variables (scope parameter, evaluate only)
Provide scope: { "x": 5, "y": 3 }
Expression: \`x^2 + y\` => \`28\`

### Matrices
\`[1, 2; 3, 4]\` — 2x2 matrix (\`;\` separates rows)
\`det([1, 2; 3, 4])\` => \`-2\`
\`inv([1, 2; 3, 4])\` => \`[[-2, 1], [1.5, -0.5]]\`

### Complex numbers
\`2 + 3i\` => \`2 + 3i\`
\`sqrt(-4)\` => \`2i\`
\`abs(3 + 4i)\` => \`5\`
\`log(-1)\` => \`3.141592653589793i\` — the log of a negative number is complex, not undefined

### Unit conversion
\`5 kg to lbs\` => \`11.023113109243878 lbs\`
\`100 celsius to fahrenheit\` => \`211.99999999999997 fahrenheit\`
\`1 mile to km\` => \`1.609344 km\`

> **Note:** Unit conversions use IEEE 754 floating-point arithmetic, so results can carry rounding artifacts like the one above. Use the \`precision\` parameter to round: with \`precision: 6\`, \`100 celsius to fahrenheit\` => \`212 fahrenheit\`.

### Precision
The \`precision\` parameter (1\u201316 significant digits) rounds numeric results: with \`precision: 4\`, \`1 / 3\` => \`0.3333\`. Fraction results always print exactly, and symbolic operations ignore it.

### Operations

- **evaluate** (default): Compute a numeric result. The \`numericType\` parameter picks the number representation:
  - \`"number"\` (default): 64-bit IEEE 754 float — fastest, about 16 significant digits. A value past about 1.8e308 overflows to Infinity and fails with \`undefined_result\` (\`171!\`, \`2^1024\`, \`exp(1000)\`).
  - \`"BigNumber"\`: decimal with 64 significant digits and a much wider exponent range; slower than \`"number"\`. Use it when a value overflows the float range: with \`numericType: "BigNumber"\`, \`2^2000\` => \`1.148130695274254524232833201177681984022317702088695200477642737e+602\`. Results are 64-digit approximations, not exact: \`10000! / 9999!\` => \`9999.999999999999999999999999999999999999999999999999999999999996\`, and adding \`precision: 16\` rounds it, \`10000! / 9999!\` => \`10000\`.
  - \`"Fraction"\`: exact rational arithmetic — \`0.1 + 0.2\` => \`3/10\`, \`1/3 + 1/6\` => \`1/2\`. An expression fails with \`fraction_unsupported\` when its result has no exact rational value (\`sqrt(2)\`, \`sin(1)\`, \`log(3)\`), when it calls a function Fraction mode cannot compute, even for a rational result (\`sqrt(4)\`, \`5!\`, \`combinations(5, 2)\`), or when it uses a value Fraction mode holds only as a rounded 64-bit float (\`pi\`, \`e\`, \`2^(1/2)\`, \`sin(pi)\`, a complex number with a non-integer part, \`number(x)\`, or \`random()\`); use \`"number"\` or \`"BigNumber"\` for those. A unit conversion with an irrational factor returns a close rational approximation, not an exact value: \`30 deg to rad\` => \`191068/364913 rad\`. Whole-number indexes and dimensions work as in \`"number"\`: \`[1, 2, 3][2]\` => \`2/1\`, \`sum([1, 2; 3, 4], 1)\` => \`[4/1, 6/1]\`.

  An \`undefined_result\` caused by overflow (large powers, factorials, \`exp\`) can be retried with \`numericType: "BigNumber"\`. Division by zero, \`0/0\`, and \`log(0)\` are undefined in every numeric type, and BigNumber does not change that.

- **simplify**: Reduce an algebraic expression symbolically: \`2x + 3x\` => \`5 * x\`, \`sin(x)^2 + cos(x)^2\` => \`1\`. Supports algebraic rules and common trigonometric identities (Pythagorean, double-angle, tan/sec/csc/cot relationships). \`scope\`, \`precision\`, and \`numericType\` are ignored.

  **Known limits:** The built-in simplifier does not perform polynomial factoring or rational cancellation: \`(x^2 - 1) / (x - 1)\` => \`(x ^ 2 - 1) / (x - 1)\`, returned with \`unchanged: true\`. For these cases, rewrite by hand or use \`evaluate\` with a numeric scope.

- **derivative**: Compute a symbolic derivative; requires the \`variable\` parameter. With \`variable: "x"\`, \`x^2\` => \`2 * x\`. \`scope\`, \`precision\`, and \`numericType\` are ignored.
`;
