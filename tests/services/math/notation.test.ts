/**
 * @fileoverview Tests for the notation reader at its own seam: the scan that
 * reads `**`, `×`, `÷`, `−`, and `°` as math.js syntax, the map from a parse
 * error back to the caller's text, and the scalar-operand guard for `×` and
 * `**`. Seeded differential fuzzing checks the scan against math.js's own
 * parser, and a timing suite bounds the scan's growth.
 * @module tests/services/math/notation.test
 */

import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { matrix, parse } from 'mathjs';
import { describe, expect, it } from 'vitest';
import {
  guardScalarOperators,
  type NotationReading,
  parseErrorMessage,
  readNotation,
} from '@/services/math/notation.js';

/** The math.js parse error for `text`. */
function parseError(text: string): unknown {
  try {
    parse(text);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${JSON.stringify(text)} not to parse`);
}

/** The McpError `run` throws. */
function thrown(run: () => unknown): McpError {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(McpError);
  return caught as McpError;
}

/** Read `expression` and run the scalar guard on its tree; returns the guarded tree. */
function guarded(expression: string) {
  const reading = readNotation(expression);
  const tree = parse(reading.text);
  guardScalarOperators(tree, reading.twin, (twin) => parse(twin));
  return tree;
}

const TIMES_HINT = 'Write cross(a, b) for the cross product, or * for the dot or matrix product.';
const POWER_HINT = 'Write ^ for the matrix power, or .^ for the element-wise power.';

describe('readNotation', () => {
  it.each([
    ['2 ** 10', '2 ^ 10'],
    ['3*x**2 + 5*x', '3*x^2 + 5*x'],
    ['8 ÷ 2', '8 / 2'],
    ['5 − 3', '5 - 3'],
    ['−5', '-5'],
    ['6 × 7', '6 * 7'],
    ['sin(30°)', 'sin(30 deg)'],
    ['30°C to °F', '30 degC to  degF'],
    ['45°F to °C', '45 degF to  degC'],
    ['x°', 'x deg'],
    ['°°', ' deg deg'],
    ['30°×2', '30 deg*2'],
    ['x×y', 'x*y'],
    ['x÷y', 'x/y'],
    ['1e−5', '1e-5'],
    ['0x1F×2', '0x1F*2'],
    ['2 *** 3', '2 ^* 3'],
  ])('reads %j as %j', (source, text) => {
    expect(readNotation(source).text).toBe(text);
  });

  it.each([
    ['2.×3', '2. *3'],
    ['2.**3', '2. ^3'],
    ['x.÷y', 'x. /y'],
    ['[1,2].**2', '[1,2]. ^2'],
  ])('keeps the reading of %j from fusing with the dot before it: %j', (source, text) => {
    expect(readNotation(source).text).toBe(text);
  });

  it('keeps a read ** from fusing with a following | into bitwise xor', () => {
    expect(readNotation('2**|3').text).toBe('2^ |3');
  });

  it.each([
    ["x' ** 2", "x' ^ 2"],
    ["[1,2;3,4]' ** 2", "[1,2;3,4]' ^ 2"],
    ["x'' × 2", "x'' * 2"],
    ["'a' ** 2", "'a' ^ 2"],
    ['5! ** 2', '5! ^ 2'],
    ["(x\n' ** 2)", "(x\n' ^ 2)"],
    ["[x\n' × 2]", "[x\n' * 2]"],
  ])('reads a quote after a value as a transpose: %j → %j', (source, text) => {
    expect(readNotation(source).text).toBe(text);
  });

  it.each([
    '"2 ** 3"',
    "'6 × 7'",
    '"say \\"**\\" now"',
    "'it\\'s ** fine'",
    '"30°C"',
    `concat('×', "÷")`,
    '"\\\\" + "**"',
    '"2 ** 3',
    "'6 × 7",
    "'a\\'",
    '# ** × ÷ − °',
    "to'**'",
    "x to'**'",
    "2e5to'**'",
    "2E5mod'×'",
    "x\n'**'",
    "1 + '**'",
    "('**')",
    '30°N',
    '30°Cx',
    '10°2',
    '[1,2;3,4] ^ 2',
    '[1,0,0] * [0,1,0]',
    '2.*3',
  ])('leaves %j as written', (source) => {
    expect(readNotation(source)).toEqual({
      source,
      text: source,
      twin: undefined,
      origin: undefined,
    });
  });

  it('reads code after a comment line and leaves the comment unread', () => {
    expect(readNotation("(2 ** 2 # it's ** ×\n × 3)").text).toBe("(2 ^ 2 # it's ** ×\n * 3)");
  });

  it('spells × and ** as .* and .^ in the twin, and only when one was read', () => {
    expect(readNotation('2 ** 3 × 4 ÷ 5').twin).toBe('2  .^  3  .*  4 / 5');
    expect(readNotation('2.×3').twin).toBe('2. .* 3');
    expect(readNotation('8 ÷ 2 − 1°').twin).toBeUndefined();
  });

  it('maps every character it writes to the caller character it came from', () => {
    const reading = readNotation('2 ** 3 × 4 ÷ 5 − 6°');
    expect(reading.text).toBe('2 ^ 3 * 4 / 5 - 6 deg');
    expect(reading.origin).toEqual([
      0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 18, 18, 18, 19,
    ]);
  });
});

describe('parseErrorMessage', () => {
  function message(source: string): string {
    const reading = readNotation(source);
    return parseErrorMessage(parseError(reading.text), reading);
  }

  it.each([
    ['2 ** ** 3', 'Value expected (char 6)'],
    ['30° +* 2', 'Value expected (char 6)'],
    ['6 × × 7', 'Value expected (char 5)'],
    ['2 **', 'Unexpected end of expression (char 5)'],
    ['2 ** 3)', 'Unexpected operator ) (char 7)'],
    ['30°N × 2', 'Syntax error in part "°N × 2" (char 3)'],
    ['2 ** 3 ∙ 4', 'Syntax error in part "∙ 4" (char 8)'],
  ])('names the caller position for %j: %j', (source, expected) => {
    expect(message(source)).toBe(expected);
  });

  it('leaves the message of a text that was not read as math.js wrote it', () => {
    expect(message('2 +* 3')).toBe('Value expected (char 4)');
    expect(message('30°N')).toBe('Syntax error in part "°N" (char 3)');
  });

  it('leaves a message without a character position unchanged', () => {
    const reading: NotationReading = readNotation('2 ** 3');
    expect(parseErrorMessage(new Error('Undefined symbol q'), reading)).toBe('Undefined symbol q');
    expect(parseErrorMessage('plain failure', reading)).toBe('plain failure');
  });
});

describe('guardScalarOperators', () => {
  it.each([
    ['[1,0,0] × [0,1,0]', TIMES_HINT],
    ['2 × [1,2]', TIMES_HINT],
    ['(1:3) × 2', TIMES_HINT],
    ['-[1,2] × 3', TIMES_HINT],
    ['[1,2;3,4] ** 2', POWER_HINT],
    ["[1,2;3,4]' ** 2", POWER_HINT],
    ['(+[1,2;3,4]) ** 2', POWER_HINT],
    ['2 ** [1,2]', POWER_HINT],
  ])('rejects the matrix literal or range %j at parse', (expression, hint) => {
    const error = thrown(() => guarded(expression));
    expect(error.data?.reason).toBe('type_mismatch');
    expect(error.message).toContain(hint);
    expect(error.data?.recovery).toEqual({ hint });
  });

  it('names what to write instead, as literals the caller sends back', () => {
    const times = thrown(() => guarded('[1,0,0] × [0,1,0]'));
    expect(times.message).toBe(
      '"×" multiplies scalars only, and an operand here is a vector or matrix. Write cross(a, b) for the cross product, or * for the dot or matrix product.',
    );
    expect(times.literals).toEqual(['cross(a, b)', '*']);
    const power = thrown(() => guarded('[1,2;3,4] ** 2'));
    expect(power.message).toBe(
      '"**" raises scalars only, and an operand here is a vector or matrix. Write ^ for the matrix power, or .^ for the element-wise power.',
    );
    expect(power.literals).toEqual(['^', '.^']);
  });

  it('checks an operand value when it evaluates', () => {
    const tree = guarded('x × 3').compile();
    expect(tree.evaluate({ x: 2 })).toBe(6);
    const error = thrown(() => tree.evaluate({ x: matrix([1, 2]) }));
    expect(error.data?.reason).toBe('type_mismatch');
    expect(error.data?.recovery).toEqual({ hint: TIMES_HINT });
  });

  it('checks an operand inside a function body each time the function runs', () => {
    const square = guarded('f(v) = v ** 2').compile().evaluate() as (v: unknown) => unknown;
    expect(square(3)).toBe(9);
    expect(thrown(() => square(matrix([1, 2]))).data?.recovery).toEqual({ hint: POWER_HINT });
  });

  it('leaves the operands of a typed * or ^ unchecked', () => {
    expect(guarded('[1,0,0] * [0,1,0]').compile().evaluate()).toBe(0);
    const power = guarded('[1,2;3,4] ^ 2').compile().evaluate() as { toArray(): unknown };
    expect(power.toArray()).toEqual([
      [7, 10],
      [15, 22],
    ]);
  });

  it('holds only the × operands to scalars when × and * mix', () => {
    const result = guarded('2 × 3 * [1,2]').compile().evaluate() as { toArray(): unknown };
    expect(result.toArray()).toEqual([6, 12]);
    expect(thrown(() => guarded('[1,2] * 2 × 3').compile().evaluate()).data?.reason).toBe(
      'type_mismatch',
    );
  });

  it('fails closed when the twin does not parse', () => {
    const error = thrown(() => guardScalarOperators(parse('2 * 3'), '2 .* (', (t) => parse(t)));
    expect(error.data?.reason).toBe('parse_failed');
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['2 * 3', '2 .* 3 + 1'],
    ['2 * 3', '2 + 3'],
    ['2 * 3', '2 / 3'],
    ['2 ^ 3', '2 .* 3'],
    ['[2, 3]', '[2, 3, 4]'],
    ['[2, 3, 4]', '[2, 3]'],
    ['2 * x', '2 .* 3'],
  ])('fails closed when the twin of %j differs in shape: %j', (text, twin) => {
    const error = thrown(() => guardScalarOperators(parse(text), twin, (t) => parse(t)));
    expect(error.data?.reason).toBe('parse_failed');
    expect(error.message).toBe(
      'Could not tell which operands "×" or "**" apply to in this expression. Write * for multiplication and ^ for powers.',
    );
  });

  it('passes a declared error from the twin parse through as is', () => {
    const tooDeep = validationError('Expression is nested too deeply.', {
      reason: 'expression_too_deep',
    });
    const error = thrown(() =>
      guardScalarOperators(parse('2 * 3'), '2 .* 3', () => {
        throw tooDeep;
      }),
    );
    expect(error).toBe(tooDeep);
  });
});

// ---------------------------------------------------------------------------
// Seeded differential fuzzing against math.js's parser
// ---------------------------------------------------------------------------

/** A deterministic generator (an LCG) so a failure reproduces from its seed. */
function seeded(seed: number) {
  let state = seed;
  const below = (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  return { below, pick: <T>(items: readonly T[]) => items[below(items.length)] as T };
}

/** The string constants of a tree, in traverse order. */
function stringsOf(text: string): string[] {
  const strings: string[] = [];
  parse(text).traverse((node) => {
    const { value } = node as { value?: unknown };
    if (node.type === 'ConstantNode' && typeof value === 'string') strings.push(value);
  });
  return strings;
}

describe('differential fuzzing against math.js (seeded)', () => {
  it('leaves every string literal math.js parses exactly as written', () => {
    const { below, pick } = seeded(12345);
    const quoted = () => {
      const quote = pick(['"', "'"]);
      let body = '';
      for (let k = below(6); k > 0; k--) {
        body += pick(['**', '×', '÷', '−', '°', '°C', 'a', ' ', '\\\\', '#', "'", '"', '\n', 'to']);
      }
      return quote + body.replaceAll(quote, `\\${quote}`) + quote;
    };
    const atom = (depth: number): string =>
      pick([
        quoted,
        () => pick(['x', 'A', 'x×y', 'a÷b', String(below(9))]),
        () => pick(['2e5', '1E3', '0x1F', '2.', '.5']),
        () => '[1,2;3,4]',
        () => (depth > 2 ? 'x' : `(${expression(depth + 1)})`),
        () => (depth > 2 ? 'x' : `[${expression(depth + 1)}\n, ${expression(depth + 1)}]`),
        () => `${pick(['x', 'A', '[1,2;3,4]', '(x)', '5!'])}'`,
        () => `concat(${quoted()}, ${quoted()})`,
      ])();
    const expression = (depth = 0): string => {
      let text = atom(depth);
      for (let k = depth > 1 ? 0 : below(3); k > 0; k--) {
        text +=
          pick([' + ', ' * ', ' == ', ' to ', 'to', ' and ', 'or', ' ', "'", ' in ', 'mod', '\n']) +
          atom(depth);
      }
      if (below(5) === 0) text += pick([" # it's", ' # "', ' # **']);
      return text;
    };

    let checked = 0;
    for (let k = 0; k < 15_000; k++) {
      const source = expression();
      let expected: string[];
      try {
        expected = stringsOf(source);
      } catch {
        continue; // nothing to compare: math.js rejects the text as written
      }
      const { text } = readNotation(source);
      // `×` and `÷` are identifier characters to math.js, so reading them as
      // operators can leave text that no longer parses; the strings are what count.
      if (/[×÷]/.test(source) && !parses(text)) continue;
      expect(stringsOf(text), JSON.stringify(source)).toEqual(expected);
      checked++;
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('reads the caller spellings to the tree the math.js spellings parse to', () => {
    const { below, pick } = seeded(987);
    type Pair = readonly [caller: string, mathjs: string];
    const same = (text: string): Pair => [text, text];
    const quoted = (): Pair => {
      const quote = pick(['"', "'"]);
      let body = '';
      for (let k = below(5); k > 0; k--) {
        body += pick([
          '**',
          '×',
          '÷',
          '−',
          '°',
          '°C',
          'a',
          ' ',
          '#',
          '\\\\',
          quote === '"' ? "'" : '"',
        ]);
      }
      return same(quote + body.replaceAll(quote, `\\${quote}`) + quote);
    };
    const OPERATORS: readonly Pair[] = [
      [' ** ', ' ^ '],
      ['**', '^'],
      [' × ', ' * '],
      ['×', '*'],
      [' ÷ ', ' / '],
      ['÷', '/'],
      [' − ', ' - '],
      ['−', '-'],
      same(' + '),
      same(' * '),
      same(' == '),
      same(' and '),
      same("'"),
      same(' to '),
      same(' mod '),
    ];
    const atom = (depth: number): Pair =>
      pick<() => Pair>([
        quoted,
        () => same(pick(['x', String(1 + below(9)), '2.', '.5', '2.5e3', '{a: 2}.a', '0x1F'])),
        () => ['1e−5', '1e-5'],
        () => {
          const n = String(1 + below(90));
          return pick<Pair>([
            [`${n}°`, `${n} deg`],
            [`${n}°C`, `${n} degC`],
            [`${n}°F`, `${n} degF`],
          ]);
        },
        () => same('[1,2;3,4]'),
        () => {
          if (depth > 2) return same('x');
          const [a, b] = expression(depth + 1);
          return [`(${a})`, `(${b})`];
        },
        () => {
          if (depth > 2) return same('x');
          const [a, b] = expression(depth + 1);
          return [`(${a}\n')`, `(${b}\n')`];
        },
        () => same(`${pick(['x', 'A', '[1,2;3,4]', '(x)'])}'`),
        () => {
          const [a] = quoted();
          const [c] = quoted();
          return same(`concat(${a}, ${c})`);
        },
      ])();
    const expression = (depth = 0): Pair => {
      let [caller, mathjs] = atom(depth);
      if (below(6) === 0) {
        caller = `−${caller}`;
        mathjs = `-${mathjs}`;
      }
      for (let k = depth > 1 ? 0 : below(4); k > 0; k--) {
        const [callerOperator, mathjsOperator] = pick(OPERATORS);
        const [a, b] = atom(depth);
        caller += callerOperator + a;
        mathjs += mathjsOperator + b;
      }
      if (below(6) === 0) {
        const comment = pick([" # it's ** ×", ' # "°']);
        caller += comment;
        mathjs += comment;
      }
      return [caller, mathjs];
    };
    const shape = (text: string) => {
      const types: string[] = [];
      parse(text).traverse((node) => {
        types.push(node.type);
      });
      return types.join();
    };

    let checked = 0;
    for (let k = 0; k < 20_000; k++) {
      const [caller, mathjs] = expression();
      let expected: string;
      try {
        expected = parse(mathjs).toString();
      } catch {
        continue; // the math.js spelling does not parse either
      }
      const reading = readNotation(caller);
      expect(parse(reading.text).toString(), JSON.stringify(caller)).toBe(expected);
      if (reading.twin !== undefined) {
        expect(shape(reading.twin), JSON.stringify(caller)).toBe(shape(reading.text));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

/** Whether math.js parses `text`. */
function parses(text: string): boolean {
  try {
    parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scan time: linear in the input across a 64× span
// ---------------------------------------------------------------------------

const BASE_SIZE = 5_000;
const SPAN = 64;
/** Characters each measurement covers, so a small input is timed over a batch of calls. */
const MEASURED_CHARACTERS = 16 * BASE_SIZE;
/** Thread CPU milliseconds one call may take at the largest size. */
const LARGEST_CALL_MS = 250;

/** Least thread CPU milliseconds per call of `run`, over `rounds` batches of `calls` calls. */
function cpuMsPerCall(run: () => void, calls: number, rounds = 3): number {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round++) {
    const started = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) run();
    const used = process.threadCpuUsage(started);
    least = Math.min(least, (used.user + used.system) / 1000 / calls);
  }
  return least;
}

/**
 * Time `run` on inputs doubling from {@link BASE_SIZE} to {@link SPAN} times it,
 * timing the base size again beside each larger one. At each size the least
 * growth over three pairs stays under four times the size ratio (below 256
 * across the full span), checked before the next size runs; the largest call
 * stays under {@link LARGEST_CALL_MS} of thread CPU time.
 */
function expectLinear<T>(make: (size: number) => T, run: (input: T) => void): void {
  const calls = (size: number) => Math.max(1, Math.round(MEASURED_CHARACTERS / size));
  const base = make(BASE_SIZE);
  let largestMs = 0;
  for (let size = 2 * BASE_SIZE; size <= SPAN * BASE_SIZE; size *= 2) {
    const input = make(size);
    let growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3; pair++) {
      const baseMs = cpuMsPerCall(() => run(base), calls(BASE_SIZE));
      largestMs = cpuMsPerCall(() => run(input), calls(size));
      growth = Math.min(growth, largestMs / Math.max(baseMs, 1e-6));
    }
    expect(growth, `growth from ${BASE_SIZE} to ${size} characters`).toBeLessThan(
      (4 * size) / BASE_SIZE,
    );
  }
  expect(largestMs).toBeLessThan(LARGEST_CALL_MS);
}

/** `unit` repeated to `size` characters. */
const repeat = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));

const SHAPES: ReadonlyArray<readonly [name: string, make: (size: number) => string]> = [
  ['one long line ending in a line break', (size) => `${'x'.repeat(size)}\ny`],
  ['line breaks throughout', (size) => repeat('  \r\n', size)],
  ['a run of *', (size) => '*'.repeat(size)],
  ['a run of ** between numbers', (size) => `2${repeat('**2', size)}`],
  ['a run of × between numbers', (size) => `2${repeat('×2', size)}`],
  ['a run of ÷ and − between letters', (size) => `x${repeat('÷y−x', size)}`],
  ['a run of °', (size) => '°'.repeat(size)],
  ['a run of °C', (size) => repeat('°C', size)],
  ['alternating quotes', (size) => repeat(`"'`, size)],
  ['an unterminated " string', (size) => `"${repeat('**', size)}`],
  ["an unterminated ' string", (size) => `'${repeat('×', size)}`],
  ['a backslash run in a string', (size) => `"${'\\'.repeat(size)}"`],
  ['a transpose chain', (size) => `x${"'".repeat(size)}`],
  ['a long identifier then a quote', (size) => `${'a'.repeat(size)}'**'`],
  ['a comment then quotes', (size) => `1 #${repeat(`'"`, size)}`],
  ['nested openers', (size) => `${repeat('([{', size)}x`],
  ['exponent literals', (size) => repeat('1e−5', size)],
  ['dots before read operators', (size) => repeat('2.×.**', size)],
  ['named delimiters before quotes', (size) => repeat("to'", size)],
];

describe('readNotation scan time', () => {
  it.each(SHAPES)(
    'stays linear on %s',
    (_, make) => {
      expectLinear(make, (input) => readNotation(input));
    },
    0,
  );

  it('parse error mapping stays linear on a long quoted part', () => {
    expectLinear(
      (size) => {
        const reading = readNotation(`30°N${repeat(' × 2', size)}`);
        return { reading, error: parseError(reading.text) };
      },
      ({ reading, error }) => parseErrorMessage(error, reading),
    );
  }, 0);
});
