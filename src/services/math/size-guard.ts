/**
 * @fileoverview Size limits for expression evaluation. The evaluation timeout
 * bounds time; these bound memory. Two layers:
 *
 * - Per-call limits on math.js functions whose result size is set by an argument
 *   — a size vector, a count, a product or broadcast of inputs, a repetition of
 *   inputs (`concat(A, A, A)`), an index that reads or grows a matrix, or a
 *   formatting precision — rather than by the size of any one input. Each guard
 *   computes the size the call is about to build and throws
 *   {@link SizeLimitError} before allocating.
 * - A per-evaluation element budget for what many individually allowed results
 *   add up to — repeated copies, or a loop (`map`, `forEach`, `filter`, a
 *   user-defined function) that builds a collection per iteration. Every guarded
 *   call and every value-producing node of the expression tree charges the
 *   elements (or characters) it builds; the count is deterministic, so the
 *   verdict never depends on when the garbage collector runs.
 *
 * The rebuilt size functions also accept whole-number Fraction sizes and counts,
 * so `zeros(2)` works under numericType "Fraction" (see {@link WHOLE_NUMBER_ARGS}).
 * A Fraction instance additionally gets the same conversion on its index
 * functions (`index`, `row`, `column`) and on the dimension argument of its
 * reductions and `concat`, so `[1, 2, 3][2]` and `sum(A, 1)` work there too.
 * @module services/math/size-guard
 */

import {
  type FactoryFunction,
  factory,
  isBigNumber,
  isFraction,
  isMatrix,
  isUnit,
  type MathJsInstance,
  type MathNode,
} from 'mathjs';

/**
 * Largest collection, in elements, a guarded function may build in one call. One
 * million keeps work such as `sum(range(1, 1e6))` available while refusing sizes
 * whose allocation alone runs to gigabytes. It sits well above the largest
 * collection that can be returned: a formatted element takes at least three
 * characters, so `CALC_MAX_RESULT_LENGTH` (≤ 1,000,000) caps a returned
 * collection near 333,000 elements.
 */
export const MAX_MATRIX_ELEMENTS = 1_000_000;

/**
 * Longest string a guarded formatting function (`format`, `print`, `bin`, `oct`,
 * `hex`) may build. Equal to the largest `CALC_MAX_RESULT_LENGTH`, so no
 * returnable result is refused.
 */
export const MAX_STRING_LENGTH = 1_000_000;

/**
 * Elements (string characters count as elements) one evaluation may build in
 * total. A value is charged by the guarded call that builds it and again by the
 * expression node that returns it, so this allows nine chained elementwise
 * operations on a full-size (MAX_MATRIX_ELEMENTS) range, while a loop or a list
 * of copies that keeps building collections stops within a few hundred
 * megabytes. Scalars are not charged, so a long scalar loop is bounded only by
 * the timeout.
 */
export const MAX_EVALUATION_ELEMENTS = 20 * MAX_MATRIX_ELEMENTS;

/** Thrown when an evaluation would exceed a size limit. */
export class SizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SizeLimitError';
  }

  /** A guarded function's output would exceed its per-call limit. */
  static forCall(fn: string, size: number, limit: number, unit: 'elements' | 'characters') {
    const amount = Number.isFinite(size) ? Math.ceil(size).toLocaleString('en-US') : 'unbounded';
    return new SizeLimitError(
      `${fn}() would build ${amount} ${unit}, over the limit of ${limit.toLocaleString('en-US')}.`,
    );
  }
}

/**
 * Per-evaluation state. Evaluation is synchronous, so one module-level record
 * serves every math.js instance; {@link beginEvaluation} resets it.
 */
const evaluation = {
  /** Elements charged so far against {@link MAX_EVALUATION_ELEMENTS}. */
  elements: 0,
  /** The size-limit error raised during this evaluation, if any. */
  limitError: undefined as SizeLimitError | undefined,
};

/** Start a new evaluation's element budget and forget any earlier limit error. */
export function beginEvaluation(): void {
  evaluation.elements = 0;
  evaluation.limitError = undefined;
}

/**
 * The size-limit error behind a failure, if one was raised during this
 * evaluation: the error itself, or a math.js error that re-wrapped it — `map`,
 * `forEach`, and `filter` rethrow a callback's error as a new error whose
 * message embeds the original.
 */
export function sizeLimitErrorIn(err: unknown): SizeLimitError | undefined {
  if (err instanceof SizeLimitError) return err;
  const { limitError } = evaluation;
  const message = err instanceof Error ? err.message : String(err);
  return limitError && message.includes(limitError.message) ? limitError : undefined;
}

