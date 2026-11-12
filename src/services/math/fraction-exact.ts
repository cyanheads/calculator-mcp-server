/**
 * @fileoverview Exact results for numericType "Fraction" where math.js has no
 * Fraction implementation but the answer is rational: integer combinatorics
 * (`factorial` / `!`, `gamma` at positive integers, `permutations`,
 * `combinations`, `catalan`, `composition`, `multinomial`) and rational roots
 * (`sqrt`, `cbrt`, `nthRoot`, `^` with a non-integer exponent, and `sqrtm`).
 * `^` with an integer exponent replaces math.js's own so that its result is
 * size-checked like the rest.
 *
 * Combinatorics run in BigInt over a balanced product tree. Before computing, a
 * call estimates its result's decimal digits and checks them against
 * `MAX_STRING_LENGTH`, charged to the evaluation budget (see `assertDigits` in
 * size-guard.ts) — except an integer power, which is checked only (see `pow`).
 * Roots take an integer root of numerator and denominator with an exact check,
 * and powers raise each separately. A call with no Fraction result throws
 * {@link FractionResultError} — never a 64-bit float stand-in, which can round to
 * a value that reads as exact; invalid arguments throw the errors number mode
 * throws for them.
 * @module services/math/fraction-exact
 */

import {
  all,
  type Complex,
  type FactoryFunctionMap,
  type Fraction,
  isFraction,
  isMatrix,
  type MathArray,
  type MathJsInstance,
  type Matrix,
} from 'mathjs';
import { assertDigits, guardBroadcasting, MAX_STRING_LENGTH } from './size-guard.js';

/** The declared failure reason for a Fraction-mode call that has no Fraction result. */
export type FractionFailure = 'fraction_unsupported' | 'undefined_result';

/** Message prefixes that identify each failure, also inside a math.js error that re-wraps the message. */
const FAILURE_PREFIX: Record<FractionFailure, string> = {
  fraction_unsupported: 'No exact Fraction result: ',
  undefined_result: 'Undefined Fraction result: ',
};

/**
 * Thrown when an exact Fraction function's result is not a Fraction: irrational
 * or complex (`fraction_unsupported`), or not defined at all, at a pole of
 * `gamma` or a zero root with a negative degree (`undefined_result`).
 */
export class FractionResultError extends Error {
  constructor(
    readonly reason: FractionFailure,
    detail: string,
  ) {
    super(`${FAILURE_PREFIX[reason]}${detail}`);
    this.name = 'FractionResultError';
  }
}

/**
 * The reason behind a failure raised by an exact Fraction function: from the
 * error itself, or from the message of a math.js error that re-wrapped it —
 * `map`, `forEach`, and `filter` rethrow a callback's error as a new error whose
 * message embeds the original.
 */
export function fractionFailureIn(err: unknown): FractionFailure | undefined {
  if (err instanceof FractionResultError) return err.reason;
  const message = err instanceof Error ? err.message : String(err);
  for (const [reason, prefix] of Object.entries(FAILURE_PREFIX)) {
    if (message.includes(prefix)) return reason as FractionFailure;
  }
  return undefined;
}

// --- BigInt arithmetic ---

/** Product of the integers `lo`..`hi` (1 when `lo > hi`), split in halves so the multiplications stay balanced. */
function productRange(lo: bigint, hi: bigint): bigint {
  if (hi - lo < 32n) {
    let product = 1n;
    for (let i = lo; i <= hi; i++) product *= i;
    return product;
  }
  const mid = (lo + hi) >> 1n;
  return productRange(lo, mid) * productRange(mid + 1n, hi);
}

/** Bits in a positive bigint. */
function bitLength(n: bigint): number {
  const hex = n.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(Number.parseInt(hex[0] as string, 16)));
}

/** Base-2 logarithm of a positive bigint, as a float. */
function log2(n: bigint, bits: number): number {
  if (bits <= 1000) return Math.log2(Number(n));
  const shift = bits - 64;
  return shift + Math.log2(Number(n >> BigInt(shift)));
}

/**
 * Relative margin added to the float estimate of a root so it starts above the
 * true root. It exceeds the estimate's error for every bigint size: the error of
 * `log2` grows with the bit count, which BigInt caps near 2^30.
 */
const ROOT_ESTIMATE_MARGIN = 2 ** -20;

