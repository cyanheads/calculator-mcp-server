/**
 * @fileoverview `integrate(f, x, a, b)`: the definite integral of an expression over
 * a finite interval, estimated numerically by adaptive Gauss–Kronrod quadrature
 * (G7K15 with global bisection of the subinterval with the largest error estimate,
 * QUADPACK's QAG). A raw-argument function: it receives the integrand unevaluated
 * and samples it with the variable bound in a scope over the caller's.
 * @module services/math/integrate
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  isBigNumber,
  isConstantNode,
  isFraction,
  isNode,
  isSymbolNode,
  type MathNode,
  typeOf,
} from 'mathjs';

/**
 * Kronrod nodes on [−1, 1], positive half, outermost first; the last is the center.
 * These and the weights below are QUADPACK's `qk15` tables rounded to 64-bit floats.
 */
const KRONROD_NODES = [
  0.9914553711208126, 0.9491079123427585, 0.8648644233597691, 0.7415311855993945,
  0.5860872354676911, 0.4058451513773972, 0.20778495500789848, 0,
] as const;

/** Kronrod weights, paired with {@link KRONROD_NODES}. */
const KRONROD_WEIGHTS = [
  0.022935322010529224, 0.06309209262997856, 0.10479001032225019, 0.14065325971552592,
  0.1690047266392679, 0.19035057806478542, 0.20443294007529889, 0.20948214108472782,
] as const;

/** Weights of the 7-point Gauss rule, whose nodes are Kronrod nodes 1, 3, 5, and the center. */
const GAUSS_WEIGHTS = [
  0.1294849661688697, 0.27970539148927664, 0.3818300505051189, 0.4179591836734694,
] as const;

/** Converged once the summed error estimate is at most this fraction of the estimated ∫|f|. */
const RELATIVE_TOLERANCE = 1e-10;

/** Most subintervals one call splits the interval into: 15 + 30·499 = 14,985 samples at most. */
const MAX_SUBINTERVALS = 500;

/** One subinterval's 15-point estimates. */
interface Piece {
  /** Estimate of ∫|f|, which scales the stopping rule. */
  absolute: number;
  /** |K15 − G7|. */
  error: number;
  lower: number;
  upper: number;
  /** The K15 estimate of ∫f. */
  value: number;
}

type Sampler = (x: number) => number;

/** The scope interface math.js evaluates against (a `Map` or one of its own Map-likes). */
interface Scope {
  get(name: string): unknown;
  has(name: string): boolean;
  keys(): IterableIterator<string>;
  set(name: string, value: unknown): unknown;
}

/**
 * The caller's scope with the integration variable bound over it, as math.js binds
 * a function's parameters: the variable reads and writes here, every other name
 * passes through, so the integrand still reads the caller's variables.
 */
class SampleScope implements Scope {
  value: unknown;
  readonly #parent: Scope;
  readonly #name: string;

  constructor(parent: Scope, name: string) {
    this.#parent = parent;
    this.#name = name;
  }

  get(name: string): unknown {
    return name === this.#name ? this.value : this.#parent.get(name);
  }

  has(name: string): boolean {
    return name === this.#name || this.#parent.has(name);
  }

