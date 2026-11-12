/**
 * @fileoverview Hardened math.js wrapper for secure expression evaluation.
 * Parses each expression once on a hardened math.js instance (see
 * math-instance.ts), checks the tree before anything runs, and evaluates,
 * inspects, and formats the result inside a vm sandbox with a timeout.
 * @module services/math/math-service
 */

import vm from 'node:vm';
import { McpError, timeout, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  type FunctionAssignmentNode,
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
  type SymbolNode,
} from 'mathjs';
import type { ServerConfig } from '@/config/server-config.js';
import { fractionFailureIn } from './fraction-exact.js';
import {
  callsRoutedFunction,
  canonicalName,
  isRoutedFunction,
  routedCall,
} from './function-names.js';
import { HELP_CONTENT } from './help-content.js';
import { BIGNUMBER_ZETA_ERROR, createMathInstance, type MathInstance } from './math-instance.js';
import { guardScalarOperators, parseErrorMessage, readNotation } from './notation.js';
import { beginEvaluation, isPlainObject, meterNode, sizeLimitErrorIn } from './size-guard.js';
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
 * Calls that would read the clock. The calculator reads none — every result is a
 * function of the expression — so `evaluate` rejects them at parse time with a
 * pointer to passing the date as a string. `simplify` and `derivative` keep
 * treating them as symbolic functions (`now(t) + now(t)` → `2 * now(t)`).
 */
const CLOCK_FUNCTIONS = new Set(['now', 'today']);

/**
 * V8's and JavaScriptCore's message for the `RangeError` an exhausted call stack
 * throws (JavaScriptCore ends it with a period).
 */
const STACK_OVERFLOW = /^Maximum call stack size exceeded\.?$/;

/**
 * The `TypeError` math.js throws in place of a callback's error (`map`,
 * `forEach`, `filter`, …): one prefix per callback level, then the callback's
 * message — here the stack overflow's, and nothing else.
 */
const REWRAPPED_STACK_OVERFLOW =
  /^(?:Function \S+ cannot apply callback arguments to function [^:]*: )+Maximum call stack size exceeded\.?$/;

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
 * Fraction implementation: transcendental ones (`sin`, `log`, `exp`, …) and some
 * whose result can be rational (`log2(8)`, `stirlingS2(5, 2)`). math.js reports it
 * as an implicit type-conversion failure that does not name the function; paired
 * with a `numericType === 'Fraction'` guard it maps to the actionable
 * `fraction_unsupported` error instead of the misleading, syntax-oriented
 * `parse_failed`. The functions fraction-exact.ts installs (`sqrt`, `!`,
 * `combinations`, …) throw a `FractionResultError` instead when a result is not
 * rational. See {@link MathService.classifyFailure}.
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
  'numericType "Fraction" cannot compute this expression: either its result has no exact rational value (e.g. sqrt(2), sin(1), log(3)), or it calls a function Fraction mode cannot compute, even for a rational result (e.g. log2(8), stirlingS2(5, 2)). Retry with numericType "number" or "BigNumber".';

/** `undefined_result` message: a non-finite value, or a Fraction division by zero. */
const UNDEFINED_RESULT_MESSAGE =
  'Expression evaluated to a non-finite result (Infinity, -Infinity, or NaN): either the operation is mathematically undefined (division by zero, 0/0, log(0)), or a value overflowed its numeric range (under numericType "number", past about 1.8e308 — e.g. 171!, 2^1024, exp(1000)).';

/** `fraction_unsupported` message for a Fraction-mode evaluation that picked up a float. */
const FRACTION_FLOAT_MESSAGE =
  'numericType "Fraction" cannot return this result exactly: the expression uses a value Fraction mode holds only as a rounded 64-bit float — an irrational constant (pi, e), a complex number with a non-integer part, or a float from number() or random(). Retry with numericType "number" or "BigNumber".';

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
 * math.js refusing a 64-bit float of more than 15 significant digits where a
 * BigNumber is expected — `random() + 1` under numericType "BigNumber",
 * `bignumber(1) + 1/3` in any mode. Unanchored, so a callback error that `map`
 * re-wrapped matches too.
 */