function raise(error: SizeLimitError): never {
  evaluation.limitError = error;
  throw error;
}

/** Charge `count` elements to this evaluation; throw once it passes {@link MAX_EVALUATION_ELEMENTS}. */
function charge(count: number): void {
  evaluation.elements += count;
  if (evaluation.elements > MAX_EVALUATION_ELEMENTS) {
    raise(
      new SizeLimitError(
        `The expression built over ${MAX_EVALUATION_ELEMENTS.toLocaleString('en-US')} elements in total while evaluating.`,
      ),
    );
  }
}

/**
 * Meter a node so each evaluation of it charges the size of the value it returns
 * (see {@link sizeOf}). Wraps the node instance's own `_compile`, which its parent
 * — or a lazy transform such as `map`, for its callback — calls when compiling,
 * so a node inside a loop body is charged on every iteration.
 */
export function meterNode(node: MathNode): void {
  type CompiledNode = (...args: unknown[]) => unknown;
  const target = node as unknown as {
    _compile(math: unknown, argNames: unknown): CompiledNode;
  };
  const compile = target._compile.bind(target);
  target._compile = (math, argNames) => {
    const evaluate = compile(math, argNames);
    return (...args: unknown[]) => {
      const value = evaluate(...args);
      charge(sizeOf(value));
      return value;
    };
  };
}

type Shape = number[];
type Guard = (args: unknown[]) => void;
type Impl = (...args: unknown[]) => unknown;
interface RawNode {
  compile(): { evaluate(scope: unknown): unknown };
}
type RawArgsFn = ((args: RawNode[], math: unknown, scope: unknown) => unknown) & {
  rawArgs?: boolean;
};
interface Typed {
  isTypedFunction(fn: unknown): boolean;
  (name: string, signatures: Record<string, Impl>): Impl;
}
type MathFactory = FactoryFunction<unknown> & {
  (deps: Record<string, unknown>): unknown;
  fn: string;
  dependencies: string[];
  meta?: Record<string, unknown>;
};
/** The subset of a DenseMatrix / SparseMatrix a growth guard reads. */
interface MatrixLike {
  size(): Shape;
}
interface MatrixClass {
  prototype: Record<string, Impl>;
}

/**
 * Reject a call whose output would exceed the per-call element limit, then
 * charge what it newly allocates — the whole output unless `allocated` says
 * less (an in-place growth allocates only the added elements; a read, nothing
 * the expression node returning it will not charge).
 */
function assertElements(fn: string, count: number, allocated = count): void {
  if (count > MAX_MATRIX_ELEMENTS) {
    raise(SizeLimitError.forCall(fn, count, MAX_MATRIX_ELEMENTS, 'elements'));
  }
  charge(allocated);
}

function assertCharacters(fn: string, length: number): void {
  if (length > MAX_STRING_LENGTH) {
    raise(SizeLimitError.forCall(fn, length, MAX_STRING_LENGTH, 'characters'));
  }
  charge(length);
}

/** Product of a shape's dimensions (1 for a scalar's empty shape). */
function countOf(shape: Shape): number {
  let n = 1;
  for (const d of shape) n *= d;
  return n;
}

/** Shape of an Array or Matrix, or `null` for anything else. */
function shapeOf(value: unknown): Shape | null {
  if (isMatrix(value)) return (value as unknown as MatrixLike).size();
  if (!Array.isArray(value)) return null;
  const shape: Shape = [];
  let level: unknown = value;
  while (Array.isArray(level)) {
    shape.push(level.length);
    level = level[0];
  }
  return shape;
}

/**
 * What a value holds, for the evaluation budget: a collection's elements, a
 * string's characters, or an object literal's values (and what they hold).
 * Scalars — numbers, BigNumbers, Fractions, Units, booleans — count as zero.
 */
function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  const shape = shapeOf(value);
  if (shape) return countOf(shape);
  if (!isPlainObject(value)) return 0;
  let total = 0;
  for (const item of Object.values(value)) total += 1 + sizeOf(item);
  return total;
}

/** Plain object — the value an object literal (`{a: 1}`) evaluates to. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Elements (characters, for strings) across an argument list — what joining them builds. */
function joinedSize(args: unknown[]): number {
  return args.reduce((total: number, arg) => total + sizeOf(arg), 0);
}