/** An integer at or above the `degree`-th root of `n`, from a float estimate. */
function rootUpperBound(n: bigint, degree: number, bits: number): bigint {
  const exponent = log2(n, bits) / degree;
  if (exponent < 50) return BigInt(Math.ceil(2 ** exponent * (1 + ROOT_ESTIMATE_MARGIN))) + 1n;
  const shift = Math.floor(exponent) - 50;
  const top = Math.ceil(2 ** (exponent - shift) * (1 + ROOT_ESTIMATE_MARGIN)) + 1;
  return BigInt(top) << BigInt(shift);
}

/**
 * The `degree`-th root of `n ≥ 0` when it is an integer, else `undefined`. Integer
 * Newton iteration descends from an upper bound to the floor of the root, which
 * is then checked exactly.
 */
function exactIntegerRoot(n: bigint, degree: bigint): bigint | undefined {
  if (n < 2n || degree === 1n) return n;
  const bits = bitLength(n);
  // 2^bits > n ≥ 2, so a degree of at least `bits` puts the root strictly between 1 and 2.
  if (degree >= BigInt(bits)) return undefined;
  const k = Number(degree);
  const lower = degree - 1n;
  let x = rootUpperBound(n, k, bits);
  for (;;) {
    const next = (lower * x + n / x ** lower) / degree;
    if (next >= x) break;
    x = next;
  }
  return x ** degree === n ? x : undefined;
}

// --- Gaussian integers ---

/** A complex number with integer parts, as `[re, im]`. */
type Gaussian = readonly [re: bigint, im: bigint];

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Largest exponent at which a power of a Gaussian integer other than 0 and the
 * units ±1, ±i can keep safe-integer parts: its modulus is at least √2, so its
 * k-th power has a part of at least 2^((k − 1)/2), past 2^53 from k = 108.
 */
const MAX_GAUSSIAN_EXPONENT = 107n;

/** A Complex's parts when both are safe integers, the only Complex values a 64-bit float pair holds exactly as integers. */
function gaussianOf(z: Complex): Gaussian | undefined {
  if (!Number.isSafeInteger(z.re) || !Number.isSafeInteger(z.im)) return undefined;
  return [BigInt(z.re), BigInt(z.im)];
}

/**
 * `z ^ k` for an integer `k` when it is a Gaussian integer with safe-integer parts,
 * else `undefined`. A unit's powers cycle with period 4; any other non-zero base
 * has no Gaussian-integer inverse and passes the safe range after
 * {@link MAX_GAUSSIAN_EXPONENT}; a zero base takes only positive exponents.
 */
function gaussianPower(z: Gaussian, k: bigint): Gaussian | undefined {
  const [a, b] = z;
  if (a === 0n && b === 0n) return k > 0n ? z : undefined;
  let exponent = k;
  if (a * a + b * b === 1n) exponent = ((k % 4n) + 4n) % 4n;
  else if (k < 0n || k > MAX_GAUSSIAN_EXPONENT) return undefined;
  let re = 1n;
  let im = 0n;
  for (let i = 0n; i < exponent; i++) [re, im] = [re * a - im * b, re * b + im * a];
  const safe = (part: bigint) => part <= MAX_SAFE && part >= -MAX_SAFE;
  return safe(re) && safe(im) ? [re, im] : undefined;
}

/**
 * The `degree`-th root of the Gaussian integer `exact` that a float `approximation`
 * stands for, when that root is a Gaussian integer, else `undefined`: the nearest
 * Gaussian integer, kept only when its power is `exact` again. A Gaussian root lies
 * well within rounding distance of its float approximation, and any other lattice
 * point fails the check, so the root kept is the one math.js approximated.
 */
function rootNear(approximation: Complex, exact: Gaussian, degree: bigint): Gaussian | undefined {
  const candidate: Gaussian = [
    BigInt(Math.round(approximation.re)),
    BigInt(Math.round(approximation.im)),
  ];
  const power = gaussianPower(candidate, degree);
  return power && power[0] === exact[0] && power[1] === exact[1] ? candidate : undefined;
}

// --- Digit estimates ---

/** Below this, `log10Factorial` sums logarithms term by term; above, the Stirling series is exact to well under 1e-6 digits. */
const STIRLING_FROM = 20;

