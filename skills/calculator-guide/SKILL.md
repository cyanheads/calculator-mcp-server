---
name: calculator-guide
description: Gates and recipes for the calculate tool. Which numericType answers which question, what a result does not prove (integer-looking floats, tolerance-based ==, lusolve on a singular matrix, a simplify that stops short of 0), and workflows for derivative and identity checks, business-day deadlines, statistics by dimension, unit chains, and integral tails. Use before relying on or reporting a calculate result.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Reach for `calculate` before stating any number you did not copy from a source. It has none of these:

- Symbolic integration: `integrate` is numeric.
- A nonlinear equation solver. Tabulate to bracket a root instead: `map(0:0.1:1, f(x) = x - cos(x))` changes sign between 0.7 (`-0.06484218728448854`) and 0.8 (`0.10329329065283444`).
- Probability distribution functions: `normcdf(1.96)` and `erfinv(0.95)` fail with `parse_failed`. The normal CDF is `0.5 * (1 + erf(1.96 / sqrt(2)))` → `0.9750021048517796`; there is no inverse.
- Finance functions: write the closed form. `300000 * (0.065/12) / (1 - (1 + 0.065/12)^(-360))` → `1896.2040704788958`.
- Currency (`5 USD to EUR` fails with `parse_failed`), business-day or holiday calendars (see Dates and deadlines), and time of day.
- These units, which fail with `parse_failed`: `kcal`, `cal`, `au`, `parsec`, `rpm`, `nauticalmile`, `ukgallon`, `tbsp`. Write `tablespoon`: `1 tablespoon to mL` → `15.000000000000002 mL`.

Physical constants evaluate as units: `speedOfLight` → `299792458 m / s`, `elementaryCharge` → `1.602176634e-19 C`, and `planckConstant`, `avogadro`, `gravitationConstant`.

## Choosing numericType

| Question | numericType | Measured |
|:---------|:------------|:---------|
| An exact integer: a count, binomial, factorial, power, or remainder | `"Fraction"`, then drop the `/1` | `nCr(100, 50)` → `100891344545564193334812497256/1`. Under `"BigNumber"` the same digits print as `1.00891344545564193334812497256e+29` |
| An exact probability or ratio | `"Fraction"` | `3744 / combinations(52, 5)` → `6/4165`. `round(x, n)` fails under it with `fraction_unsupported`; for the decimal, rerun under `"BigNumber"` with `precision: 10`: `6/4165` → `0.00144057623` |
| Money: payments, interest, totals | `"number"`, rounded with `round(x, 2)` | `precision` counts significant digits, not decimal places: `382633.47` with `precision: 4` → `382600`. Under `"Fraction"` the 360-period payment above is an exact fraction thousands of digits long |
| A value past float range, or more digits than a float holds | `"BigNumber"` with `precision` | `1 - permutations(365, 23) / 365^23` with `precision: 10` → `0.5072972343` |

## Gates

- **Treat an integer-looking `"number"` result as approximate.** It can be wrong with no error:
  - `catalan(30)` → `3814986502092305`; under `"Fraction"` it is `3814986502092304/1`.
  - `mod(2^100, 7)` → `0`; under `"Fraction"` it is `2/1`.
  - `2^64` → `18446744073709552000`.

  Rerun under `"Fraction"` before stating an exact integer.
- **Never read `==` or `equal` as proof of equality.** Under `"number"` and `"BigNumber"` they compare within a tolerance: `1 + 1e-13 == 1` → `true`, `1e-20 == 2e-20` → `true`. Evaluate the difference instead: `(1 + 1e-13) - 1` → `9.992007221626409e-14`. Or compare rational inputs under `"Fraction"`, where `1 + 1e-13 == 1` → `false`.
- **Don't read a simplify that stops short of `0` as proof two expressions differ.** `unchanged: false` doesn't mean the simplifier finished: `(a+b)^2 - (a^2 + 2a*b + b^2)` → `(a + b) ^ 2 - 2 * a * b - (a ^ 2 + b ^ 2)` with `unchanged: false`. Evaluate the difference at two or three points other than 0 and 1:
  - Under `"Fraction"` with rational scope values the check is exact: scope `{ "a": 3, "b": 7 }` → `0/1`. Any nonzero value there proves the expressions differ.
  - Under `"number"` expect rounding noise: scope `{ "a": 1.7, "b": -2.3 }` → `3.885780586188048e-16`.