/** Numeric value of a size-like argument (number, bigint, BigNumber, Fraction, numeric string, Unit); NaN otherwise. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'string' || typeof value === 'boolean') {
    return Number(value);
  }
  if (isUnit(value)) return toNumber((value as unknown as { value: unknown }).value);
  if (value !== null && typeof value === 'object') {
    return Number((value as { valueOf(): unknown }).valueOf());
  }
  return Number.NaN;
}

/** Numeric entries of an argument list, with Array/Matrix arguments flattened one level. */
function sizeEntries(args: unknown[]): number[] {
  const out: number[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') continue; // storage format ("dense" / "sparse")
    const entries = isMatrix(arg) ? (arg as unknown as { valueOf(): unknown }).valueOf() : arg;
    if (Array.isArray(entries)) out.push(...entries.map(toNumber));
    else out.push(toNumber(entries));
  }
  return out;
}

/** Product of the entries of a size-vector argument (Array or Matrix); 1 for a scalar. */
function sizeProduct(arg: unknown): number {
  return shapeOf(arg) ? countOf(sizeEntries([arg])) : 1;
}

/** Shape two operands broadcast to (math.js elementwise rules), or `null` when both are scalars. */
function broadcastShape(a: Shape | null, b: Shape | null): Shape | null {
  if (!a || !b) return a ?? b;
  const n = Math.max(a.length, b.length);
  const out: Shape = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.max(a[a.length - n + i] ?? 1, b[b.length - n + i] ?? 1));
  }
  return out;
}

/** Shape of a matrix product (`multiply`), or `null` when both operands are scalars. */
function productShape(a: Shape | null, b: Shape | null): Shape | null {
  if (!a || !b) return a ?? b;
  const rows = a.length === 2 ? [a[0] as number] : [];
  const cols = b.length === 2 ? [b[1] as number] : [];
  return [...rows, ...cols];
}

/**
 * Fold an operand list with a shape combiner, checking and charging each shape
 * the fold builds (the first operand already exists).
 */
function assertFoldedShape(
  fn: string,
  args: unknown[],
  combine: (a: Shape | null, b: Shape | null) => Shape | null,
): void {
  let shape = shapeOf(args[0]);
  for (const arg of args.slice(1)) {
    shape = combine(shape, shapeOf(arg));
    if (shape) assertElements(fn, countOf(shape));
  }
}

/** Element count `range(start, end, step)` produces, from numeric or `"start:end"` / `"start:step:end"` arguments. */
function rangeCount(args: unknown[]): number {
  let start: number;
  let end: number;
  let step = 1;
  if (typeof args[0] === 'string') {
    const parts = args[0].split(':').map(Number);
    if (parts.length === 3) [start, step, end] = parts as [number, number, number];
    else [start, end] = parts as [number, number];
  } else {
    start = toNumber(args[0]);
    end = toNumber(args[1]);
    if (args.length > 2 && typeof args[2] !== 'boolean') step = toNumber(args[2]);
  }
  return Math.floor(Math.abs((end - start) / step)) + 1;
}

/** Shape a matrix grows to when an index reaches past its current size. */
function grownShape(current: Shape, maxIndex: number[]): Shape {
  const n = Math.max(current.length, maxIndex.length);
  const out: Shape = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.max(current[i] ?? 1, (maxIndex[i] ?? 0) + 1));
  }
  return out;
}

/** Characters per decimal digit of magnitude for each positional notation. */
const DIGITS_PER_DECIMAL_DIGIT: Record<string, number> = {
  fixed: 1,
  bin: Math.log2(10),
  oct: Math.log2(10) / 3,
  hex: Math.log2(10) / 4,
};

/**
 * Largest decimal exponent of any BigNumber in a value (walking matrices, arrays,
 * units, and object values). Only BigNumbers matter: a `number` is at most 309
 * digits, but a BigNumber exponent reaches 9e15, and positional notation writes
 * every digit.
 */
function maxBigNumberExponent(value: unknown): number {
  if (isBigNumber(value)) return Math.abs((value as unknown as { e: number }).e);
  if (isUnit(value)) return maxBigNumberExponent((value as unknown as { value: unknown }).value);
  if (isMatrix(value))
    return maxBigNumberExponent((value as unknown as { valueOf(): unknown }).valueOf());
  if (Array.isArray(value))
    return value.reduce((m: number, v) => Math.max(m, maxBigNumberExponent(v)), 0);
  if (isPlainObject(value)) return maxBigNumberExponent(Object.values(value));
  return 0;
}