/**
 * Largest `n` whose binomial digit count is taken as a difference of Stirling
 * values: below it the difference stays accurate to a hundredth of a digit.
 */
const STIRLING_DIFFERENCE_LIMIT = 2n ** 40n;

/**
 * Most terms a binomial digit count sums one by one. A binomial C(n, k) with
 * n ≥ {@link STIRLING_DIFFERENCE_LIMIT} and min(k, n − k) past this is at least
 * (n/k)^k, more than `MAX_STRING_LENGTH` digits, so that lower bound stands in.
 */
const BINOMIAL_SUM_TERMS = 200_000n;

/** log10 of a positive bigint. */
function log10Big(n: bigint): number {
  return log2(n, bitLength(n)) * Math.LN2 * Math.LOG10E;
}

/** log10(n!) for `n ≥ 0`; Infinity once `n` passes the float range. */
function log10Factorial(n: number): number {
  if (n < STIRLING_FROM) {
    let sum = 0;
    for (let i = 2; i <= n; i++) sum += Math.log10(i);
    return sum;
  }
  return (n * (Math.log(n) - 1) + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n)) / Math.LN10;
}

/** log10 of C(n, k) for `0 ≤ k ≤ n − k`. */
function log10Binomial(n: bigint, k: bigint): number {
  if (n < STIRLING_DIFFERENCE_LIMIT) {
    const [nf, kf] = [Number(n), Number(k)];
    return log10Factorial(nf) - log10Factorial(kf) - log10Factorial(nf - kf);
  }
  if (k > BINOMIAL_SUM_TERMS) return Number(k) * (log10Big(n) - log10Big(k));
  const [nf, terms] = [Number(n), Number(k)];
  // Past the float range every term n − k + i reads as n.
  if (!Number.isFinite(nf)) return terms * log10Big(n) - log10Factorial(terms);
  let sum = 0;
  for (let i = 1; i <= terms; i++) sum += Math.log10((nf - terms + i) / i);
  return sum;
}

/** Fail `fn` before computing when its result of 10^`log10` would pass the digit limit; charge its digits otherwise. */
function assertResultSize(fn: string, log10: number): void {
  assertDigits(fn, Math.floor(log10) + 1);
}

/** Decimal digits of `n ^ exponent` for positive bigints; Infinity once `exponent` passes the float range. */
function powerDigits(n: bigint, exponent: bigint): number {
  if (n === 1n) return 1;
  return Math.floor(Number(exponent) * log10Big(n)) + 1;
}

// --- Combinatorics ---

/** A whole, non-negative Fraction's numerator; `undefined` for anything else. */
function naturalOf(value: Fraction): bigint | undefined {
  return value.d === 1n && value.s > 0n ? value.n : undefined;
}

/** `n!`, checked against the digit limit as a call to `fn`. */
function factorialBig(fn: string, n: bigint): bigint {
  assertResultSize(fn, log10Factorial(Number(n)));
  return productRange(2n, n);
}

/** min(k, n − k) for `k ≤ n`: the side of C(n, k) its products run over. */
function smallerSide(n: bigint, k: bigint): bigint {
  const rest = n - k;
  if (rest < k) return rest;
  return k;
}

/** C(n, k) for `k ≤ n`, checked against the digit limit as a call to `fn`. */
function binomialBig(fn: string, n: bigint, k: bigint): bigint {
  const small = smallerSide(n, k);
  assertResultSize(fn, log10Binomial(n, small));
  return productRange(n - small + 1n, n) / productRange(2n, small);
}

// --- Installation ---

type Impl = (...args: never[]) => unknown;
interface TypedFunction {
  signatures: Record<string, Impl>;
  (...args: unknown[]): unknown;
}
type Typed = (name: string, signatures: Record<string, Impl>) => TypedFunction;
interface FractionClass {
  readonly prototype: Fraction;
  new (numerator: bigint, denominator?: bigint): Fraction;
}

/**
 * Install the exact Fraction functions on a Fraction instance. Each function
 * keeps every signature it has and gains Fraction ones (`pow` replaces its
 * `Fraction, Fraction` signature), so it must run after the size guards are
 * installed — `nthRoot`, rebuilt instead (see {@link rebuiltNthRoot}), is guarded
 * again — and before `import` is disabled; `mathImport` is the captured original.
 */