const FLOAT_TO_BIGNUMBER_ERROR =
  /Cannot implicitly convert a number with >15 significant digits to BigNumber/;

/** Recovery for {@link FLOAT_TO_BIGNUMBER_ERROR}, in place of the contract's unit hint. */
const FLOAT_TO_BIGNUMBER_HINT: ThrowSiteHint = {
  text: 'BigNumber arithmetic takes a 64-bit float implicitly only up to 15 significant digits: wrap the float in bignumber(…) to convert it explicitly, e.g. bignumber(random()) + 1.',
  literals: ['bignumber(…)', 'bignumber(random()) + 1'],
};

/**
 * math.js errors for a function with no BigNumber implementation for its
 * argument: `gamma` and `factorial` at a non-integer, and `lgamma` at any value.
 * Unanchored, so a callback error that `map` re-wrapped matches too.
 */
const NO_BIGNUMBER_IMPLEMENTATION =
  /Integer BigNumber expected|doesn't yet provide an implementation of the algorithm \w+ for BigNumber/;

/**
 * Recovery under numericType "BigNumber" for a call with no BigNumber
 * implementation — one of {@link NO_BIGNUMBER_IMPLEMENTATION}, a typed function
 * that takes a number but not a BigNumber (`erf`), or `zeta`, whose math.js
 * BigNumber implementation is refused as inaccurate ({@link BIGNUMBER_ZETA_ERROR}).
 * The same call computes under numericType "number", while the contract hints say
 * to fix the argument or a unit.
 */
const NO_BIGNUMBER_HINT: ThrowSiteHint = {
  text: 'A function in this expression has no BigNumber implementation for its argument (erf, lgamma, and zeta have none; gamma and factorial take only integers under BigNumber): retry with numericType "number", which computes it as a 64-bit float.',
};

/**
 * Recovery for `undefined_result` under numericType "BigNumber", whose contract
 * hint (retry with BigNumber for an overflow) names the mode already selected.
 */
const BIGNUMBER_UNDEFINED_HINT: ThrowSiteHint = {
  text: 'Division by zero, 0/0, and log(0) are undefined in every numericType, so fix the expression. Under numericType "BigNumber" an overflow has passed a decimal exponent of 9e15, so compute the logarithm of the value instead; an inverse trig or hyperbolic function outside its real domain (asin(2), acosh(0.5)) is NaN here, while numericType "number" returns its complex value.',
  literals: ['asin(2)', 'acosh(0.5)'],
};

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
  /** First `now()` / `today()` call found, if any (see {@link CLOCK_FUNCTIONS}). */
  clockCall: string | undefined;
  /** First `evaluate` / `simplify` / `derivative` call found, if any. */
  operationCall: string | undefined;
  /** First call to `roots` / `solve` the expression does not define, if any (see {@link routedCall}). */
  routedCall: string | undefined;
  /** The expression accesses `.toString` / `.toLocaleString` on some value. */
  stringifies: boolean;
  /** Names used as values rather than called — `min` in `5 min`, `x` in `x + 1`. */
  valueNames: Set<string>;
}