/**
 * Reject formatting options that would build an oversized string: a precision
 * past the limit, or positional notation (`fixed`, `bin`, `oct`, `hex`) of a
 * BigNumber whose exponent alone spells out more digits than the limit.
 */
function assertFormatSize(fn: string, value: unknown, options: unknown): void {
  const isOptionsObject =
    options !== null && typeof options === 'object' && !isBigNumber(options) && !isMatrix(options);
  const precision = isOptionsObject
    ? toNumber((options as { precision?: unknown }).precision)
    : toNumber(options);
  const notation = isOptionsObject ? (options as { notation?: unknown }).notation : undefined;
  const factor = typeof notation === 'string' ? DIGITS_PER_DECIMAL_DIGIT[notation] : undefined;
  const digits = factor === undefined ? 0 : maxBigNumberExponent(value) * factor;
  const length = digits + (precision > 0 ? precision : 0);
  if (length > 0) assertCharacters(fn, length);
}

/** Per-function checks for functions whose output size is an argument. */
const SIZE_GUARDS: Record<string, Guard> = {
  zeros: (args) => assertElements('zeros', countOf(sizeEntries(args))),
  ones: (args) => assertElements('ones', countOf(sizeEntries(args))),
  identity: (args) => {
    const dims = sizeEntries(args);
    // identity(n) and identity([n]) are square.
    assertElements('identity', dims.length === 1 ? (dims[0] as number) ** 2 : countOf(dims));
  },
  range: (args) => assertElements('range', rangeCount(args)),
  random: (args) => assertElements('random', sizeProduct(args[0])),
  randomInt: (args) => assertElements('randomInt', sizeProduct(args[0])),
  matrixFromFunction: (args) => assertElements('matrixFromFunction', sizeProduct(args[0])),
  resize: (args) => assertElements('resize', sizeProduct(args[1])),
  pickRandom: (args) => {
    for (const arg of args.slice(1)) {
      if (shapeOf(arg)) continue; // weights
      const count =
        arg !== null && typeof arg === 'object' && 'number' in arg
          ? toNumber((arg as { number: unknown }).number)
          : toNumber(arg);
      assertElements('pickRandom', count);
    }
  },
  nthRoots: (args) => assertElements('nthRoots', args.length > 1 ? toNumber(args[1]) : 2),
  freqz: (args) => {
    // A scalar third argument is the number of frequency points; the result holds two arrays of it.
    if (args.length > 2 && !shapeOf(args[2])) assertElements('freqz', 2 * toNumber(args[2]));
  },
  quantileSeq: (args) => {
    // A scalar second argument above 1 is a count of evenly spaced quantiles.
    if (args.length > 1 && !shapeOf(args[1]) && toNumber(args[1]) > 1) {
      assertElements('quantileSeq', toNumber(args[1]));
    }
  },
  diag: (args) => {
    const shape = shapeOf(args[0]);
    if (shape?.length !== 1) return; // a matrix argument yields its diagonal vector
    const offset = args.slice(1).find((a) => typeof a !== 'string');
    const k = offset === undefined ? 0 : Math.abs(toNumber(offset));
    assertElements('diag', ((shape[0] as number) + k) ** 2);
  },
  kron: (args) =>
    assertElements('kron', countOf(shapeOf(args[0]) ?? []) * countOf(shapeOf(args[1]) ?? [])),
  setCartesian: (args) =>
    assertElements(
      'setCartesian',
      2 * countOf(shapeOf(args[0]) ?? []) * countOf(shapeOf(args[1]) ?? []),
    ),
  setPowerset: (args) => assertElements('setPowerset', 2 ** countOf(shapeOf(args[0]) ?? [])),
  multiply: (args) => assertFoldedShape('multiply', args, productShape),
  // Joining functions build the sum of their inputs, and one input may repeat (`concat(A, A, A)`).
  concat: (args) => assertElements('concat', joinedSize(args)),
  matrixFromRows: (args) => assertElements('matrixFromRows', joinedSize(args)),
  matrixFromColumns: (args) => assertElements('matrixFromColumns', joinedSize(args)),
  format: (args) => assertFormatSize('format', args[0], args[1]),
  print: (args) => assertFormatSize('print', args[1], args[2]),
  bin: (args) => assertFormatSize('bin', args[0], { notation: 'bin' }),
  oct: (args) => assertFormatSize('oct', args[0], { notation: 'oct' }),
  hex: (args) => assertFormatSize('hex', args[0], { notation: 'hex' }),
};

