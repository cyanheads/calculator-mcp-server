/**
 * @fileoverview Tests for the calculator://help resource.
 * @module mcp-server/resources/definitions/help.resource.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { helpResource } from '@/mcp-server/resources/definitions/help.resource.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { canonicalName } from '@/services/math/function-names.js';
import { initMathService } from '@/services/math/math-service.js';

beforeAll(() => {
  initMathService(getServerConfig());
});

/** The help text as the resource serves it. */
function helpText(): string {
  return helpResource.handler(
    {},
    createMockContext({ uri: new URL('calculator://help') }),
  ) as string;
}

type CallOptions = {
  numericType?: 'number' | 'BigNumber' | 'Fraction';
  operation?: 'evaluate' | 'simplify' | 'derivative';
  variable?: string;
  scope?: Record<string, number>;
  precision?: number;
};

/** What `calculate` returns for an expression: the result fields, or the failure reason and message. */
function outcome(expression: string, options: CallOptions = {}) {
  try {
    const output = calculateTool.handler(
      calculateTool.input.parse({ expression, ...options }),
      createMockContext({ errors: calculateTool.errors }),
    ) as { result: string; resultType: string };
    return { result: output.result, resultType: output.resultType };
  } catch (err) {
    if (err instanceof McpError) return { reason: err.data?.reason, message: err.message };
    throw err;
  }
}

/** The first line under a `### heading` of the help. */
function listUnder(heading: string): string {
  const line = helpText().match(new RegExp(`^### ${heading}\\n(.+)$`, 'm'))?.[1];
  if (!line) throw new Error(`No "### ${heading}" list in the help`);
  return line;
}

/**
 * Call options for help examples that are not a default `evaluate`, keyed by the
 * example as the help writes it (`expression => result`).
 */
const EXAMPLE_OPTIONS: Record<string, CallOptions> = {
  'x^2 + y => 28': { scope: { x: 5, y: 3 } },
  '(x + y) - x => 1': { numericType: 'BigNumber', scope: { x: 1e16, y: 1 } },
  'x * 3 => 3/10': { numericType: 'Fraction', scope: { x: 0.1 } },
  'lusolve([3, 2; 1, -1], [12; 1]) => [[14/5], [9/5]]': { numericType: 'Fraction' },
  '50! => 30414093201713378043612608166064768844377641568960512000000000000/1': {
    numericType: 'Fraction',
  },
  'combinations(10, 3) => 120/1': { numericType: 'Fraction' },
  'integrate(exp(-x^2), x, 0, 1) => 0.746824132812': { precision: 12 },
  'integrate(1/x, x, 1, e) => 1': { precision: 15 },
  'integrate(a*x^2, x, 0, 3) => 18': { scope: { a: 2 } },
  'integrate(x^2, x, 1, 0) => -0.333333333333333': { precision: 15 },
  'log10(integrate(exp(-x^2), x, 0, 1)) => -0.126781656741': { precision: 12 },
  'integrate(1/sqrt(x), x, 0, 1) => 2': { precision: 9 },
  'integrate(exp(-1e6 (x - 0.5)^2), x, 0, 1) => 0.00177245': { precision: 6 },
  '10000! / 9999! => 10000/1': { numericType: 'Fraction' },
  '5! => 120/1': { numericType: 'Fraction' },
  'sqrt(9/4) => 3/2': { numericType: 'Fraction' },
  'cbrt(-8) => -2/1': { numericType: 'Fraction' },
  '(9/4)^(3/2) => 27/8': { numericType: 'Fraction' },
  '(-2/3)^(-3) => -27/8': { numericType: 'Fraction' },
  '[4, 9/4] .^ (1/2) => [2/1, 3/2]': { numericType: 'Fraction' },
  '((2^61-1)^2)^(1/2) => 2305843009213693951/1': { numericType: 'Fraction' },
  'sqrtm([4, 0; 0, 9]) => [[2/1, 0/1], [0/1, 3/1]]': { numericType: 'Fraction' },
  '(1+2i)^2 => -3 + 4i': { numericType: 'Fraction' },
  'sqrt(5+12i) => 3 + 2i': { numericType: 'Fraction' },
  'cbrt(2+11i) => 2 + i': { numericType: 'Fraction' },
  '3*x**2 + 5*x => 6 * x + 5': { operation: 'derivative', variable: 'x' },
  'log(1000, 10) => 3': { precision: 10 },
  '100 celsius to fahrenheit => 212 fahrenheit': { precision: 6 },
  '1 / 3 => 0.3333': { precision: 4 },
  '2^2000 => 1.148130695274254524232833201177681984022317702088695200477642737e+602': {
    numericType: 'BigNumber',
  },
  '10000! / 9999! => 9999.999999999999999999999999999999999999999999999999999999999996': {
    numericType: 'BigNumber',
  },
  '10000! / 9999! => 10000': { numericType: 'BigNumber', precision: 16 },
  '0.1 + 0.2 => 3/10': { numericType: 'Fraction' },
  '1/3 + 1/6 => 1/2': { numericType: 'Fraction' },
  '[1, 2, 3][2] => 2/1': { numericType: 'Fraction' },
  'sum([1, 2; 3, 4], 1) => [4/1, 6/1]': { numericType: 'Fraction' },
  '30 deg to rad => 191068/364913 rad': { numericType: 'Fraction' },
  '2x + 3x => 5 * x': { operation: 'simplify' },
  'sin(x)^2 + cos(x)^2 => 1': { operation: 'simplify' },
  '(x^2 - 1) / (x - 1) => (x ^ 2 - 1) / (x - 1)': { operation: 'simplify' },
  'x^2 => 2 * x': { operation: 'derivative', variable: 'x' },
};