export function installFractionExact(
  math: MathJsInstance,
  mathImport: MathJsInstance['import'],
): void {
  const namespace = math as unknown as Record<string, TypedFunction>;
  const typed = math.typed as unknown as Typed;
  const FractionType = (namespace as unknown as { Fraction: FractionClass }).Fraction;
  const whole = (n: bigint) => new FractionType(n);
  const extend = (name: string, signatures: Record<string, Impl>) =>
    typed(name, { ...(namespace[name] as TypedFunction).signatures, ...signatures });
  const irrational = (call: string) =>
    new FractionResultError('fraction_unsupported', `${call} is irrational.`);
  /**
   * A Fraction from a sign and a numerator and denominator already in lowest terms,
   * built the way fraction.js builds its own results. It skips the reduction the
   * constructor runs — Euclid's algorithm over BigInt, quadratic in the parts' size
   * and the slowest step of a large power by far.
   */
  const reduced = (s: bigint, n: bigint, d: bigint): Fraction =>
    Object.assign(Object.create(FractionType.prototype) as Fraction, { s, n, d });
  /**
   * The real `degree`-th root of a Fraction, with its sign (callers pass a negative
   * `x` only with an odd degree), or `undefined` when it is irrational. Roots of
   * coprime parts are coprime.
   */
  const exactRoot = (x: Fraction, degree: bigint): Fraction | undefined => {
    const n = exactIntegerRoot(x.n, degree);
    const d = n === undefined ? undefined : exactIntegerRoot(x.d, degree);
    return n === undefined || d === undefined ? undefined : reduced(x.s, n, d);
  };
  /**
   * `base ^ exponent` for a non-zero Fraction and an integer exponent, its numerator
   * and denominator digits together checked against the digit limit as a call to
   * `fn` — and, when `charged`, charged to the evaluation budget as the other exact
   * functions' are. Each part is raised on its own; powers of coprime parts are coprime.
   */
  const power = (fn: string, base: Fraction, exponent: bigint, charged: boolean): Fraction => {
    if (exponent === 1n) return base;
    const magnitude = exponent < 0n ? -exponent : exponent;
    const s = base.s < 0n && magnitude % 2n === 1n ? -1n : 1n;
    // A reduced Fraction has n = d only at ±1.
    if (magnitude === 0n || base.n === base.d) return reduced(s, 1n, 1n);
    const denominatorDigits = base.d === 1n ? 0 : powerDigits(base.d, magnitude);
    const digits = powerDigits(base.n, magnitude) + denominatorDigits;
    if (charged || digits > MAX_STRING_LENGTH) assertDigits(fn, digits);
    const n = base.n ** magnitude;
    const d = base.d ** magnitude;
    return exponent < 0n ? reduced(s, d, n) : reduced(s, n, d);
  };

  const factorial = (fn: string) => (x: Fraction) => {
    if (x.s < 0n) throw new Error('Value must be non-negative');
    if (x.d !== 1n) throw irrational(`${fn}(${x.toFraction()})`);
    return whole(factorialBig(fn, x.n));
  };

  const gamma = (x: Fraction) => {
    if (x.d !== 1n) throw irrational(`gamma(${x.toFraction()})`);
    if (x.s < 0n || x.n === 0n) {
      throw new FractionResultError('undefined_result', `gamma has a pole at ${x.toFraction()}.`);
    }
    return whole(factorialBig('gamma', x.n - 1n));
  };

  const permutations = (n: Fraction, k: Fraction) => {
    const total = naturalOf(n);
    const chosen = naturalOf(k);
    if (total === undefined || chosen === undefined) {
      throw new TypeError('Positive integer value expected in function permutations');
    }
    if (chosen > total) {
      throw new TypeError('second argument k must be less than or equal to first argument n');
    }
    // P(n, k) = C(n, k) · k!
    const log10 = log10Binomial(total, smallerSide(total, chosen)) + log10Factorial(Number(chosen));
    assertResultSize('permutations', log10);
    return whole(productRange(total - chosen + 1n, total));
  };

  const combinations = (n: Fraction, k: Fraction) => {
    const total = naturalOf(n);
    const chosen = naturalOf(k);
    if (total === undefined || chosen === undefined) {
      throw new TypeError('Positive integer value expected in function combinations');
    }
    if (chosen > total) throw new TypeError('k must be less than or equal to n');
    return whole(binomialBig('combinations', total, chosen));
  };

  const catalan = (n: Fraction) => {
    const index = naturalOf(n);
    if (index === undefined) {
      throw new TypeError('Non-negative integer value expected in function catalan');
    }
    assertResultSize('catalan', log10Binomial(2n * index, index) - log10Big(index + 1n));
    return whole(productRange(index + 1n, 2n * index) / productRange(2n, index + 1n));
  };

  const composition = (n: Fraction, k: Fraction) => {
    const total = naturalOf(n);
    const parts = naturalOf(k);
    if (!total || !parts) {
      throw new TypeError('Positive integer value expected in function composition');
    }
    if (parts > total) {
      throw new TypeError('k must be less than or equal to n in function composition');
    }
    return whole(binomialBig('composition', total - 1n, parts - 1n));
  };

  const multinomialOriginal = (namespace.multinomial as TypedFunction).signatures.Array as Impl;
  const multinomial = (a: MathArray | Matrix) => {
    const values = ((isMatrix(a) ? a.valueOf() : a) as unknown[]).flat(Number.POSITIVE_INFINITY);
    // An empty or mixed collection keeps math.js's own result.
    if (values.length === 0 || !values.every(isFraction)) {
      return (multinomialOriginal as (a: MathArray | Matrix) => unknown)(a);
    }
    const parts = (values as Fraction[]).map((value) => {
      const part = naturalOf(value);
      if (!part) throw new TypeError('Positive integer value expected in function multinomial');
      return part;
    });
    // multinomial(a) = ∏ C(a₁ + … + aⱼ, aⱼ) over the parts in descending order, so
    // each binomial picks the smaller side.
    parts.sort((x, y) => Number(y - x));
    let log10 = 0;
    let sum = parts[0] as bigint;
    for (const part of parts.slice(1)) {
      sum += part;
      log10 += log10Binomial(sum, part);
    }
    assertResultSize('multinomial', log10);
    let result = 1n;
    sum = parts[0] as bigint;
    for (const part of parts.slice(1)) {
      sum += part;
      result *= productRange(sum - part + 1n, sum) / productRange(2n, part);
    }
    return whole(result);
  };

  const sqrt = (x: Fraction) => {
    if (x.s < 0n) {
      throw new FractionResultError('fraction_unsupported', `sqrt(${x.toFraction()}) is complex.`);
    }
    const root = exactRoot(x, 2n);
    if (!root) throw irrational(`sqrt(${x.toFraction()})`);
    return root;
  };

  const cbrt = (x: Fraction) => {
    const root = exactRoot(x, 3n);
    if (!root) throw irrational(`cbrt(${x.toFraction()})`);
    return root;
  };

  // Validation and the zero cases follow number mode's nthRoot; the root of degree
  // ±p/q is the p-th root raised to ±q.
  const nthRoot = (a: Fraction, root: Fraction) => {
    if (root.n === 0n) throw new Error('Root must be non-zero');
    if (a.s < 0n && !(root.d === 1n && root.n % 2n === 1n)) {
      throw new Error('Root must be odd when a is negative.');
    }
    if (a.n === 0n) {
      if (root.s < 0n) {
        throw new FractionResultError('undefined_result', 'nthRoot(0, r < 0) divides by zero.');
      }
      return a;
    }
    const base = exactRoot(a, root.n);
    if (!base) throw irrational(`nthRoot(${a.toFraction()}, ${root.toFraction()})`);
    return power('nthRoot', base, root.s * root.d, true);
  };
  // math.js's conversion, as dispatch applies it to a number beside a Fraction.
  const { convert } = math.typed as unknown as { convert(value: unknown, type: string): unknown };
  const nthRootOfNumber = (a: Fraction, root: number) =>
    nthRoot(a, convert(root, 'Fraction') as Fraction);

  // An integer exponent raises the base directly; a non-integer one p/q takes the
  // exact q-th root, then raises it to p. With no exact root the power fails like
  // sqrt(2): its value is irrational, or complex for a negative base. math.js would
  // return a 64-bit float of it instead, which can round to a value that reads as
  // exact — 2^(1/10^30) is exactly 1. A zero base keeps math.js's own results: 0^0
  // is 1, a positive power 0, and a negative power divides by zero.
  //
  // An integer power, math.js's own before this override, is checked against the
  // per-call limit but not charged to the evaluation budget, which it never was:
  // charged, an element-wise power over a large matrix that fit the budget before
  // would pass it (the cubes in sum(range(1, 10^6) .^ 3) hold 17,133,789 digits).
  const fractionPow = (namespace.pow as TypedFunction).signatures['Fraction,Fraction'] as (
    x: Fraction,
    y: Fraction,
  ) => unknown;
  const pow = (x: Fraction, y: Fraction) => {
    if (x.n === 0n) return fractionPow(x, y);
    const exponent = y.s * y.n;
    if (y.d === 1n) return power('pow', x, exponent, false);
    if (x.s < 0n) {
      throw new FractionResultError(
        'fraction_unsupported',
        `(${x.toFraction()})^(${y.toFraction()}) is complex.`,
      );
    }
    const root = exactRoot(x, y.d);
    if (!root) throw irrational(`(${x.toFraction()})^(${y.toFraction()})`);
    return power('pow', root, exponent, true);
  };

  mathImport(
    {
      factorial: extend('factorial', { Fraction: factorial('factorial') }),
      gamma: extend('gamma', { Fraction: gamma }),
      permutations: extend('permutations', {
        Fraction: factorial('permutations'),
        'Fraction,Fraction': permutations,
      }),
      combinations: extend('combinations', { 'Fraction,Fraction': combinations }),
      catalan: extend('catalan', { Fraction: catalan }),
      composition: extend('composition', { 'Fraction,Fraction': composition }),
      multinomial: extend('multinomial', { Array: multinomial, Matrix: multinomial }),
      sqrt: extend('sqrt', { Fraction: sqrt }),
      cbrt: extend('cbrt', { Fraction: cbrt }),
      nthRoot: rebuiltNthRoot(math, {
        Fraction: (a: Fraction) => nthRoot(a, new FractionType(2n)),
        // math.js's one-argument collection forms pass the default degree 2 as a number.
        'Fraction,number': nthRootOfNumber,
        'Fraction,Fraction': nthRoot,
      }),
      // Replaces math.js's own `Fraction,Fraction` signature (the key must match its spelling).
      pow: extend('pow', { 'Fraction,Fraction': pow }),
    },
    { override: true },
  );

  installExactSqrtm(math, mathImport, extend);
  installExactComplex(math, mathImport, extend);
}