/**
 * Elementwise functions that broadcast their operands (`[1;2;3] + [1,2,3]` is
 * 3×3), so two vectors of n elements produce n² — guarded on the broadcast shape.
 */
const BROADCASTING_FUNCTIONS = [
  'add',
  'subtract',
  'dotMultiply',
  'dotDivide',
  'dotPow',
  'mod',
  'equal',
  'unequal',
  'larger',
  'largerEq',
  'smaller',
  'smallerEq',
  'compare',
  'compareText',
  'atan2',
  'gcd',
  'lcm',
  'nthRoot',
  'bitXor',
  'xor',
  'leftShift',
  'rightArithShift',
  'rightLogShift',
  'to',
] as const;

/**
 * Broadcasting functions whose expression form is a lazy (raw-argument)
 * transform: the transform evaluates its operands itself and calls an internal
 * copy of the function, so the guard wraps the transform. Each entry counts the
 * leading arguments that broadcast — both operands of `and`, `or`, `&`, `|`, and
 * `??`, and every collection before the callback of `map(A, B, …, callback)`.
 */
const LAZY_BROADCASTING_TRANSFORMS: Record<string, (args: unknown[]) => number> = {
  and: () => 2,
  or: () => 2,
  bitAnd: () => 2,
  bitOr: () => 2,
  nullish: () => 2,
  map: (args) => args.length - 1,
};

/**
 * Signatures that can take a collection. Broadcast and product guards wrap only
 * these, so scalar dispatch — the hot path inside math.js's own loops — is
 * untouched.
 */
const COLLECTION_SIGNATURE = /Array|Matrix|any/;

/**
 * Argument positions that hold whole numbers — sizes, counts, indexes, or
 * dimensions. Under numericType "Fraction" every literal is a Fraction, and
 * these functions have no Fraction signature, so `zeros(2)`, `[1, 2, 3][2]`, or
 * `sum(A, 1)` would fail on the literal itself. Integer-valued Fractions in
 * these positions are passed on as plain numbers.
 */
interface WholeNumberArgs {
  /**
   * Convert only when the first argument is an Array or Matrix: `sum(A, 1)` takes
   * a dimension, while the scalar form `sum(1/2, 1/3)` takes values.
   */
  afterCollection?: boolean;
  /** What the positions hold, for the error on a non-integer value. */
  noun: 'sizes and counts' | 'indexes' | 'dimensions';
  /** Positions of scalar values. */
  scalar?: (index: number) => boolean;
  /** Positions of vectors (an Array or Matrix of values). */
  vector?: (index: number) => boolean;
}

const EVERY_POSITION = () => true;
const SIZES = 'sizes and counts';

/**
 * The dimension of a reduction, `fn(A, dim)` — second, after the collection, in
 * both the typed function and its expression transform (which moves it to
 * zero-based once it is a number). `std` and `variance` keep it second when a
 * normalization string follows.
 */
const DIMENSION: WholeNumberArgs = {
  noun: 'dimensions',
  scalar: (i) => i === 1,
  afterCollection: true,
};

/**
 * Whole-number arguments per function. The size functions are guarded on every
 * instance; the index and dimension functions are rebuilt on a Fraction instance
 * only (see {@link FRACTION_WHOLE_NUMBER_FUNCTIONS}).
 */
const WHOLE_NUMBER_ARGS: Record<string, WholeNumberArgs> = {
  zeros: { noun: SIZES, scalar: EVERY_POSITION, vector: EVERY_POSITION },
  ones: { noun: SIZES, scalar: EVERY_POSITION, vector: EVERY_POSITION },
  identity: { noun: SIZES, scalar: EVERY_POSITION, vector: EVERY_POSITION },
  resize: { noun: SIZES, vector: (i) => i === 1 },
  random: { noun: SIZES, vector: (i) => i === 0 },
  randomInt: { noun: SIZES, scalar: EVERY_POSITION, vector: (i) => i === 0 },
  matrixFromFunction: { noun: SIZES, vector: (i) => i === 0 },
  diag: { noun: SIZES, scalar: (i) => i === 1 },
  nthRoots: { noun: SIZES, scalar: (i) => i === 1 },
  pickRandom: { noun: SIZES, scalar: (i) => i > 0 },
  // `index` covers bracket indexing (`A[2]`, `A[2, 1] = v`) and explicit `index(2)`.
  index: { noun: 'indexes', scalar: EVERY_POSITION, vector: EVERY_POSITION },
  row: { noun: 'indexes', scalar: (i) => i === 1 },
  column: { noun: 'indexes', scalar: (i) => i === 1 },
  sum: DIMENSION,
  max: DIMENSION,
  min: DIMENSION,
  mean: DIMENSION,
  median: DIMENSION,
  prod: DIMENSION,
  std: DIMENSION,
  variance: DIMENSION,
  cumsum: DIMENSION,
  // concat's dimension is its last argument, after at least one matrix; every other
  // argument is an Array or Matrix, so a scalar Fraction past the first is the
  // dimension. The typed function takes it inside a rest parameter
  // (`...Array|Matrix|number|BigNumber`), which cannot gain a trailing-Fraction
  // counterpart, so only the expression transform — the path expressions call —
  // converts it; `i > 0` keeps position 0 of that rest signature unchanged.
  concat: { noun: 'dimensions', scalar: (i) => i > 0 },
};