/** Every worked example in the help, written `` `expression` => `result` ``. */
function workedExamples() {
  return [...helpText().matchAll(/`([^`\n]+)` => `([^`\n]+)`/g)].map(
    ([, expression = '', result = '']) => ({
      expression,
      result,
      key: `${expression} => ${result}`,
    }),
  );
}

describe('help content matches callable behavior (#22)', () => {
  it('returns the shown value for every worked example', () => {
    const examples = workedExamples();
    expect(examples.length).toBeGreaterThan(30);
    for (const { expression, result, key } of examples) {
      expect(outcome(expression, EXAMPLE_OPTIONS[key]), key).toMatchObject({ result });
    }
  });

  it('keeps no call options for an example the help no longer shows', () => {
    const shown = new Set(workedExamples().map(({ key }) => key));
    for (const key of Object.keys(EXAMPLE_OPTIONS)) expect(shown, key).toContain(key);
  });

  it('lists only units that evaluate as units', () => {
    const line = helpText().match(/^Common units: (.+)$/m)?.[1] ?? '';
    const names = line.split(', ').flatMap((entry) => entry.match(/\w+/g) ?? []);
    expect(names).toEqual(expect.arrayContaining(['minute', 'Pa', 'ly', 'kt']));
    expect(names).not.toEqual(expect.arrayContaining(['min']));
    for (const name of names)
      expect(outcome(`1 ${name}`), name).toMatchObject({ resultType: 'Unit' });
  });

  it('pairs each arc* and ln name with the function it resolves to', () => {
    const pairs = [
      ...listUnder('Trigonometry').matchAll(/(\w+) \((arc\w+)\)/g),
      ...listUnder('Arithmetic').matchAll(/(\w+) \(also: (\w+)\)/g),
    ];
    expect(pairs).toHaveLength(13);
    for (const [, name = '', alias = ''] of pairs) {
      expect(alias.replace(/^arc/, 'a'), alias).toBe(name === 'log' ? 'ln' : name);
      expect(outcome(`${alias}(2)`), alias).toEqual(outcome(`${name}(2)`));
    }
  });

  it('lists only callable function names', () => {
    const sections = [
      'Arithmetic',
      'Trigonometry',
      'Statistics',
      'Matrix',
      'Polynomial Roots',
      'Combinatorics',
      'Dates',
      'Integrals',
      'Complex Numbers',
      'Logical',
      'Comparison',
    ];
    for (const section of sections) {
      const line = listUnder(section);
      const aliasLists = [...line.matchAll(/(\w+) \(aliases: ([^)]+)\)/g)].map(
        ([, canonical = '', list = '']) => ({ canonical, aliases: list.split(', ') }),
      );
      for (const { canonical, aliases } of aliasLists) {
        for (const alias of aliases) expect(canonicalName(alias), alias).toBe(canonical);
      }
      const names = [
        ...line.replace(/\([^)]*\)/g, '').split(','),
        ...aliasLists.flatMap(({ aliases }) => aliases),
      ]
        .map((name) => name.trim())
        .filter(Boolean);
      for (const name of names) {
        // `not` is also a parser keyword, so it cannot be named bare; call it instead.
        if (name === 'not') {
          expect(outcome('not(true)'), `${section}: not`).toMatchObject({ result: 'false' });
          continue;
        }
        const canonical = canonicalName(name);
        const probe = outcome(`typeOf(${name})`);
        if (canonical !== undefined && probe.reason !== undefined) {
          // A call-only synonym (`eig`, `integral`) is renamed only where it is called,
          // so it has no value for typeOf: a call must fail as the canonical call does.
          const call = outcome(`${name}()`);
          expect(call, `${section}: ${name}()`).not.toMatchObject({ reason: 'parse_failed' });
          expect(call, `${section}: ${name}()`).toEqual(outcome(`${canonical}()`));
          continue;
        }
        expect(probe, `${section}: ${name}`).toMatchObject({ result: '"function"' });
      }
    }
  });

  it.each([
    ['Infinity', {}, 'undefined_result'],
    ['NaN', {}, 'undefined_result'],
    ['171!', {}, 'undefined_result'],
    ['2^1024', {}, 'undefined_result'],
    ['exp(1000)', {}, 'undefined_result'],
    ['0/0', { numericType: 'BigNumber' }, 'undefined_result'],
    ['log(0)', { numericType: 'BigNumber' }, 'undefined_result'],
    ['sqrt(2)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['sin(1)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['log(3)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['log2(8)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['stirlingS2(5, 2)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['pi', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['e', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['2^(1/2)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['(-8)^(1/3)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['sin(pi)', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['random()', { numericType: 'Fraction' }, 'fraction_unsupported'],
    ['exp(1e17)', { numericType: 'BigNumber' }, 'undefined_result'],
    ['asin(2)', { numericType: 'BigNumber' }, 'undefined_result'],
    ['acosh(0.5)', { numericType: 'BigNumber' }, 'undefined_result'],
    ['gamma(0.5)', { numericType: 'BigNumber' }, 'evaluation_failed'],
    ['std(2, 4, 6, "uncorrected")', {}, 'type_mismatch'],
    ['30°N', {}, 'parse_failed'],
    ['[1, 2; 3, 4] ** 2', {}, 'type_mismatch'],
    ['[1, 0, 0] × [0, 1, 0]', {}, 'type_mismatch'],
    ['polynomialRoot(1, 2, 3, 4, 5)', {}, 'evaluation_failed'],
    ['now()', {}, 'parse_failed'],
    ['today()', {}, 'parse_failed'],
    ['integrate(1/x, x, -1, 1)', {}, 'evaluation_failed'],
    ['integrate(1/x, x, 0, 1)', {}, 'evaluation_failed'],
    ['range(1, 2000000)', {}, 'result_too_large'],
    ['range(1, 2, 0)', {}, 'evaluation_failed'],
    ['300000!', { numericType: 'Fraction' }, 'result_too_large'],
    ['2^(10^7)', { numericType: 'Fraction' }, 'result_too_large'],
    ['2^(10^6)', { numericType: 'Fraction' }, 'result_too_large'],
    ['stirlingS2(1413, 3)', {}, 'result_too_large'],
    ['bernoulli(1002)', {}, 'result_too_large'],
  ] as const)('shows %s, which fails as the help says', (expression, options, reason) => {
    expect(helpText()).toContain(`\`${expression}\``);
    expect(outcome(expression, options)).toMatchObject({ reason });
  });

  it('makes no claim that Fraction mode returns a float', () => {
    expect(helpText()).not.toMatch(/resultType `number`|check `resultType`/);
  });

  it('marks Infinity and NaN as intermediate values', () => {
    const help = helpText();
    expect(help).toMatch(/\| Infinity \|[^\n]*intermediate/);
    expect(help).toMatch(/\| NaN \|[^\n]*intermediate/);
  });

  it('offers the BigNumber retry for overflow only', () => {
    const help = helpText();
    expect(help).not.toMatch(/arbitrary/i);
    expect(help).toContain(
      'Division by zero, `0/0`, and `log(0)` are undefined in every numeric type',
    );
    expect(help).not.toMatch(/\(division by zero, overflow\)/);
  });
});

describe('help statistics conventions (#23)', () => {
  it('shows the returned value in every normalization row', () => {
    const rows = [
      ...helpText().matchAll(/^\| `"(\w+)"`[^|]*\| (n [−+] 1|n) \| `([^`]+)` \| `([^`]+)` \|$/gm),
    ];
    expect(rows.map(([, normalization]) => normalization)).toEqual([
      'unbiased',
      'uncorrected',
      'biased',
    ]);
    for (const [, normalization, , std, variance] of rows) {
      for (const fn of ['std', 'stdev', 'stddev']) {
        expect(outcome(`${fn}([2, 4, 6], "${normalization}")`)).toMatchObject({ result: std });
      }
      expect(outcome(`variance([2, 4, 6], "${normalization}")`)).toMatchObject({
        result: variance,
      });
    }
  });

  it('marks "unbiased" as the default and the sample form', () => {
    expect(helpText()).toMatch(/^\| `"unbiased"` \(default, sample\) \| n − 1 \|/m);
  });

  it('documents mad, quantileSeq, and mode conventions', () => {
    const help = helpText();
    expect(help).toContain('`mad` is the unscaled median absolute deviation');
    expect(help).toContain('`quantileSeq` interpolates linearly');
    expect(help).toContain('`mode` always returns an array');
  });
});

describe('help resource', () => {
  it('returns a non-empty markdown string', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler({}, ctx);
    expect(typeof content).toBe('string');
    expect((content as string).length).toBeGreaterThan(0);
  });

  it('contains major section headings', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler({}, ctx) as string;
    expect(content).toContain('## Operators');
    expect(content).toContain('## Constants');
    expect(content).toContain('## Functions');
    expect(content).toContain('## Syntax Examples');
  });

  it('documents the evaluate/simplify/derivative operations', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler({}, ctx) as string;
    expect(content).toContain('evaluate');
    expect(content).toContain('simplify');
    expect(content).toContain('derivative');
  });

  it('mentions unit conversion syntax', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler({}, ctx) as string;
    expect(content).toContain('kg to lbs');
  });

  it('does not expose math.js version in help content', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler({}, ctx) as string;
    // The version constant is redacted in the expression scope — it must
    // not be mentioned as a literal semver in the help text either.
    expect(content).not.toMatch(/math\.js\s+\d+\.\d+\.\d+/);
  });

  it('returns the same content on repeated calls (idempotent)', () => {
    const ctx1 = createMockContext({ uri: new URL('calculator://help') });
    const ctx2 = createMockContext({ uri: new URL('calculator://help') });
    expect(helpResource.handler({}, ctx1)).toBe(helpResource.handler({}, ctx2));
  });
});