/** A math.js factory, with the dependency names it is called with. */
type MathFactory = ((dependencies: Record<string, unknown>) => TypedFunction) & {
  dependencies: string[];
};

/** A collection parameter of a typed-function signature. */
const COLLECTION_PARAM = /Array|Matrix/;

/**
 * `nthRoot` with the exact Fraction `scalars`, rebuilt from math.js's own factory.
 * math.js builds the collection forms to take each element's root with the
 * function they belong to (`typed.referToSelf`), and a typed function built from
 * them binds that reference to itself, so a collection of Fractions reaches the
 * Fraction signatures. Extending the installed `nthRoot` would not: its broadcast
 * guard (size-guard.ts) rebuilt the collection forms around math.js's original,
 * which takes each root with itself and has no Fraction signature. Each form that
 * pairs a collection with a `number` gains a `Fraction` counterpart, and the
 * rebuilt function is guarded again.
 */
function rebuiltNthRoot(math: MathJsInstance, scalars: Record<string, Impl>): unknown {
  const namespace = math as unknown as Record<string, unknown>;
  const createNthRoot = (all as FactoryFunctionMap).createNthRoot as unknown as MathFactory;
  const original = createNthRoot(
    Object.fromEntries(createNthRoot.dependencies.map((name) => [name, namespace[name]])),
  );
  const signatures: Record<string, Impl> = { ...original.signatures, ...scalars };
  for (const [signature, impl] of Object.entries(original.signatures)) {
    const params = signature.split(',');
    if (params.length !== 2 || !params.includes('number')) continue;
    if (!params.some((param) => COLLECTION_PARAM.test(param))) continue;
    signatures[params.map((param) => (param === 'number' ? 'Fraction' : param)).join(',')] = impl;
  }
  const typed = math.typed as unknown as Typed;
  return guardBroadcasting(math, 'nthRoot', typed('nthRoot', signatures));
}