/**
 * Functions that take an index or a dimension, rebuilt on a Fraction instance
 * only; their arguments are converted but not size-checked. `concat` is missing
 * because it is size-guarded on every instance, which converts it too.
 */
const FRACTION_WHOLE_NUMBER_FUNCTIONS = [
  'index',
  'row',
  'column',
  'sum',
  'max',
  'min',
  'mean',
  'median',
  'prod',
  'std',
  'variance',
  'cumsum',
] as const;

/** A whole-number Fraction as a number; a non-integer one is rejected with a clear message. */
function wholeNumber(fn: string, noun: WholeNumberArgs['noun'], value: unknown): unknown {
  if (!isFraction(value)) return value;
  const fraction = value as unknown as { d: bigint | number; toFraction(): string };
  if (Number(fraction.d) !== 1) {
    throw new Error(`${fn}() needs whole-number ${noun}; got ${fraction.toFraction()}.`);
  }
  return Number(value.valueOf());
}

/** Convert the whole-number Fractions in a (spread-out) argument list to numbers. */
function toWholeNumberArgs(fn: string, spec: WholeNumberArgs, args: unknown[]): unknown[] {
  if (spec.afterCollection && !Array.isArray(args[0]) && !isMatrix(args[0])) return args;
  const convert = (value: unknown) => wholeNumber(fn, spec.noun, value);
  return args.map((arg, i) => {
    if (spec.scalar?.(i) && isFraction(arg)) return convert(arg);
    if (!spec.vector?.(i)) return arg;
    if (Array.isArray(arg)) return arg.map(convert);
    if (isMatrix(arg)) {
      return (arg as unknown as { map(cb: (entry: unknown) => unknown): unknown }).map((entry) =>
        convert(entry),
      );
    }
    return arg;
  });
}

/**
 * The Fraction counterparts of a signature: each scalar size/count parameter that
 * accepts `number` accepts `Fraction` instead (`number,string` → `Fraction,string`).
 * A rest parameter must start with a Fraction and keeps its other types after it
 * (`...number|string` → `Fraction` and `Fraction,...Fraction|string`), so no
 * counterpart matches the same arguments as the original. Empty when nothing changes.
 */
function fractionSignatures(params: string[], spec: WholeNumberArgs): string[] {
  let changed = false;
  let restTail: string | undefined;
  const fixed = params.map((param, i) => {
    const rest = param.startsWith('...');
    const types = (rest ? param.slice(3) : param).split('|');
    if (!spec.scalar?.(i) || !types.includes('number')) return param;
    changed = true;
    if (rest)
      restTail = `...${types.map((type) => (type === 'number' ? 'Fraction' : type)).join('|')}`;
    return 'Fraction';
  });
  if (!changed) return [];
  const single = fixed.join(',');
  return restTail === undefined ? [single] : [single, `${single},${restTail}`];
}

/** Spread a rest parameter's array (at `restAt`) back into the argument list. */
function spreadRest(args: unknown[], restAt: number): unknown[] {
  return restAt < 0 ? args : [...args.slice(0, restAt), ...(args[restAt] as unknown[])];
}

/** Position of a signature's rest parameter, or -1. */
function restPosition(signature: string): number {
  return signature.split(',').findIndex((param) => param.startsWith('...'));
}

/**
 * Wrap a function with `guard`. A typed function is rebuilt from its signatures
 * (guarding those `selectSignature` picks) so it stays a typed function for
 * math.js's callback and dispatch machinery; a rest parameter (`...number`) is
 * spread out for the guard. A plain function gets a plain wrapper. When the
 * function has whole-number parameters, Fraction values there are converted to
 * numbers first, and each signature gains a Fraction counterpart. Without a
 * `guard`, the wrapper only converts.
 */