/**
 * Walk a freshly parsed tree once: flag stringifier access, operation-named
 * calls, clock calls, and `roots` / `solve` calls, collect the names used as
 * values, meter every value-building node against the element budget (so a node
 * in a loop body — a user-defined function or an inline `map` callback — is
 * charged on each iteration), keep the declared errors user-defined function
 * bodies raise (see {@link keepBodyFailure}), and rename synonym calls in place
 * to the function they stand for — `ln` → `log`, `arcsin` → `asin`, `avg` →
 * `mean`, `nCr` → `combinations`, `eig` → `eigs`, … (see function-names.ts).
 *
 * A name the expression defines as a function (`avg(v) = v * 10`, a recursive
 * `nCr(n) = …` callback) is the caller's own: calls to it are neither renamed nor
 * routed, anywhere in the expression. So is a parameter its body calls
 * (`f(nCr) = nCr(5, 2)` calls the argument), within that body only. Renames and
 * routes are applied once the walk has seen every definition, so a body that
 * calls a name defined after it keeps the caller's function too.
 *
 * The rename works on `FunctionNode`s whose callee is a `SymbolNode`, so string
 * literals (`"ln("` is a `ConstantNode`) and scope variables named `ln` (a bare
 * `SymbolNode`) are never touched, and nested calls are reached because the walk
 * covers every node. It is name-level rather than a `math.import` alias because
 * an imported alias is a separate function: symbolic `derivative` matches builtin
 * names, and an alias misses the canonical function's expression transform and
 * any later override on the instance. The tree is evaluated as-is afterwards,
 * never re-stringified: a Fraction-mode tree prints `0.1` as `1/10`.
 */
function inspectTree(tree: MathNode): TreeInspection {
  const inspection: TreeInspection = {
    stringifies: false,
    clockCall: undefined,
    operationCall: undefined,
    routedCall: undefined,
    valueNames: new Set(),
  };
  /** Names the expression defines as functions. */
  const defined = new Set<string>();
  /** Callees inside a function body that name one of its parameters: the argument, not a synonym. */
  const parameterCalls = new Set<MathNode>();
  /** Calls to a synonym or a solver name, in walk order; renamed or routed after the walk. */
  const namedCalls: SymbolNode[] = [];
  bodyFailure = undefined;
  tree.traverse((node, path) => {
    if (VALUE_BUILDING_NODES.has(node.type)) meterNode(node);
    if (node.type === 'FunctionAssignmentNode') {
      const { name, params, expr } = node as FunctionAssignmentNode;
      defined.add(name);
      keepBodyFailure(expr);
      expr.traverse((inner) => {
        if (inner.type !== 'FunctionNode') return;
        const { fn } = inner as FunctionNode;
        if (fn.type === 'SymbolNode' && params.includes((fn as SymbolNode).name)) {
          parameterCalls.add(fn);
        }
      });
    }
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
    const callee = (node as FunctionNode).fn;
    if (callee.type !== 'SymbolNode') return;
    const { name } = callee as SymbolNode;
    if (CLOCK_FUNCTIONS.has(name)) inspection.clockCall ??= name;
    if (OPERATION_FUNCTIONS.has(name)) {
      inspection.operationCall ??= name;
    } else if (canonicalName(name) !== undefined || isRoutedFunction(name)) {
      namedCalls.push(callee as SymbolNode);
    }
  });
  for (const callee of namedCalls) {
    if (defined.has(callee.name) || parameterCalls.has(callee)) continue;
    const canonical = canonicalName(callee.name);
    if (canonical !== undefined) callee.name = canonical;
    else inspection.routedCall ??= callee.name;
  }
  return inspection;
}

/**
 * The declared error a user-defined function's body raised during the current
 * evaluation, if any. math.js re-wraps an error thrown inside a typed callback
 * (`map`, `forEach`, `filter`, `mapSlices`, …) in a `TypeError` that keeps only
 * its message, losing the reason and recovery hint. In an expression, the typed
 * callbacks are the functions it defines (`f(v) = …`) and builtins passed by
 * name; this server's builtins raise no declared error as a callback (`integrate`
 * cannot be passed by name, the date functions throw plain errors).
 */
let bodyFailure: McpError | undefined;

