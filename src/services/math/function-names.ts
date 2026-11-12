/**
 * @fileoverview Function names an expression may call beyond math.js's own
 * spellings. Synonyms from standard notation and other ecosystems (`ln`,
 * `arcsin`, `avg`, `nCr`, `eig`, `integral`, …) are renamed on the parse tree to
 * the function they stand for, so a call runs exactly what the canonical call
 * runs — its expression transform (one-based dimensions), the instance's guards
 * and exact Fraction functions, and symbolic `derivative`'s rule table. The
 * statistics and combinatorics synonyms are also bound as values, for a caller
 * that passes one by name (`mapSlices(A, 1, avg)`). `eigenvalues(A)` is a function
 * of its own, and a call to `roots` or `solve`, solver names math.js lacks, is
 * answered with the functions that solve those problems.
 * @module services/math/function-names
 */

import { type McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { factory, type MathJsInstance } from 'mathjs';

/**
 * Synonyms renamed on a call and bound as values, keyed by synonym. As a value,
 * each resolves to what its canonical name resolves to in an expression,
 * transform included, so `f = avg` reads dimensions as `mean` does.
 */
const VALUE_ALIASES: Readonly<Record<string, string>> = {
  average: 'mean',
  avg: 'mean',
  stdev: 'std',
  stddev: 'std',
  permute: 'permutations',
  nPr: 'permutations',
  choose: 'combinations',
  nCr: 'combinations',
  length: 'count',
  len: 'count',
};

/**
 * Synonyms renamed on a call only: natural log `ln` and the inverse-trig `arc*`
 * family (standard notation), `eig` (MATLAB), and `integral`. None is a name a
 * caller needs as a value — `integrate` cannot be passed as one.
 */
const CALL_ALIASES: Readonly<Record<string, string>> = {
  ln: 'log',
  ...Object.fromEntries(
    ['sin', 'cos', 'tan', 'sec', 'csc', 'cot'].flatMap((fn) => [
      [`arc${fn}`, `a${fn}`],
      [`arc${fn}h`, `a${fn}h`],
    ]),
  ),
  eig: 'eigs',
  integral: 'integrate',
};

/** Every synonym a call is renamed from, to the math.js function it stands for. */
const CALLEE_ALIASES: ReadonlyMap<string, string> = new Map([
  ...Object.entries(VALUE_ALIASES),
  ...Object.entries(CALL_ALIASES),
]);

/** The function a called name stands for, when the name is a synonym. */
export function canonicalName(name: string): string | undefined {
  return CALLEE_ALIASES.get(name);
}

/**
 * Bind the {@link VALUE_ALIASES} as values and add `eigenvalues(A)` — the
 * eigenvalues `eigs(A)` returns — on one math.js instance. Both are lazy
 * factories, resolved on first use against the instance's final functions, so
 * this may run anywhere before the instance's `import` is disabled.
 */
export function installFunctionNames(mathImport: MathJsInstance['import']): void {
  // math.js resolves the `mathWithTransform` dependency specially; its typings omit it.
  const transformFactory = factory as unknown as (
    name: string,
    dependencies: readonly ['mathWithTransform'],
    create: (injected: { mathWithTransform: Record<string, unknown> }) => unknown,
  ) => unknown;
  const valueAliases = Object.entries(VALUE_ALIASES).map(([alias, canonical]) =>
    transformFactory(
      alias,
      ['mathWithTransform'],
      ({ mathWithTransform }) => mathWithTransform[canonical],
    ),
  );
  const eigenvalues = factory(
    'eigenvalues',
    ['typed', 'eigs'],
    ({ typed, eigs }: { typed: MathJsInstance['typed']; eigs: MathJsInstance['eigs'] }) =>
      typed('eigenvalues', {
        'Array | Matrix': (matrix: Parameters<MathJsInstance['eigs']>[0]) => eigs(matrix).values,
      }),
  );
  mathImport([...valueAliases, eigenvalues] as never);
}

/** Solver names math.js does not define, answered with {@link SOLVER_ROUTE}. */
const ROUTED_FUNCTIONS = new Set(['roots', 'solve']);

/** Whether a called name is one {@link routedCall} answers. */
export function isRoutedFunction(name: string): boolean {
  return ROUTED_FUNCTIONS.has(name);
}

/**
 * The functions that answer a `roots` or `solve` call, with results measured in
 * numericType "number" (`polynomialRoot` returns its distinct roots unsorted).
 * The same route answers every operation, and the results it quotes are operation
 * "evaluate"'s — under simplify `polynomialRoot` fails, and under derivative it
 * differentiates to 0 — so it names that operation.
 */
const SOLVER_ROUTE =
  'For a polynomial of degree 3 or less, pass its coefficients constant term first: 2*x^2 - 4*x + 1 → polynomialRoot(1, -4, 2) → [1.7071067811865475, 0.2928932188134524]. For a linear system A·x = b, use lusolve(A, b): lusolve([3, 2; 1, -1], [12; 1]) → [[2.7999999999999994], [1.8000000000000003]]. Run either with operation "evaluate".';

/** The code {@link SOLVER_ROUTE} quotes, rendered as code spans in `content[]`. */
const SOLVER_ROUTE_LITERALS = [
  '2*x^2 - 4*x + 1',
  'polynomialRoot(1, -4, 2)',
  '[1.7071067811865475, 0.2928932188134524]',
  'lusolve(A, b)',
  'lusolve([3, 2; 1, -1], [12; 1])',
  '[[2.7999999999999994], [1.8000000000000003]]',
];

/** A call to a routed name, `roots(` or `solve(`, as written in the caller's text. */
const ROUTED_CALL_TEXT = /\b(?:roots|solve)\s*\(/;

/** Whether the text calls `roots` or `solve` — also inside a string literal, where the route is harmless. */
export function callsRoutedFunction(text: string): boolean {
  return ROUTED_CALL_TEXT.test(text);
}

/**
 * `parse_failed` for a parsed call to `roots` or `solve`, or for a parse failure
 * of text that calls one (`solve([3*x+2*y=12, x-y=1], [x, y])`, where `=` is
 * assignment): `failure` is the parse message, the route follows it, and the route
 * is the recovery hint in place of the contract's syntax hint.
 */
export function routedCall(failure: string): McpError {
  return validationError(
    `Invalid expression: ${failure}. ${SOLVER_ROUTE}`,
    { reason: 'parse_failed', recovery: { hint: SOLVER_ROUTE } },
    { literals: SOLVER_ROUTE_LITERALS },
  );
}