function guardFunction(
  typed: Typed,
  name: string,
  fn: Impl & { signatures?: Record<string, Impl> },
  guard: Guard | undefined,
  selectSignature: (signature: string) => boolean,
): Impl {
  const wholeArgs = WHOLE_NUMBER_ARGS[name];
  const prepare = (args: unknown[]) => {
    const prepared = wholeArgs ? toWholeNumberArgs(name, wholeArgs, args) : args;
    guard?.(prepared);
    return prepared;
  };
  if (!typed.isTypedFunction(fn) || !fn.signatures) {
    return (...args: unknown[]) => fn(...prepare(args));
  }
  const signatures: Record<string, Impl> = {};
  const variants: Record<string, Impl> = {};
  for (const [signature, impl] of Object.entries(fn.signatures)) {
    if (!selectSignature(signature)) {
      signatures[signature] = impl;
      continue;
    }
    const restAt = restPosition(signature);
    const gather = (flat: unknown[]) =>
      restAt < 0 ? flat : [...flat.slice(0, restAt), flat.slice(restAt)];
    // `inputRestAt` is where the calling signature's rest parameter sits; the
    // implementation always receives the arguments shaped for `signature`.
    const guardedFrom =
      (inputRestAt: number) =>
      (...args: unknown[]) =>
        impl(...gather(prepare(spreadRest(args, inputRestAt))));
    signatures[signature] = guardedFrom(restAt);
    for (const variant of wholeArgs ? fractionSignatures(signature.split(','), wholeArgs) : []) {
      if (!(variant in fn.signatures)) variants[variant] ??= guardedFrom(restPosition(variant));
    }
  }
  return typed(name, { ...signatures, ...variants });
}

/** A factory that builds `original`'s function and returns it wrapped by `wrap`. */
function wrappedFactory(original: MathFactory, wrap: (fn: Impl) => unknown): MathFactory {
  return factory(
    original.fn,
    original.dependencies as never,
    (deps) => wrap(original(deps as Record<string, unknown>) as Impl),
    original.meta,
  ) as MathFactory;
}

/**
 * Wrap a lazy transform. It is handed shims for its broadcasting operands that
 * record each value and, once the last is evaluated, check the broadcast shape
 * before the transform combines them — the transform keeps its evaluation and
 * short-circuit order, and the remaining arguments (a callback) pass unchanged.
 */
function guardLazyTransform(
  name: string,
  original: RawArgsFn,
  operandCount: (args: unknown[]) => number,
): RawArgsFn {
  const guarded: RawArgsFn = (args, math, scope) => {
    const count = operandCount(args);
    if (count < 2 || args.length < count) return original(args, math, scope);
    const values: unknown[] = [];
    const shims = args.slice(0, count).map(
      (operand, i): RawNode => ({
        compile: () => ({
          evaluate: (s) => {
            values[i] = operand.compile().evaluate(s);
            if (i === count - 1) assertFoldedShape(name, values, broadcastShape);
            return values[i];
          },
        }),
      }),
    );
    return original([...shims, ...args.slice(count)], math, scope);
  };
  guarded.rawArgs = true;
  return guarded;
}

/** Check a matrix growing from `current` to `grown` elements, charging only the added ones. */
function assertGrowth(fn: string, current: number, grown: number): void {
  assertElements(fn, grown, Math.max(0, grown - current));
}

/**
 * Guard the matrix methods that read or grow a matrix by index — `resize(size)`,
 * `subset(index)` (indexed reads, `A[i, j]`, whose index vectors multiply:
 * `A[ones(1e4), ones(1e4)]` reads 1e8 elements), `subset(index, replacement)`
 * (indexed assignment, `A[i, j] = v`, which grows the matrix to fit), and
 * `set(index, value)` — on one matrix class. Classes are per math.js instance,
 * so each is wrapped once.
 */