  keys(): IterableIterator<string> {
    return new Set([...this.#parent.keys(), this.#name]).values();
  }

  set(name: string, value: unknown): this {
    if (name === this.#name) this.value = value;
    else this.#parent.set(name, value);
    return this;
  }
}

/** The 15-point Kronrod and 7-point Gauss estimates over [lower, upper]. */
function kronrod15(f: Sampler, lower: number, upper: number): Piece {
  const center = 0.5 * (lower + upper);
  const half = 0.5 * (upper - lower);
  const fCenter = f(center);
  let kronrod = fCenter * KRONROD_WEIGHTS[7];
  let gauss = fCenter * GAUSS_WEIGHTS[3];
  let absolute = Math.abs(fCenter) * KRONROD_WEIGHTS[7];
  for (let j = 0; j < 7; j++) {
    const offset = half * (KRONROD_NODES[j] as number);
    const left = f(center - offset);
    const right = f(center + offset);
    const weight = KRONROD_WEIGHTS[j] as number;
    kronrod += weight * (left + right);
    absolute += weight * (Math.abs(left) + Math.abs(right));
    if (j % 2 === 1) gauss += (GAUSS_WEIGHTS[(j - 1) / 2] as number) * (left + right);
  }
  return {
    lower,
    upper,
    value: kronrod * half,
    error: Math.abs((kronrod - gauss) * half),
    absolute: absolute * Math.abs(half),
  };
}

/** A sample, bound, or estimate as a JS number; anything but a real number throws. */
function toReal(value: unknown, what: string): number {
  if (typeof value === 'number') return value;
  if (isBigNumber(value)) return value.toNumber();
  if (isFraction(value)) return value.valueOf();
  throw new Error(`integrate() needs ${what} to be a real number; got a ${typeOf(value)}.`);
}

/** Integrate `f` over [a, b] with a < b by adaptive bisection. */
function adaptiveQuadrature(f: Sampler, a: number, b: number): number {
  const pieces = [kronrod15(f, a, b)];
  for (;;) {
    let total = 0;
    let error = 0;
    let absolute = 0;
    let worst = 0;
    for (const [i, piece] of pieces.entries()) {
      total += piece.value;
      error += piece.error;
      absolute += piece.absolute;
      if (piece.error > (pieces[worst] as Piece).error) worst = i;
    }
    if (!Number.isFinite(total) || !Number.isFinite(error) || !Number.isFinite(absolute)) {
      throw new Error(
        `integrate() cannot represent this integral: on [${a}, ${b}] it passes the 64-bit floating-point range (about 1.8e308).`,
      );
    }
    if (error <= RELATIVE_TOLERANCE * absolute) return total;
    if (pieces.length >= MAX_SUBINTERVALS) {
      throw new Error(
        `integrate() did not converge: after ${MAX_SUBINTERVALS} subintervals the error estimate is ${error.toPrecision(3)}, above the relative tolerance of ${RELATIVE_TOLERANCE}. The integrand may be singular, discontinuous, or highly oscillatory on [${a}, ${b}] — split the interval at the trouble point, or the integral may diverge.`,
      );
    }
    // Bisect the worst subinterval. Once it is too narrow to split, a half is empty
    // and the other is the same subinterval again, so the cap still ends the loop.
    const { lower, upper } = pieces[worst] as Piece;
    const mid = 0.5 * (lower + upper);
    pieces.splice(worst, 1, kronrod15(f, lower, mid), kronrod15(f, mid, upper));
  }
}

/** The failure for a numeric type `integrate()` cannot compute in. */
function numericTypeUnsupported(numberType: 'BigNumber' | 'Fraction') {
  const recovery = {
    hint: 'Retry with numericType "number"; integrate() is available only there.',
  };
  return numberType === 'Fraction'
    ? validationError(
        'integrate() returns a 64-bit floating-point estimate, which numericType "Fraction" cannot hold exactly.',
        { reason: 'fraction_unsupported', recovery },
      )
    : validationError(
        'integrate() samples and sums in 64-bit floating point, so its result cannot carry BigNumber precision.',
        { reason: 'evaluation_failed', recovery },
      );
}

/** math.js's signature for a function that takes its arguments as unevaluated nodes. */
type RawArgsFunction = ((args: unknown, math: unknown, scope: Scope) => number) & {
  rawArgs: true;
};

/**
 * `integrate` for one math.js instance, to import under `integrate` (an
 * `integral` call is renamed to it on the parse tree). It compiles the integrand node it is handed — the parsed node itself,
 * never a copy, so the evaluation's per-node element metering stays on it — and
 * keeps no state between calls. Under numericType "BigNumber" or "Fraction" every
 * call fails: samples are summed in 64-bit floats.
 */
export function createIntegrate(numberType: 'number' | 'BigNumber' | 'Fraction'): RawArgsFunction {
  const integrate = (args: unknown, _math: unknown, scope: Scope): number => {
    if (numberType !== 'number') throw numericTypeUnsupported(numberType);
    // Passed as a value (`map([1, 2], integrate)`), it receives evaluated arguments.
    if (!Array.isArray(args) || !args.every((arg) => isNode(arg))) {
      throw new Error(
        'integrate() must be called directly, e.g. integrate(x^2, x, 0, 1); it cannot be passed as a value.',
      );
    }
    if (args.length !== 4) {
      throw new Error(
        `integrate() takes 4 arguments (integrand, variable, lower bound, upper bound), e.g. integrate(x^2, x, 0, 1); got ${args.length}.`,
      );
    }
    const [integrand, variable, lowerNode, upperNode] = args as [
      MathNode,
      MathNode,
      MathNode,
      MathNode,
    ];
    if (!isSymbolNode(variable)) {
      throw new Error(
        'integrate() takes the integration variable as a bare name in its second argument, e.g. integrate(x^2, x, 0, 1).',
      );
    }
    if (isConstantNode(integrand) && typeof integrand.value === 'string') {
      throw new Error('integrate() takes the integrand unquoted, e.g. integrate(x^2, x, 0, 1).');
    }
    const name = variable.name;
    const lower = toReal(lowerNode.compile().evaluate(scope), 'the lower bound');
    const upper = toReal(upperNode.compile().evaluate(scope), 'the upper bound');
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      throw new Error(`integrate() needs finite bounds; got [${lower}, ${upper}].`);
    }
    if (lower === upper) return 0;

    const sampleScope = new SampleScope(scope, name);
    const body = integrand.compile();
    const sample: Sampler = (x) => {
      sampleScope.value = x;
      const y = toReal(body.evaluate(sampleScope), `the integrand at ${name} = ${x}`);
      if (!Number.isFinite(y)) {
        throw new Error(
          `integrate() sampled a non-finite integrand (${y}) at ${name} = ${x}: the integrand is singular, undefined, or past the 64-bit floating-point range there — split the interval at that point or remove the singularity.`,
        );
      }
      return y;
    };
    return lower < upper
      ? adaptiveQuadrature(sample, lower, upper)
      : -adaptiveQuadrature(sample, upper, lower);
  };
  return Object.assign(integrate, { rawArgs: true as const });
}
