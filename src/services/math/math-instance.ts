/**
 * @fileoverview Builds one hardened math.js instance per numeric type: custom
 * units, Fraction literal reading, size guards, the date and integrate
 * functions, a `zeta` that refuses BigNumber arguments, a read-only `config`, and
 * the disabled functions and redacted constants. {@link MathService} holds one
 * instance per numericType.
 * @module services/math/math-instance
 */

import {
  all,
  type BigNumber,
  create,
  type Fraction,
  factory,
  isBigNumber,
  isCollection,
  isFraction,
  type MathNode,
  type SimplifyRule,
  type UnitDefinition,
} from 'mathjs';
import { createDateFunctions } from './date-functions.js';
import { installFractionExact } from './fraction-exact.js';
import { installFunctionNames } from './function-names.js';
import { createIntegrate } from './integrate.js';
import { installSizeGuards } from './size-guard.js';
import type { NumericType } from './types.js';

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

/** Bundled references extracted from a single math.js instance. */
export interface MathInstance {
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
  /** A scope value in this instance's numeric type, read as the literal of its shortest round-trip decimal. */
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
 * Read a Fraction-mode scope value the way the same literal is read: from the
 * float's shortest round-trip decimal (`String(value)`), exponent notation
 * expanded, so `{"x": 0.1}` is 1/10 and `{"x": 1e23}` is 10^23 rather than the
 * float's binary value, 99999999999999991611392. Every finite float has one, so
 * every scope value is an exact Fraction.
 */
function fractionScopeValue(fraction: (decimal: string) => Fraction): (value: number) => Fraction {
  return (value) => {
    const decimal = String(value);
    const sign = decimal.startsWith('-') ? '-' : '';
    const magnitude = decimal.slice(sign.length);
    return fraction(sign + (expandExponentLiteral(magnitude) ?? magnitude));
  };
}

/**
 * How an instance reads scope values. BigNumber uses the constructor, the
 * conversion math.js applies implicitly to a number, minus its refusal past 15
 * significant digits: it reads the same shortest round-trip decimal and keeps
 * `-0`, which `math.bignumber()` turns into 0. Number mode passes values through.
 */
function scopeValueReader(
  math: ReturnType<typeof create>,
  number: NumericType,
): (value: number) => unknown {
  switch (number) {
    case 'BigNumber': {
      const Decimal = (math as unknown as { BigNumber: new (value: number) => BigNumber })
        .BigNumber;
      return (value) => new Decimal(value);
    }
    case 'Fraction':
      return fractionScopeValue(math.fraction.bind(math));
    case 'number':
      return (value) => value;
  }
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

/**
 * `args` with the dimension of a `(collection, dimension, normalization)` call
 * moved to zero-based: a number or BigNumber, or a whole-number Fraction, which
 * the instance's dimension guard then reads as a number. Any other call is
 * returned unchanged.
 */
function zeroBasedNormalizedDimension(args: unknown[]): unknown[] {
  const [collection, dimension, normalization] = args;
  if (args.length !== 3 || !isCollection(collection) || typeof normalization !== 'string') {
    return args;
  }
  if (typeof dimension === 'number') return [collection, dimension - 1, normalization];
  if (isBigNumber(dimension)) return [collection, dimension.minus(1), normalization];
  if (isFraction(dimension) && Number(dimension.d) === 1) {
    return [collection, dimension.sub(1), normalization];
  }
  return args;
}

/**
 * Read the dimension of `std(A, dim, normalization)` and `variance(A, dim,
 * normalization)` one-based, as every other expression dimension is: math.js's
 * transforms move a dimension to zero-based only in the two-argument form
 * (josdejong/mathjs#3779), so `std([1, 2; 3, 4], 1, "uncorrected")` reduced the
 * second axis. Each transform is wrapped to move that dimension first; the
 * transform still reports an out-of-range dimension one-based. The wrapped
 * transform resolves lazily, through the getter math.js installed for it. Must
 * run after installSizeGuards, which rebuilds these transforms on a Fraction
 * instance.
 */
function installNormalizedDimensions(
  math: ReturnType<typeof create>,
  mathImport: ReturnType<typeof create>['import'],
): void {
  const transforms = (math as unknown as { expression: { transform: Record<string, unknown> } })
    .expression.transform;
  const wrapped = ['std', 'variance'].map((name) => {
    const resolve = Object.getOwnPropertyDescriptor(transforms, name)?.get?.bind(transforms);
    if (!resolve) throw new Error(`No lazy math.js "${name}" transform to wrap.`);
    // Importing over an existing transform deletes it rather than replacing it.
    delete transforms[name];
    return factory(
      name,
      ['typed'],
      ({ typed }: { typed: ReturnType<typeof create>['typed'] }) =>
        typed(name, {
          '...any': (args: unknown[]) =>
            (resolve() as (...values: unknown[]) => unknown)(...zeroBasedNormalizedDimension(args)),
        }),
      { isTransformFunction: true },
    );
  });
  mathImport(wrapped as never, { override: true });
}

/**
 * What a BigNumber argument to `zeta` fails with. math.js sums `zeta`'s series to a
 * length set by `relTol` (12 terms at the default 1e-12), so its BigNumber result is
 * correct to about 7 of the 64 significant digits it returns: `zeta(2)` gives
 * 1.6449340873…, where π²/6 is 1.6449340668…. MathService routes the failure to
 * numericType "number".
 */
export const BIGNUMBER_ZETA_ERROR =
  "zeta has no BigNumber implementation: math.js's BigNumber zeta is correct to about 7 significant digits, not 64";

/**
 * Make `zeta` fail on a BigNumber argument (see {@link BIGNUMBER_ZETA_ERROR}). Its
 * other signatures are kept as they are, so a number or Complex argument computes
 * as before and a Fraction argument meets the same conversions.
 */
function refuseBigNumberZeta(
  math: ReturnType<typeof create>,
  mathImport: ReturnType<typeof create>['import'],
): void {
  type Impl = (...args: never[]) => unknown;
  type Typed = (name: string, signatures: Record<string, Impl>) => unknown;
  const { signatures } = math.zeta as unknown as { signatures: Record<string, Impl> };
  const typed = math.typed as unknown as Typed;
  const zeta = typed('zeta', {
    ...signatures,
    BigNumber: () => {
      throw new Error(BIGNUMBER_ZETA_ERROR);
    },
  });
  mathImport({ zeta }, { override: true });
}

/** Create and harden a math.js instance with the given numeric type. */
export function createMathInstance(number: 'number' | 'BigNumber' | 'Fraction'): MathInstance {
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
  const scopeValue = scopeValueReader(math, number);

  // Read the config before the override (an empty options object changes nothing).
  // math.js injects `config` into every factory it instantiates lazily, and reads it
  // both as a call (config()) and as properties (config.relTol, config.precision). A
  // throwing stub breaks those readers — BigNumber arithmetic fails with
  // `[DecimalError] precision: NaN`, and number-mode functions created after the
  // override (eigs, schur, intersect, isPositive, compare, …) see `relTol`/`absTol` as
  // undefined (#25). Every instance therefore gets a read-only guard (installed
  // below): reads pass through, writes throw.
  const currentConfig = math.config({}) as Record<string, unknown>;

  // Must run before createUnit is disabled below.
  const resetUnitSystem = registerCustomUnits(math);

  // Bound what an expression can build from a size argument, a product, a broadcast,
  // a repeated input, an index, or a formatting precision. Installed on the instance,
  // so simplify/derivative constant folding on this instance hits the same limits.
  installSizeGuards(math, mathImport, all as unknown as Record<string, unknown>);

  // Exact Fraction results for integer combinatorics and rational roots. After the size
  // guards, so the functions it extends keep theirs; nthRoot, which it rebuilds, is
  // guarded again (guardBroadcasting).
  if (number === 'Fraction') installFractionExact(math, mathImport);

  // Date functions and the numeric integrator. Their names are new to math.js, so the
  // import merges nothing and clears no transform, and none needs a size guard: the
  // date functions build no collections, and `integrate` compiles its integrand when
  // called — against this namespace, guards included, with the parse-time metering
  // still on the integrand's nodes. So either side of installSizeGuards works.
  mathImport({ ...createDateFunctions(math.typed), integrate: createIntegrate(number) });

  // Value bindings for the statistics and combinatorics synonyms, and `eigenvalues`;
  // a synonym call is renamed on the parse tree instead (see inspectTree).
  installFunctionNames(mathImport);

  // After installSizeGuards, which rebuilds these transforms on a Fraction instance.
  installNormalizedDimensions(math, mathImport);

  // On every instance: a bignumber() argument reaches the BigNumber signature in any mode.
  refuseBigNumberZeta(math, mathImport);

  // Replace `config` with a read-only guard. Two access patterns must be preserved
  // for math.js internals:
  //   1. config()          — gamma/factorial call this to read the full config object
  //   2. config.precision  — gamma accesses precision directly as a property on the
  //      function; eigs, intersect, compare, … read config.relTol / config.absTol
  //
  // Replacing config with a plain stub breaks both; the guard function below satisfies
  // both patterns while blocking write access (calls with a non-empty options object).
  // A bare `config()` from an expression therefore returns the config object — a fresh
  // copy each call, as stock math.js does: the instance outlives the request, and an
  // expression can assign into a plain object it holds (`c.k = …` after `c = config()`).
  const configGuard = Object.assign(
    (options?: Record<string, unknown>) => {
      if (options !== undefined && Object.keys(options).length > 0) {
        throw new Error('"config" is disabled for security.');
      }
      return { ...currentConfig };
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