function guardMatrixMethods(matrixClass: MatrixClass, className: string): void {
  const proto = matrixClass.prototype;
  const { resize, subset, set } = proto as Record<'resize' | 'subset' | 'set', Impl>;
  proto.resize = function (this: MatrixLike, ...args: unknown[]) {
    assertGrowth(`${className}.resize`, countOf(this.size()), sizeProduct(args[0]));
    return resize.apply(this, args);
  };
  proto.subset = function (this: MatrixLike, ...args: unknown[]) {
    const index = args[0] as { max?: () => unknown[]; size?: () => Shape } | undefined;
    if (args.length > 1 && typeof index?.max === 'function') {
      const current = this.size();
      const grown = grownShape(current, index.max().map(toNumber));
      assertGrowth('subset', countOf(current), countOf(grown));
    } else if (typeof index?.size === 'function') {
      // The node returning the read value charges it.
      assertElements('subset', countOf(index.size()), 0);
    }
    return subset.apply(this, args);
  };
  proto.set = function (this: MatrixLike, ...args: unknown[]) {
    if (Array.isArray(args[0])) {
      const size = this.size();
      const index = args[0].map(toNumber);
      if (index.some((i, d) => i >= (size[d] ?? 1))) {
        assertGrowth(`${className}.set`, countOf(size), countOf(grownShape(size, index)));
      }
    }
    return set.apply(this, args);
  };
}

/** math.js factory names that are not the function name capitalized (`createCumSum`). */
const FACTORY_BASE_NAMES: Record<string, string> = { cumsum: 'CumSum' };

/**
 * Install the size guards on a math.js instance. Must run before the instance's
 * `import` is disabled; `mathImport` is the captured original and `factories` is
 * the factory map the instance was created from. Functions are re-imported as
 * lazy factories, so nothing is instantiated until an expression first uses it.
 * On a Fraction instance, the index and dimension functions are rebuilt too, to
 * accept whole-number Fraction indexes and dimensions.
 */
export function installSizeGuards(
  math: MathJsInstance,
  mathImport: MathJsInstance['import'],
  factories: Record<string, unknown>,
): void {
  const typed = math.typed as unknown as Typed;
  const transformNamespace = (math as unknown as { expression: { transform: object } }).expression
    .transform as Record<string, unknown>;
  const factoryFor = (name: string, suffix = '') => {
    const base = FACTORY_BASE_NAMES[name] ?? `${name[0]?.toUpperCase()}${name.slice(1)}`;
    const found = factories[`create${base}${suffix}`] as MathFactory | undefined;
    if (!found) throw new Error(`No math.js factory create${base}${suffix} for "${name}".`);
    return found;
  };

  const functionFactories: MathFactory[] = [];
  const transformFactories: MathFactory[] = [];
  const addGuard = (
    name: string,
    guard: Guard | undefined,
    select: (signature: string) => boolean,
  ) => {
    const wrap = (fn: Impl) => guardFunction(typed, name, fn, guard, select);
    functionFactories.push(wrappedFactory(factoryFor(name), wrap));
    // Overriding a function drops its expression transform; re-install it guarded
    // too. Clearing the transform first keeps the import lazy — importing over an
    // existing transform makes math.js resolve the new function immediately.
    if (name in transformNamespace) {
      delete transformNamespace[name];
      transformFactories.push(wrappedFactory(factoryFor(name, 'Transform'), wrap));
    }
  };

  const selectAll = () => true;
  const selectCollections = (signature: string) => COLLECTION_SIGNATURE.test(signature);
  for (const [name, guard] of Object.entries(SIZE_GUARDS)) {
    addGuard(name, guard, name === 'multiply' ? selectCollections : selectAll);
  }
  for (const name of BROADCASTING_FUNCTIONS) {
    addGuard(name, (args) => assertFoldedShape(name, args, broadcastShape), selectCollections);
  }
  // An empty options object reads the config without changing it.
  if (math.config({}).number === 'Fraction') {
    for (const name of FRACTION_WHOLE_NUMBER_FUNCTIONS) addGuard(name, undefined, selectAll);
  }
  for (const [name, operandCount] of Object.entries(LAZY_BROADCASTING_TRANSFORMS)) {
    // Importing over an existing transform deletes it rather than replacing it, so clear it first.
    delete transformNamespace[name];
    transformFactories.push(
      wrappedFactory(factoryFor(name, 'Transform'), (fn) =>
        guardLazyTransform(name, fn as unknown as RawArgsFn, operandCount),
      ),
    );
  }

  mathImport(functionFactories as never, { override: true });
  mathImport(transformFactories as never, { override: true });

  const classes = math as unknown as Record<'DenseMatrix' | 'SparseMatrix', MatrixClass>;
  guardMatrixMethods(classes.DenseMatrix, 'DenseMatrix');
  guardMatrixMethods(classes.SparseMatrix, 'SparseMatrix');
}
