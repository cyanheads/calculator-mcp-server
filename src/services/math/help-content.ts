/**
 * @fileoverview The `calculator://help` reference text: operators, constants,
 * functions, units, limits, and syntax examples, each with its exact result.
 * @module services/math/help-content
 */

import { MAX_BERNOULLI_INDEX, MAX_STIRLING_N } from './size-guard.js';

/** The help reference as Markdown, served by `MathService.getHelpContent`. */
export const HELP_CONTENT = `# Calculator Help

## Operators

| Operator | Description | Example |
|:---------|:------------|:--------|
| + | Addition | 2 + 3 |
| - or − | Subtraction | 5 - 2 |
| * or × | Multiplication (× takes scalars only) | 3 * 4 |
| / or ÷ | Division | 10 / 3 |
| ^ or ** | Exponentiation (** takes scalars only) | 2 ^ 10 |
| % | Modulus | 17 % 5 |
| ! | Factorial | 5! |
| .* ./ .^ | Element-wise multiplication, division, power | [1, 2] .* [3, 4] |

> **Standard notation accepted:** outside string literals and \`#\` comments, \`**\` reads as \`^\`, \`×\` as \`*\`, \`÷\` as \`/\`, \`−\` (U+2212) as \`-\`, and \`°\`, \`°C\`, \`°F\` as \`deg\`, \`degC\`, \`degF\`, in every operation: \`2 ** 10\` => \`1024\`, \`6 × 7\` => \`42\`, \`8 ÷ 2\` => \`4\`, \`5 − 3\` => \`2\`, \`sin(30°)\` => \`0.49999999999999994\`, \`30°C to °F\` => \`86 degF\`. \`×\` and \`÷\` are operators even between letters (\`x×y\` is \`x*y\`). A \`°\` before a letter or digit is not read, so \`30°N\` fails with \`parse_failed\`.

On vectors and matrices, \`*\` is the dot or matrix product and \`^\` the matrix power: \`[1, 2; 3, 4] ^ 2\` => \`[[7, 10], [15, 22]]\`, while \`[1, 2; 3, 4] .^ 2\` => \`[[1, 4], [9, 16]]\`. \`×\` and \`**\` take scalars only, so \`[1, 2; 3, 4] ** 2\` and \`[1, 0, 0] × [0, 1, 0]\` fail with \`type_mismatch\`; for the cross product, \`cross([1, 0, 0], [0, 1, 0])\` => \`[0, 0, 1]\`.

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

A dimension argument after a matrix is one-based, for the aliases too: \`mean([1, 2; 3, 4], 1)\` => \`[2, 3]\` (down each column), \`avg([1, 2; 3, 4], 2)\` => \`[1.5, 3.5]\` (along each row). A normalization can follow the dimension: \`std([1, 2; 3, 4], 1, "uncorrected")\` => \`[1, 1]\`.

- \`mad\` is the unscaled median absolute deviation (no 1.4826 factor): \`mad([1, 2, 3, 4, 100])\` => \`1\`
- \`quantileSeq\` interpolates linearly: \`quantileSeq([1, 2, 3, 4], 0.25)\` => \`1.75\`. A third argument \`true\` declares the data already sorted and skips sorting, so unsorted data then gives a wrong answer: \`quantileSeq([4, 3, 2, 1], 0.25, true)\` => \`3.25\`
- \`mode\` always returns an array, even with a single mode: \`mode([1, 2, 2, 3])\` => \`[2]\`

### Matrix
det, inv, transpose, trace, zeros, ones, identity, diag, size, reshape, flatten, concat, sort, cross, dot, eigs (aliases: eig), eigenvalues, lusolve, expm, sqrtm, kron, pinv, range

\`eigenvalues(A)\` is \`eigs(A).values\`: \`eigenvalues([2, 1; 1, 2])\` => \`[1, 3]\`. \`lusolve(A, b)\` solves the linear system A·x = b: \`lusolve([3, 2; 1, -1], [12; 1])\` => \`[[2.7999999999999994], [1.8000000000000003]]\`, or under numericType \`"Fraction"\`, \`lusolve([3, 2; 1, -1], [12; 1])\` => \`[[14/5], [9/5]]\`.

### Polynomial Roots
polynomialRoot

\`polynomialRoot\` takes a polynomial's coefficients constant term first, degree 3 or less, and returns its distinct roots, unsorted, as 64-bit floats under every numericType. For x^2 - 6x + 8, \`polynomialRoot(8, -6, 1)\` => \`[4, 2]\`; for x^3 - 6x^2 + 11x - 6, \`polynomialRoot(-6, 11, -6, 1)\` => \`[1, 3, 2]\`; a repeated root appears once, \`polynomialRoot(1, -2, 1)\` => \`[1]\`. A degree above 3 fails with \`evaluation_failed\`: \`polynomialRoot(1, 2, 3, 4, 5)\`. There is no \`roots\` or \`solve\` function: a call to either fails with \`parse_failed\`, naming \`polynomialRoot\` and \`lusolve\`.

### Combinatorics
factorial, gamma, permutations (aliases: permute, nPr), combinations (aliases: choose, nCr), catalan, bellNumbers, stirlingS2, bernoulli, composition, multinomial

Under numericType \`"Fraction"\`, factorial, gamma at a positive integer, permutations, combinations, catalan, composition, and multinomial return exact integers: \`50!\` => \`30414093201713378043612608166064768844377641568960512000000000000/1\`, \`combinations(10, 3)\` => \`120/1\`. Invalid arguments fail as they do under \`"number"\`.

### Dates
dateDiff, dateAdd, weekday, isoWeek, daysInMonth

A date is a quoted string in exactly \`YYYY-MM-DD\` form, years 0000–9999, on the proleptic Gregorian calendar with no time zones. An unquoted date is subtraction: \`2026-10-26\` => \`1990\`. The calculator reads no clock, so \`now()\` and \`today()\` fail with \`parse_failed\`; pass the date as a string. \`unit\` is \`"days"\` (default), \`"weeks"\`, \`"months"\`, or \`"years"\`, in any case, singular or plural.

- \`dateDiff(start, end, unit)\` counts whole units: the largest m with \`dateAdd(start, m, unit)\` on or before \`end\`, negated when \`end\` is earlier. \`dateDiff("2026-10-17", "2026-10-31")\` => \`14\`, \`dateDiff("2026-10-31", "2026-10-17")\` => \`-14\`, \`dateDiff("2026-01-31", "2026-02-28", "months")\` => \`1\`, \`dateDiff("1990-05-17", "2026-05-16", "years")\` => \`35\`. For a fraction of a week, divide the days: \`dateDiff("2026-10-17", "2026-10-27", "weeks")\` => \`1\`, \`dateDiff("2026-10-17", "2026-10-27") / 7\` => \`1.4285714285714286\`.
- \`dateAdd(date, count, unit)\` shifts by a whole count; month and year steps clamp to the end of the month: \`dateAdd("2026-10-24", 30)\` => \`"2026-11-23"\`, \`dateAdd("2026-10-24", 2, "weeks")\` => \`"2026-11-07"\`, \`dateAdd("2026-01-31", 1, "months")\` => \`"2026-02-28"\`, \`dateAdd("2024-02-29", 1, "years")\` => \`"2025-02-28"\`.
- \`weekday(date)\` names the day: \`weekday("2026-10-26")\` => \`"Monday"\`, \`map(["2026-10-26", "2026-10-27"], weekday)\` => \`["Monday", "Tuesday"]\`.
- \`isoWeek(date)\` is the ISO 8601 week number, whose year can differ from the date's near New Year: \`isoWeek("2026-10-26")\` => \`44\`, \`isoWeek("2027-01-01")\` => \`53\` (week 53 of 2026).
- \`daysInMonth(year, month)\`: \`daysInMonth(2024, 2)\` => \`29\`.

These are calendar months and years, unlike math.js units, where \`1 month to days\` => \`30.4375 days\` and \`1 year to days\` => \`365.25 days\`. Numeric results are plain integers under every numericType.

### Integrals
integrate (aliases: integral)

\`integrate(f, x, a, b)\` estimates the definite integral of \`f\` over \`x\` from \`a\` to \`b\` with adaptive Gauss–Kronrod quadrature (G7K15), stopping once the error estimate is at most 1e-10 × ∫|f|, in at most 500 subintervals. \`x\` is a bare variable name, the bounds are finite, and \`a > b\` negates the result. It runs under numericType \`"number"\` only.

- \`integrate(exp(-x^2), x, 0, 1)\` => \`0.746824132812427\`; with \`precision: 12\`, \`integrate(exp(-x^2), x, 0, 1)\` => \`0.746824132812\`
- \`integral(sin(x), x, 0, pi)\` => \`2\`; with \`precision: 15\`, \`integrate(1/x, x, 1, e)\` => \`1\`
- Other variables come from scope: with scope \`{ "a": 2 }\`, \`integrate(a*x^2, x, 0, 3)\` => \`18\`
- Reversed bounds: with \`precision: 15\`, \`integrate(x^2, x, 1, 0)\` => \`-0.333333333333333\`
- Nested and inside larger expressions: \`integrate(integrate(x*y, y, 0, 1), x, 0, 1)\` => \`0.25\`; with \`precision: 12\`, \`log10(integrate(exp(-x^2), x, 0, 1))\` => \`-0.126781656741\`
- An integrable singularity at a bound: with \`precision: 9\`, \`integrate(1/sqrt(x), x, 0, 1)\` => \`2\`

The result is an estimate, and a feature narrower than the sample spacing can be missed: \`integrate(exp(-1e6 (x - 0.5)^2), x, -1000, 1000)\` => \`0\`, while over the interval around the peak, with \`precision: 6\`, \`integrate(exp(-1e6 (x - 0.5)^2), x, 0, 1)\` => \`0.00177245\`. A singularity inside the interval or a divergent integral fails with \`evaluation_failed\`: \`integrate(1/x, x, -1, 1)\` (a non-finite sample at x = 0), \`integrate(1/x, x, 0, 1)\` (no convergence within 500 subintervals). Under numericType \`"Fraction"\` it fails with \`fraction_unsupported\` and under \`"BigNumber"\` with \`evaluation_failed\`, both with a hint to retry with \`"number"\`.

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

## Limits

Past each of these limits a call fails with \`result_too_large\` before it computes.

- A function that builds a matrix, range, or string builds at most 1,000,000 elements or characters per call. A range counts the elements it would build, by step direction and the optional end flag: \`range(1, 2000000)\` fails, \`range(2000000, 1)\` => \`[]\`, \`count(range(1, 1000001, false))\` => \`1000000\`. A zero step fails with \`evaluation_failed\`: \`range(1, 2, 0)\`.
- Under numericType \`"Fraction"\`, a factorial, binomial, or power whose result would pass 1,000,000 digits (numerator and denominator together) fails: \`300000!\`, \`2^(10^7)\`. \`10000! / 9999!\` => \`10000/1\`. A result under that limit can still pass the result length limit (100,000 characters by default): \`2^(10^6)\` fails with \`result_too_large\` too.
- \`stirlingS2(n, k)\` and \`bellNumbers(n)\` take n up to ${MAX_STIRLING_N.number.toLocaleString('en-US')}, or ${MAX_STIRLING_N.BigNumber} when an argument is a BigNumber: \`stirlingS2(1413, 3)\` fails.
- \`bernoulli(n)\` takes an even n up to ${MAX_BERNOULLI_INDEX.toLocaleString('en-US')}: \`bernoulli(1002)\` fails. An odd n above 1 returns 0: \`bernoulli(1001)\` => \`0\`.

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

Scope values take the selected numericType. \`"BigNumber"\` reads each value from its shortest decimal form: with scope \`{ "x": 1e16, "y": 1 }\`, \`(x + y) - x\` => \`1\`. \`"Fraction"\` reads it as the matching decimal literal: with scope \`{ "x": 0.1 }\`, \`x * 3\` => \`3/10\`. JSON has already rounded a number past about 17 significant digits (\`12345678901234567890\` arrives as \`12345678901234567000\`), so write a longer number in the expression instead.

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
  - \`"BigNumber"\`: decimal with 64 significant digits and decimal exponents up to 9e15; slower than \`"number"\`. Use it when a value overflows the float range: with \`numericType: "BigNumber"\`, \`2^2000\` => \`1.148130695274254524232833201177681984022317702088695200477642737e+602\`. Results are 64-digit approximations, not exact: \`10000! / 9999!\` => \`9999.999999999999999999999999999999999999999999999999999999999996\`, and adding \`precision: 16\` rounds it, \`10000! / 9999!\` => \`10000\`. A value past a decimal exponent of 9e15 still overflows: \`exp(1e17)\` fails with \`undefined_result\`. Under BigNumber, \`erf\`, \`lgamma\`, and \`zeta\` have no implementation and \`gamma\` and \`!\` take only integers (\`gamma(0.5)\` fails), and an inverse trig or hyperbolic function outside its real domain fails with \`undefined_result\` (\`asin(2)\`, \`acosh(0.5)\`), where \`"number"\` returns a complex value; use \`"number"\` for those.
  - \`"Fraction"\`: exact rational arithmetic — \`0.1 + 0.2\` => \`3/10\`, \`1/3 + 1/6\` => \`1/2\`. Integer combinatorics (see Combinatorics), integer powers, and roots and fractional powers whose value is rational are exact: \`5!\` => \`120/1\`, \`sqrt(9/4)\` => \`3/2\`, \`cbrt(-8)\` => \`-2/1\`, \`(9/4)^(3/2)\` => \`27/8\`, \`(-2/3)^(-3)\` => \`-27/8\`, \`[4, 9/4] .^ (1/2)\` => \`[2/1, 3/2]\`, \`((2^61-1)^2)^(1/2)\` => \`2305843009213693951/1\`, \`sqrtm([4, 0; 0, 9])\` => \`[[2/1, 0/1], [0/1, 3/1]]\`. Powers and roots of a complex value with integer parts are exact when the result's parts are integers too: \`(1+2i)^2\` => \`-3 + 4i\`, \`sqrt(5+12i)\` => \`3 + 2i\`, \`cbrt(2+11i)\` => \`2 + i\`; one that cannot be verified exact fails with \`fraction_unsupported\`. An expression fails with \`fraction_unsupported\` when its result has no exact rational value (\`sqrt(2)\`, \`2^(1/2)\`, \`(-8)^(1/3)\`, \`sin(1)\`, \`log(3)\`), when it calls a function Fraction mode cannot compute, even for a rational result (\`log2(8)\`, \`stirlingS2(5, 2)\`), or when it uses a value Fraction mode holds only as a rounded 64-bit float (\`pi\`, \`e\`, \`sin(pi)\`, a complex number with a non-integer part, \`number(x)\`, or \`random()\`); use \`"number"\` or \`"BigNumber"\` for those. A unit conversion with an irrational factor returns a close rational approximation, not an exact value: \`30 deg to rad\` => \`191068/364913 rad\`. Whole-number indexes and dimensions work as in \`"number"\`: \`[1, 2, 3][2]\` => \`2/1\`, \`sum([1, 2; 3, 4], 1)\` => \`[4/1, 6/1]\`.

  Under \`"number"\`, an \`undefined_result\` caused by overflow (large powers, factorials, \`exp\`) can be retried with \`numericType: "BigNumber"\`. Division by zero, \`0/0\`, and \`log(0)\` are undefined in every numeric type, and BigNumber does not change that.

- **simplify**: Reduce an algebraic expression symbolically: \`2x + 3x\` => \`5 * x\`, \`sin(x)^2 + cos(x)^2\` => \`1\`. Supports algebraic rules and common trigonometric identities (Pythagorean, double-angle, tan/sec/csc/cot relationships). \`scope\`, \`precision\`, and \`numericType\` are ignored.

  **Known limits:** The built-in simplifier does not perform polynomial factoring or rational cancellation: \`(x^2 - 1) / (x - 1)\` => \`(x ^ 2 - 1) / (x - 1)\`, returned with \`unchanged: true\`. For these cases, rewrite by hand or use \`evaluate\` with a numeric scope.

- **derivative**: Compute a symbolic derivative; requires the \`variable\` parameter. With \`variable: "x"\`, \`x^2\` => \`2 * x\` and \`3*x**2 + 5*x\` => \`6 * x + 5\`. \`scope\`, \`precision\`, and \`numericType\` are ignored.
`;