- **Check `det` under `"Fraction"` before calling a `lusolve` solution unique.** A singular system that has solutions returns one of them, with the free variables set to 0 and no error: `lusolve([1, 2; 2, 4], [3; 6])` → `[[3], [0]]`, while `det([1, 2; 2, 4])` under `"Fraction"` → `0/1`. Confirm a solution by back-substitution: `[2, 1; 1, 3] * lusolve([2, 1; 1, 3], [3; 5]) - [3; 5]` → `[[0], [-8.881784197001252e-16]]`.
- **Report a sample standard deviation or variance only for two or more values.** `std([5])` → `0` and `variance([5])` → `0`, though the n − 1 statistic is undefined for one value.
- **Convert a temperature difference unitless.** A `degC` or `degF` value converts as a reading: `(30 degC - 20 degC) to degF` → `50 degF`. A 10 °C difference is 18 °F: `(30 - 20) * 9/5` → `18`.
- **Past six significant digits, check the unit definition.** `1 acre to ft^2` → `43560.0385089659 ft^2` (the acre is defined as 43,560 ft²); `1 eV to J` → `1.602176565e-19 J`, so use `elementaryCharge` for the SI value; `1 mmHg to Pa` → `133.322 Pa`; `ton` is the US short ton (`1 ton to kg` → `907.18474 kg`; metric is `tonne`).
- **Bound the tail before quoting an integral over an infinite range.** A finite cutoff drops the tail:
  - `integrate(1/(1+x^2), x, 0, 1e6)` → `1.570795326794897`, against `pi/2` → `1.5707963267948966`.
  - `integrate(sin(x)/x, x, 0, 100)` → `1.5622254668890563`.

  Compare two cutoffs, or bound the remainder analytically. Split the range at a kink: `integrate(abs(x - 0.3), x, 0, 1)` → `0.28999999999751536`, while `integrate(abs(x-0.3),x,0,0.3)+integrate(abs(x-0.3),x,0.3,1)` → `0.29000000000000004`.
- **Write the expression math.js reads, not the one you mean.**
  - `1/2x` is (1/2)·x: with scope `{ "x": 4 }` it returns `2`. Parenthesize a denominator: `1/(2x)`.
  - `log` is the natural log: `log(100)` → `4.605170185988092`. For base 10 use `log10(100)` → `2`.
  - Trig functions take radians: `sin(30)` → `-0.9880316240928618`, `sin(30 deg)` → `0.49999999999999994`. To read an angle in degrees, `unit(atan(1), "rad") to deg` → `45 deg`; `atan(1) to deg` fails with `type_mismatch`.
  - `(-8)^(1/3)` is the principal complex root `1 + 1.732050807568877i`. The real cube root is `cbrt(-8)` → `-2`.
  - `%` after a number is a percentage (`80 + 15%` → `92`). Between two operands it is a floored modulus (`-7 % 3` → `2`). Write `mod(a, b)` or `/100` to say which you mean.

## Workflows

### Derivatives and antiderivatives

`derivative` ignores scope. To get f′(a), send the returned string back under `evaluate` with scope. For example, `x^2 * sin(x)` → `2 * x * sin(x) + x ^ 2 * cos(x)`, which at scope `{ "x": 1.3 }` → `2.9573243024602545`; a central difference with h = 1e-6 gives `2.957324302221842`.

- Check a hand-derived derivative against the tool's result with the simplify gate above.
- Check an antiderivative F of f by differentiating F and comparing the result with f the same way, or by comparing F(b) − F(a) with `integrate`.
- `floor`, `max`, and `integrate` have no derivative rule and fail with `evaluation_failed`.
- `log(x, 10)` differentiates to a float constant: `0.43429448190325176 / x`.

### Dates and deadlines

- `dateDiff` counts end minus start: `dateDiff("2026-11-12", "2026-12-25")` → `43`. Add 1 when both endpoint days count.
- Add months or years from the anchor date in one call, because clamping compounds when calls are chained: `dateAdd(dateAdd("2026-01-31", 1, "months"), 1, "months")` → `"2026-03-28"`, but `dateAdd("2026-01-31", 2, "months")` → `"2026-03-31"`.
- Business days: `map` and `filter` accept an inline function as an argument; only a function as the result is rejected. The 30th business day after 2026-11-12:

  ```text
  filter(map(1:60, f(k) = dateAdd("2026-11-12", k)), f(d) = not(equalText(weekday(d), "Saturday") or equalText(weekday(d), "Sunday")))[30]
  ```

  This returns `"2026-12-24"`. Exclude a holiday with one more clause, `or equalText(d, "2026-11-26")`, and the result becomes `"2026-12-25"`. Size the window so the list reaches the nth day.
- Count business days with the same predicate inside `sum(map(…))`. `sum(map(1:43, f(k) = not(equalText(weekday(dateAdd("2026-11-12", k)), "Saturday") or equalText(weekday(dateAdd("2026-11-12", k)), "Sunday"))))` → `31`.
- Compare strings with `equalText`: `weekday("2026-11-12") == "Thursday"` fails with `type_mismatch`.

### Statistics over data

- Put the data in the expression; scope accepts numbers only.
- `median`, `prod`, and `mad` take no dimension argument: `median([1, 5; 3, 4; 2, 9], 1)` fails with `evaluation_failed`. Apply them per slice instead: `mapSlices([1, 5; 3, 4; 2, 9], 1, median)` → `[2, 5]`.
- Select one column with `[1, 2, 3; 4, 5, 6][:, 2]` → `[2, 5]`, or one row with `[1, 2, 3; 4, 5, 6][2, :]` → `[4, 5, 6]`.
- A `NaN` anywhere fails the call: `mean([1, 2, NaN])` fails with `undefined_result`. Drop missing values first.
- Sum over a sequence with `sum(map(1:10, f(k) = k^2))` → `385`, or element-wise with `sum((1:10) .^ 2)` → `385`.

### Units

- To reach a reciprocal unit, divide before converting. Litres per 100 km at 30 mpg is `100 km / (30 mile/gallon) to L` → `7.840486111111111 L`. Dividing 100 by `30 mile/gallon to km/L` instead returns `7.840486111111112 mm^2`.
- Strip a unit with `number`: `number(5 km, m)` → `5000`.
- `gallon` is the US gallon: `1 gallon to L` → `3.785411784 L`.