/**
 * Tolerance for reading an exact root off math.js's `sqrtm` result: the simplest
 * rational within it is the candidate checked.
 */
const SQRTM_RECOVERY_TOLERANCE = 1e-9;

/**
 * math.js computes `sqrtm` of a matrix by Denman–Beavers iteration, stopping once
 * successive iterates differ by at most 1e-6, so under numericType "Fraction" it
 * returns a rational close to the root rather than the root. The exact version
 * replaces each entry with the simplest rational within
 * {@link SQRTM_RECOVERY_TOLERANCE} and returns that matrix only when it squares
 * back to the argument exactly; otherwise the root is not one it can find exactly.
 * A one-element argument goes through the exact `sqrt`, installed first.
 */
function installExactSqrtm(
  math: MathJsInstance,
  mathImport: MathJsInstance['import'],
  extend: (name: string, signatures: Record<string, Impl>) => TypedFunction,
): void {
  const namespace = math as unknown as Record<string, TypedFunction>;
  const approximate = namespace.sqrtm as TypedFunction;
  const { deepEqual, map, multiply } = math as unknown as Record<
    'deepEqual' | 'map' | 'multiply',
    (...args: unknown[]) => unknown
  >;
  const sqrtm = (A: MathArray | Matrix) => {
    const approximation = approximate(A);
    if ((math.size(A) as unknown as { valueOf(): number[] }).valueOf().length !== 2) {
      return approximation;
    }
    const candidate = map(approximation, (entry: unknown) =>
      isFraction(entry) ? entry.simplify(SQRTM_RECOVERY_TOLERANCE) : entry,
    );
    if (deepEqual(multiply(candidate, candidate), A) === true) return candidate;
    throw new FractionResultError(
      'fraction_unsupported',
      'sqrtm found no exact rational square root of the matrix.',
    );
  };
  mathImport({ sqrtm: extend('sqrtm', { Array: sqrtm, Matrix: sqrtm }) }, { override: true });
}