/** Wrap a function body's `_compile` so a declared error it throws is kept in {@link bodyFailure}. */
function keepBodyFailure(body: MathNode): void {
  type CompiledNode = (...args: unknown[]) => unknown;
  const target = body as unknown as { _compile(math: unknown, argNames: unknown): CompiledNode };
  const compile = target._compile.bind(target);
  target._compile = (math, argNames) => {
    const evaluate = compile(math, argNames);
    return (...args: unknown[]) => {
      try {
        return evaluate(...args);
      } catch (err) {
        if (err instanceof McpError) bodyFailure = err;
        throw err;
      }
    };
  };
}

/** The declared error behind a failure a callback re-wrapped: its message ends the failure's. */
function bodyFailureIn(message: string): McpError | undefined {
  return bodyFailure && message.endsWith(bodyFailure.message) ? bodyFailure : undefined;
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
    scope?: Record<string, number>,
    precision?: number,
    numericType: NumericType = 'number',
  ): MathResult {
    this.validateInput(expression);
    if (scope) this.validateScope(scope);
    const inst = this.instanceFor(numericType);
    // Parse with the instance for the requested numericType: constant nodes take
    // their numeric type at parse time.
    const { tree, functionValues, clockCall } = this.parseExpression(expression, inst);
    if (clockCall !== undefined) throw clockUnavailable(clockCall);
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
        this.validateResultType(resultType);
        this.validateResultValue(raw, numericType);
        // Match JS Number.toString thresholds — math.js defaults to exp ≥ 5,
        // which would render 83810205 as "8.3810205e+7".
        const result = inst.format(raw, {
          lowerExp: -6,
          upperExp: 21,
          ...(precision != null && { precision }),
        });
        this.validateResultSize(result);
        return { result, resultType };
      },
      {
        operation: 'evaluate',
        numericType,
        // A scope value shadows the function of the same name.
        functionValues: functionValues.filter((name) => !(scope && Object.hasOwn(scope, name))),
      },
    );
  }

  /** Simplify an algebraic expression symbolically. */
  simplifyExpression(expression: string): MathResult {
    this.validateInput(expression);
    const { tree } = this.parseExpression(expression, this.defaultInstance);
    /**
     * Print the alias-normalized input before simplifying, to detect whether the
     * simplifier made any progress. String comparison of the raw input is not
     * sufficient — formatting-only changes like `x+1` vs `x + 1` should not count as
     * progress — so both sides are compared as math.js renders them. The print runs
     * in the timed call, which classifies a call-stack overflow in either step.
     */
    const { inputNormalized, result } = this.runWithTimeout(
      () => ({
        inputNormalized: tree.toString(),
        result: this.simplify(tree, this.simplifyRules).toString(),
      }),
      { operation: 'simplify' },
    );
    this.validateResultSize(result);
    return { result, resultType: 'string', unchanged: inputNormalized === result };
  }

  /** Compute the symbolic derivative of an expression with respect to a variable. */
  differentiateExpression(expression: string, variable: string): MathResult {
    this.validateInput(expression);
    const { tree } = this.parseExpression(expression, this.defaultInstance);
    const result = this.runWithTimeout(() => this.derivative(tree, variable).toString(), {
      operation: 'derivative',
      variable,
    });
    this.validateResultSize(result);
    return { result, resultType: 'string' };
  }

  /** Get formatted help content listing available functions, operators, and syntax. */
  getHelpContent(): string {
    return HELP_CONTENT;
  }

  private validateInput(expression: string): void {
    if (!expression.trim()) {
      throw declared('empty_expression', 'Expression cannot be empty.');
    }
    if (expression.length > this.config.maxExpressionLength) {
      throw declared(
        'expression_too_long',
        `Expression exceeds maximum length of ${this.config.maxExpressionLength} characters.`,
      );
    }
  }

  /**
   * Read the caller's `**`, `×`, `÷`, `−`, and `°` as math.js syntax (#47, see
   * {@link readNotation}), parse the read text once, and check the tree before
   * anything evaluates; a twin parse then holds each `×` and `**` to scalar operands
   * (see {@link guardScalarOperators}). A parse failure is `parse_failed`, its
   * `(char N)` naming the caller's position, and followed by the solver route when
   * the text calls `roots` or `solve` (#48). Input nested deeper than the call
   * stack fails with `expression_too_deep` at whichever step recurses past it —
   * the parse or a walk of the tree (#50). Multiple statements are detected structurally — math.js parses
   * `a; b` and a top-level newline into a `BlockNode` — so `;` inside a matrix or
   * inside either quote style (`"a;b"`, `'a;b'`) is data, transpose `A'` stays an
   * operator, and a real separator is rejected before either statement runs (#32).
   * math.js treats a bare carriage return as a syntax error rather than a
   * separator; when it is what broke the parse, the read text is re-parsed with line
   * feeds purely to report `multiple_expressions` — the rewritten text is never
   * evaluated. The same tree then gets the stringifier check, the
   * operation-as-function check (#27), the `roots` / `solve` check (#48), and the
   * synonym rename (#24, #42), and yields
   * the names it uses as values that resolve to functions (#38) and any clock call,
   * which only `evaluate` rejects (see {@link CLOCK_FUNCTIONS}). Every operation
   * starts here, so it also resets the instance's auto unit system (#37).
   */
  private parseExpression(
    expression: string,
    inst: MathInstance,
  ): { tree: MathNode; functionValues: string[]; clockCall: string | undefined } {
    inst.resetUnitSystem();
    const reading = readNotation(expression);
    let tree: MathNode;
    try {
      tree = this.parseText(reading.text, inst);
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (
        reading.text.includes('\r') &&
        this.parsesAsBlock(reading.text.replace(/\r\n?/g, '\n'), inst)
      ) {
        throw this.multipleExpressions();
      }
      const failure = parseErrorMessage(err, reading);
      if (callsRoutedFunction(expression)) throw routedCall(failure);
      throw declared('parse_failed', `Invalid expression: ${failure}`);
    }
    if (tree.type === 'BlockNode') throw this.multipleExpressions();

    const {
      stringifies,
      operationCall,
      routedCall: routed,
      valueNames,
      clockCall,
    } = withinStack(() => inspectTree(tree));
    // `.toString()` / `.toLocaleString()` on a function-valued identifier
    // (`cos.toString()`) returns the function's source as a plain string, slipping
    // past validateResultType, which only sees the value after stringification. No
    // calculator expression needs either method, so the accessor is rejected on any
    // operand; a string literal containing "toString" is a ConstantNode, not an
    // accessor, and is unaffected.
    if (stringifies) {
      throw declared(
        'disallowed_result_type',
        'Converting a function to a string is not allowed — it would expose internal source.',
      );
    }
    if (operationCall !== undefined) throw operationAsFunction(operationCall);
    if (routed !== undefined) throw routedCall(`Undefined function ${routed}`);
    withinStack(() =>
      guardScalarOperators(tree, reading.twin, (twin) => this.parseText(twin, inst)),
    );
    return { tree, functionValues: [...valueNames].filter(inst.isFunction), clockCall };
  }

  /** Whether `expression` parses to multiple statements. */
  private parsesAsBlock(expression: string, inst: MathInstance): boolean {
    try {
      return this.parseText(expression, inst).type === 'BlockNode';
    } catch {
      return false;
    }
  }

  /**
   * Parse text with the instance's parser. Every parse an operation makes goes
   * through here: the read expression, its `×` / `**` twin, and the line-feed
   * re-parse. The parser recurses once per nesting level, so input nested past
   * the call stack fails with `expression_too_deep`.
   */
  private parseText(text: string, inst: MathInstance): MathNode {
    return withinStack(() => inst.parse(text));
  }

  private multipleExpressions(): McpError {
    return declared(
      'multiple_expressions',
      'Multiple expressions are not allowed. Submit one expression per call.',
    );
  }

  /** Reject scope keys that could pollute the object prototype chain. */
  private validateScope(scope: Record<string, number>): void {
    for (const key of Object.keys(scope)) {
      if (BLOCKED_SCOPE_KEYS.has(key)) {
        throw declared(
          'reserved_scope_key',
          `Scope key "${key}" is not allowed — it conflicts with a reserved property name.`,
        );
      }
    }
  }

  /** Reject result types that leak internals (functions, parsers, multi-expression ResultSets). */
  private validateResultType(resultType: string): void {
    if (BLOCKED_RESULT_TYPES.has(resultType)) {
      throw declared(
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
  private validateResultValue(raw: unknown, numericType: NumericType): void {
    const { maxResultLength } = this.config;
    if (typeof raw === 'string' && raw.length > maxResultLength) {
      throw this.resultTooLarge();
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
        'disallowed_result_type',
        'help() is not available inside expressions — read the calculator://help resource for the function reference.',
      );
    }
    if (scan.elements > elementLimit) throw this.resultTooLarge();
    if (scan.nonFinite) throw undefinedResult(numericType);
    if (scan.inexact) throw declared('fraction_unsupported', FRACTION_FLOAT_MESSAGE);
  }

  /** Reject results that exceed the configured maximum size. */
  private validateResultSize(result: string): void {
    if (result.length > this.config.maxResultLength) throw this.resultTooLarge();
  }

  private resultTooLarge(): McpError {
    return declared(
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
  private runWithTimeout<T>(fn: () => T, stage: FailureStage): T {
    const { sandbox } = this;
    sandbox.fn = fn;
    beginEvaluation();
    try {
      TIMED_CALL.runInContext(sandbox, { timeout: this.config.evaluationTimeoutMs });
      return sandbox.result as T;
    } catch (err) {
      throw this.classifyFailure(err, stage);
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
   * 2. Timeout → `evaluation_timeout`; an exhausted call stack →
   *    `expression_too_deep` (#50).
   * 3. A size guard (see size-guard.ts) → `result_too_large`; a declared error a
   *    user-defined function's body raised (a `×` or `**` operand error among
   *    them, notation.ts, #47), re-wrapped by the callback it ran in → that error,
   *    hint included (see {@link bodyFailure}).
   * 4. Fraction mode calling a function with no Fraction implementation (sin,
   *    log, stirlingS2, …) → `fraction_unsupported` (#19); so does an exact
   *    Fraction function whose result is irrational or complex (`sqrt(2)`,
   *    `(1/2)!`, see fraction-exact.ts, #49), and Fraction mode meeting a float
   *    with no equal Fraction (`pi * 2/3`, #35).
   * 5. fraction.js `Division by Zero`, in any numericType, or an exact Fraction
   *    function at a pole (`gamma(0)`) → `undefined_result` (#21, #49).
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
   *
   * In 8 and 9, a float BigNumber will not take implicitly, and under numericType
   * "BigNumber" a call with no BigNumber implementation, carry a hint written here
   * (see {@link recoveryHint}); so does `undefined_result` under "BigNumber".
   */
  private classifyFailure(err: unknown, stage: FailureStage): McpError {
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
        { reason: 'evaluation_timeout' },
      );
    }
    if (isStackOverflow(err)) return tooDeep();
    const limitError = sizeLimitErrorIn(err);
    if (limitError) {
      return declared('result_too_large', `Size limit exceeded: ${limitError.message}`);
    }
    const carried = bodyFailureIn(message);
    if (carried) return carried;
    // Only the Fraction instance carries the exact Fraction functions.
    const fractionFailure = numericType === 'Fraction' ? fractionFailureIn(err) : undefined;
    if (
      fractionFailure === 'fraction_unsupported' ||
      (numericType === 'Fraction' && FRACTION_CONVERSION_ERROR.test(message))
    ) {
      return declared('fraction_unsupported', FRACTION_FUNCTION_MESSAGE);
    }
    if (numericType === 'Fraction' && FLOAT_TO_FRACTION_ERROR.test(message)) {
      return declared('fraction_unsupported', FRACTION_FLOAT_MESSAGE);
    }
    if (fractionFailure === 'undefined_result' || FRACTION_DIVISION_BY_ZERO.test(message)) {
      return undefinedResult(numericType);
    }
    if (NAME_ERROR.test(message)) {
      return declared('parse_failed', `Invalid expression: ${message}`);
    }
    if (stage.operation !== 'evaluate') return symbolicFailure(stage, message);
    const data = (err as { data?: TypedErrorData } | null)?.data;
    const category = data?.category;
    if (
      category === 'wrongType' &&
      Array.isArray(data?.actual) &&
      data.actual.includes('function')
    ) {
      return functionAsValue(stage.functionValues, message);
    }
    const hint = recoveryHint(message, data, stage.numericType);
    if (category === 'wrongType' || TYPE_MISMATCH_ERROR.test(message)) {
      return declared('type_mismatch', `Type mismatch: ${message}`, hint);
    }
    return declared('evaluation_failed', `Evaluation failed: ${message}`, hint);
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
  const units = names.flatMap((name) => {
    const unit = FUNCTION_SHADOWED_UNITS[name];
    return unit ? [{ name, unit }] : [];
  });
  return validationError(
    `Type mismatch: a function was used as a value${described.length ? ` (${described.join('; ')})` : ''}. ${detail}`,
    {
      reason: 'type_mismatch',
      recovery: {
        hint: [
          ...units.map(
            ({ name, unit }) =>
              `"${name}" names a function here; for the unit, write ${unit} (5 ${unit}).`,
          ),
          'To call a function, use parentheses (sin(1), f(3)); a function name or definition next to a value multiplies it instead.',
        ].join(' '),
      },
    },
    { literals: [...units.map(({ unit }) => `5 ${unit}`), 'sin(1)', 'f(3)'] },
  );
}

/**
 * `operation_as_function` for a call to `evaluate`, `simplify`, or `derivative`
 * inside an expression. The hint is written here, naming the operation, and the
 * message repeats it, so `content[]` shows it once (#27).
 */
function operationAsFunction(operation: string): McpError {
  const setting = `operation: "${operation}"`;
  const hint =
    operation === 'derivative'
      ? `Send its first argument as expression and its second as variable, with ${setting}.`
      : `Send its argument as expression, with ${setting}.`;
  return validationError(
    `"${operation}" is an operation, not a function available inside expressions. ${hint}`,
    { reason: 'operation_as_function', recovery: { hint } },
    { literals: ['expression', 'variable', setting] },
  );
}

/**
 * `parse_failed` for a clock call under `evaluate`. The contract hint is about names
 * and scope, which a clock call cannot be fixed with, so the hint is written here.
 */
function clockUnavailable(name: string): McpError {
  return validationError(`${name}() is not available: the calculator reads no clock.`, {
    reason: 'parse_failed',
    recovery: {
      hint: `Pass the current date as a quoted YYYY-MM-DD string where ${name}() would go, e.g. dateDiff("2026-10-17", "2026-12-25").`,
    },
  });
}

/** The `data` a math.js typed-function error carries (`wrongType` and its kin). */
interface TypedErrorData {
  actual?: unknown;
  category?: unknown;
  expected?: unknown;
}

/**
 * The hint a failure gets in place of its contract hint, where that one points
 * the wrong way: a float BigNumber will not take implicitly, in any numericType,
 * and under numericType "BigNumber" a call with no BigNumber implementation —
 * a {@link NO_BIGNUMBER_IMPLEMENTATION} or {@link BIGNUMBER_ZETA_ERROR} message
 * (also re-wrapped by a callback), or a typed function that wanted a number where
 * it got a BigNumber (`erf`). A `wrongType` that expected neither, such as a unit
 * (`5 kg + 3`), keeps the contract hint.
 */
function recoveryHint(
  message: string,
  data: TypedErrorData | undefined,
  numericType: NumericType,
): ThrowSiteHint | undefined {
  if (FLOAT_TO_BIGNUMBER_ERROR.test(message)) return FLOAT_TO_BIGNUMBER_HINT;
  if (numericType !== 'BigNumber') return undefined;
  const lists = (value: unknown, type: string) => Array.isArray(value) && value.includes(type);
  // wrongType's `expected` lists only types the argument is not, so never BigNumber here.
  const wantsNumber =
    data?.category === 'wrongType' &&
    lists(data.actual, 'BigNumber') &&
    lists(data.expected, 'number');
  const unimplemented =
    NO_BIGNUMBER_IMPLEMENTATION.test(message) || message.includes(BIGNUMBER_ZETA_ERROR);
  return wantsNumber || unimplemented ? NO_BIGNUMBER_HINT : undefined;
}

/** `undefined_result` for a non-finite value, with {@link BIGNUMBER_UNDEFINED_HINT} under "BigNumber". */
function undefinedResult(numericType: NumericType | undefined): McpError {
  return declared(
    'undefined_result',
    UNDEFINED_RESULT_MESSAGE,
    numericType === 'BigNumber' ? BIGNUMBER_UNDEFINED_HINT : undefined,
  );
}

/**
 * Code the tool's contract hints quote, by reason; the contract builds its hint
 * text from these. A throw that leaves the hint to the contract declares them as
 * literals, so `content[]` renders them as code rather than escaped text.
 */
export const CONTRACT_HINT_CODE = {
  type_mismatch: ['5 kg + 3 kg', 'number(5 kg, "kg") + 3'],
  expression_too_deep: ['sum([…])', 'prod([…])'],
} as const;

/** A recovery hint written at the throw site, in place of the contract's, and the code it quotes. */
interface ThrowSiteHint {
  /** Rendered as code spans in `content[]`; `structuredContent` carries `text` as written. */
  readonly literals?: readonly string[];
  readonly text: string;
}

/**
 * A validation error carrying `reason`. Without a `hint`, the framework fills the
 * recovery hint the tool's contract entry declares for that reason on the way to
 * the client, and the code that hint quotes is declared as literals; a `hint`
 * replaces it, with its own literals.
 */
function declared(reason: string, message: string, hint?: ThrowSiteHint): McpError {
  const code: Readonly<Record<string, readonly string[]>> = CONTRACT_HINT_CODE;
  const contractCode = Object.hasOwn(code, reason) ? code[reason] : undefined;
  const literals = hint ? hint.literals : contractCode;
  return validationError(
    message,
    { reason, ...(hint && { recovery: { hint: hint.text } }) },
    literals && { literals },
  );
}

/** `expression_too_deep`: a step recursing over the expression exhausted the call stack. */
function tooDeep(): McpError {
  return declared(
    'expression_too_deep',
    'Expression is nested too deeply: working through it exhausted the call stack.',
  );
}

/**
 * Run a step outside the timed call that recurses over the expression or its
 * tree — parsing or walking it — and fail with `expression_too_deep` if it
 * exhausts the call stack.
 */
function withinStack<T>(step: () => T): T {
  try {
    return step();
  } catch (err) {
    if (isStackOverflow(err)) throw tooDeep();
    throw err;
  }
}

/**
 * Whether `err` is the call stack running out: the engine's `RangeError`, or the
 * `TypeError` a math.js callback re-wraps it in. The type is checked as well as
 * the message, since a decimal.js error ends with the caller's string
 * (`bignumber("Maximum call stack size exceeded")`).
 */
function isStackOverflow(err: unknown): boolean {
  if (err instanceof RangeError) return STACK_OVERFLOW.test(err.message);
  return err instanceof TypeError && REWRAPPED_STACK_OVERFLOW.test(err.message);
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