/** A math.js Complex, with the complex.js power its type declarations leave out. */
type ComplexValue = Complex & { pow(re: number, im: number): Complex };
type ComplexClass = new (re: number, im: number) => ComplexValue;

/**
 * Fraction mode holds a Complex as two 64-bit floats, and math.js takes its powers
 * and roots in floating point, whose parts can land on integers that read as exact:
 * `(2+0i)^(1/10^30)` comes out as exactly 1, `sqrt(9007199136250226 + 0i)` as
 * 94906265, and `(-60-6i)^9` as -6575858790128649 - 8236061563332085i, wrong in its
 * last digits. Each result here is settled one of three ways: the power or root of
 * a Gaussian integer, computed in BigInt, when it is a Gaussian integer itself;
 * otherwise math.js's float when a part is visibly not an integer, which the result
 * scan reports and an algorithm such as `polynomialRoot` can still work through; and
 * `fraction_unsupported` when the float reads as exact but cannot be checked as such.
 * A zero base and a non-real exponent keep math.js's result.
 */
function installExactComplex(
  math: MathJsInstance,
  mathImport: MathJsInstance['import'],
  extend: (name: string, signatures: Record<string, Impl>) => TypedFunction,
): void {
  const namespace = math as unknown as Record<string, TypedFunction>;
  const ComplexType = (namespace as unknown as { Complex: ComplexClass }).Complex;
  const isZero = (z: Complex) => z.re === 0 && z.im === 0;
  /** `exact` when known, else math.js's float `approximation` unless it reads as exact. */
  const settle = (call: () => string, approximation: Complex, exact: Gaussian | undefined) => {
    if (exact) return new ComplexType(Number(exact[0]), Number(exact[1]));
    if (gaussianOf(approximation)) {
      throw new FractionResultError(
        'fraction_unsupported',
        `${call()} has no exact value its 64-bit float result can stand for.`,
      );
    }
    return approximation;
  };
  /** Every root math.js found, each settled against `z`. */
  const settleRoots = (call: () => string, z: Complex, roots: MathArray | Matrix) => {
    const list = (isMatrix(roots) ? roots.valueOf() : roots) as Complex[];
    const exact = gaussianOf(z);
    const degree = BigInt(list.length);
    const settled = list.map((root) => settle(call, root, exact && rootNear(root, exact, degree)));
    return isMatrix(roots) ? math.matrix(settled) : settled;
  };

  const powSignatures = (namespace.pow as TypedFunction).signatures;
  const complexPow = powSignatures['Complex,Complex'] as (x: Complex, y: Complex) => Complex;
  const fractionPow = powSignatures['Fraction,Fraction'] as (x: Fraction, y: Fraction) => unknown;
  const bigNumberPow = powSignatures['BigNumber,BigNumber'] as (x: unknown, y: unknown) => unknown;
  const typed = math.typed as unknown as { convert(value: unknown, type: string): unknown };
  const convert = typed.convert.bind(typed);
  // `z ^ (p/q)` for a Fraction exponent: the exact q-th root that complex.js's
  // principal root stands for, raised to p.
  const powComplexFraction = (x: ComplexValue, y: Fraction) => {
    const approximation = complexPow(x, new ComplexType(y.valueOf(), 0));
    if (isZero(x)) return approximation;
    const exact = gaussianOf(x);
    const root = exact && (y.d === 1n ? exact : rootNear(x.pow(1 / Number(y.d), 0), exact, y.d));
    const call = () => `(${x.toString()})^(${y.toFraction()})`;
    return settle(call, approximation, root && gaussianPower(root, y.s * y.n));
  };
  // A Complex exponent arrives as floats: only a real integer one can be checked.
  const powComplexComplex = (x: Complex, y: Complex) => {
    const approximation = complexPow(x, y);
    if (isZero(x) || y.im !== 0) return approximation;
    const exact = Number.isInteger(y.re) ? gaussianOf(x) : undefined;
    const call = () => `(${x.toString()})^(${y.toString()})`;
    return settle(call, approximation, exact && gaussianPower(exact, BigInt(y.re)));
  };

  const complexRoot = (fn: 'sqrt' | 'cbrt', degree: bigint) => {
    const original = (namespace[fn] as TypedFunction).signatures.Complex as (z: Complex) => Complex;
    return (z: Complex) => {
      const approximation = original(z);
      const exact = gaussianOf(z);
      const call = () => `${fn}(${z.toString()})`;
      return settle(call, approximation, exact && rootNear(approximation, exact, degree));
    };
  };
  const cbrt = complexRoot('cbrt', 3n);
  const allCubeRoots = (namespace.cbrt as TypedFunction).signatures['Complex,boolean'] as (
    z: Complex,
    all: boolean,
  ) => MathArray | Matrix;

  const nthRoots: Record<string, Impl> = {};
  for (const [signature, impl] of Object.entries(
    (namespace.nthRoots as TypedFunction).signatures,
  )) {
    if (!signature.startsWith('Complex')) continue;
    const original = impl as (z: Complex, ...rest: unknown[]) => MathArray | Matrix;
    nthRoots[signature] = (z: Complex, ...rest: unknown[]) =>
      settleRoots(() => `nthRoots(${z.toString()})`, z, original(z, ...rest));
  }

  mathImport(
    {
      // Each replaces math.js's own Complex signature or adds one for a Fraction
      // exponent. A number or BigNumber base converts to Complex, so the new
      // `Complex,Fraction` would take it over: its two signatures keep the conversion
      // math.js chose before (`number(4)^2` is 16/1, `pi^2` a float precision error).
      pow: extend('pow', {
        'Complex,Fraction': powComplexFraction,
        'Complex,Complex': powComplexComplex,
        'number,Fraction': (x: number, y: Fraction) =>
          fractionPow(convert(x, 'Fraction') as Fraction, y),
        'BigNumber,Fraction': (x: unknown, y: Fraction) => bigNumberPow(x, convert(y, 'BigNumber')),
      }),
      sqrt: extend('sqrt', { Complex: complexRoot('sqrt', 2n) }),
      cbrt: extend('cbrt', {
        Complex: cbrt,
        'Complex,boolean': (z: Complex, all: boolean) =>
          all
            ? settleRoots(() => `cbrt(${z.toString()}, true)`, z, allCubeRoots(z, true))
            : cbrt(z),
      }),
      nthRoots: extend('nthRoots', nthRoots),
    },
    { override: true },
  );
}
