/**
 * @fileoverview Reads operator spellings carried over from Python and typeset
 * text — `**`, `×`, `÷`, `−` (U+2212), and `°` — as math.js syntax, outside
 * string literals and `#` comments, in one pass that mirrors math.js
 * tokenization. The pass keeps a map from the text it writes back to the
 * caller's characters, so a parse error names the caller's position. `×` and
 * `**` take scalar operands only: the nodes they produced are found by zipping
 * the parse tree with a twin parse that spells them `.*` / `.^` (#47).
 * @module services/math/notation
 */

import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  isArrayNode,
  isCollection,
  isOperatorNode,
  isParenthesisNode,
  isRangeNode,
  type MathNode,
  parse,
} from 'mathjs';

/** An expression read into math.js syntax. */
export interface NotationReading {
  /**
   * `origin[k]` is the index of the caller character `text[k]` came from, and
   * `origin[text.length]` is the caller's length. Absent when `text` is the
   * caller's text.
   */
  readonly origin: readonly number[] | undefined;
  /** The caller's expression. */
  readonly source: string;
  /** The expression in math.js syntax; the caller's text when nothing was read. */
  readonly text: string;
  /**
   * `text` with every `×` spelled ` .* ` and every `**` spelled ` .^ `, the same
   * precedence and associativity as `*` and `^`. Present only when one was read.
   */
  readonly twin: string | undefined;
}

/**
 * math.js named delimiters (`NAMED_DELIMITERS` in its parser): word operators
 * after which a value is expected, so a `'` there opens a string. math.js also
 * reads one as a symbol where a value is expected (`to'` at the start transposes
 * a symbol `to`); taking every one as an operator then only leaves the text that
 * follows unread, never reads inside a string.
 */
const NAMED_DELIMITERS = new Set(['mod', 'to', 'in', 'and', 'xor', 'or', 'not']);

/**
 * Read the expression's operator spellings as math.js syntax:
 *
 * | Caller | math.js |
 * |:-------|:--------|
 * | `**` | `^` |
 * | `×` | `*` |
 * | `÷` | `/` |
 * | `−` | `-` |
 * | `°C`, `°F`, `°` | `degC`, `degF`, `deg` |
 *
 * `°` is read only where no letter or digit follows it (`30°N` stays unread
 * and fails to parse). `×` and `÷` are operators even between letters, though
 * math.js would take them as identifier characters. A replacement written right
 * after `.` is separated from it, so it never fuses into `.*`, `.^`, or `./`.
 *
 * String literals of either quote style (with backslash escapes) and `#`
 * comments are copied unread. Whether a `'` opens a string or transposes the
 * value before it follows math.js: a transpose right after a value, a string
 * anywhere else. A newline inside brackets is whitespace there, and a separator
 * outside them. Where the scan cannot tell, it takes the `'` as a string, so
 * the doubt only ever leaves code unread, never reads inside a string.
 */
export function readNotation(source: string): NotationReading {
  const length = source.length;
  const origin: number[] = [];
  let text = '';
  let twin = '';
  let changed = false;
  let twinNeeded = false;
  /** The last token ends a value, so a `'` here is a transpose. */
  let valueEnd = false;
  /** Open brackets of any kind; math.js reads a newline inside one as whitespace. */
  let depth = 0;
  /** The last character of the text so far, kept so no step reads back the growing text. */
  let previous = '';
  /** Caller characters from here to `i` are copied unread and not yet appended to `text`. */
  let unflushed = 0;
  let i = 0;

  const copyTo = (end: number) => {
    if (end <= i) return;
    previous = source.charAt(end - 1);
    for (; i < end; i++) origin.push(i);
  };
  const copyWhile = (test: (at: number) => boolean) => {
    let end = i;
    while (end < length && test(end)) end++;
    copyTo(end);
  };
  /** Write `spelling` (and `twinSpelling` in the twin) for the `consumed` caller characters at `i`. */
  const write = (spelling: string, twinSpelling: string, consumed: number) => {
    const unread = source.slice(unflushed, i);
    text += unread + spelling;
    twin += unread + twinSpelling;
    previous = spelling.charAt(spelling.length - 1);
    for (let k = 0; k < spelling.length; k++) origin.push(i);
    i += consumed;
    unflushed = i;
    changed = true;
  };
  const writeOperator = (spelling: string, twinSpelling: string | undefined, consumed: number) => {
    let written = previous === '.' ? ` ${spelling}` : spelling;
    // `^|` is math.js's bitwise xor; keep a read `**` from fusing into it.
    if (spelling === '^' && source[i + consumed] === '|') written += ' ';
    if (twinSpelling !== undefined) twinNeeded = true;
    write(written, twinSpelling ?? written, consumed);
    valueEnd = false;
  };
  const isIdentifierAt = (at: number) => isIdentifierChar(source, at);
  const isDigitAt = (at: number) => parse.isDigit(source.charAt(at));
  const isWordAt = (at: number) => isIdentifierAt(at) || isDigitAt(at);

  /** Copy a number token the way math.js's `getToken` reads one, writing `-` for a `−` exponent sign. */
  const copyNumber = () => {
    const prefix = source.slice(i, i + 2);
    if (prefix === '0b' || prefix === '0o' || prefix === '0x') {
      copyTo(i + 2);
      copyWhile(isWordAt);
      if (source[i] === '.') {
        copyTo(i + 1);
        copyWhile(isWordAt);
      } else if (source[i] === 'i') {
        copyTo(i + 1);
        copyWhile(isDigitAt);
      }
      return;
    }
    if (source[i] === '.') {
      copyTo(i + 1);
    } else {
      copyWhile(isDigitAt);
      if (isDecimalMark(source, i)) copyTo(i + 1);
    }
    copyWhile(isDigitAt);
    const sign = source[i + 1];
    if (
      (source[i] === 'e' || source[i] === 'E') &&
      (isDigitAt(i + 1) || sign === '+' || sign === '-' || sign === '−')
    ) {
      copyTo(i + 1);
      if (sign === '−') write('-', '-', 1);
      else if (sign === '+' || sign === '-') copyTo(i + 1);
      copyWhile(isDigitAt);
    }
  };

  /** Read a `°` at `i` as a unit; false when a letter or digit follows it. */
  const readDegree = (): boolean => {
    const scale = source[i + 1];
    const unit = scale === 'C' || scale === 'F' ? `deg${scale}` : 'deg';
    const consumed = unit === 'deg' ? 1 : 2;
    if (isWordAt(i + consumed)) return false;
    write(` ${unit}`, ` ${unit}`, consumed);
    valueEnd = true;
    return true;
  };

  while (i < length) {
    const c = source.charAt(i);
    if (c === '#') {
      // A comment runs to the line feed; math.js discards it unread.
      const end = source.indexOf('\n', i);
      copyTo(end === -1 ? length : end);
      continue;
    }
    if (c === '"' || (c === "'" && !valueEnd)) {
      copyTo(stringEnd(source, i));
      valueEnd = true;
      continue;
    }
    if (c === '*' && source[i + 1] === '*') {
      writeOperator('^', ' .^ ', 2);
      continue;
    }
    if (c === '×') {
      writeOperator('*', ' .* ', 1);
      continue;
    }
    if (c === '÷' || c === '−') {
      writeOperator(c === '÷' ? '/' : '-', undefined, 1);
      continue;
    }
    if (c === '°' && readDegree()) continue;
    if (parse.isDigit(c) || (c === '.' && isDigitAt(i + 1))) {
      copyNumber();
      valueEnd = true;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      valueEnd = false;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      valueEnd = true;
    } else if (c === "'" || c === '!') {
      valueEnd = true; // a transpose (a value preceded this `'`) or a factorial
    } else if (!parse.isWhitespace(c, depth)) {
      if (isIdentifierAt(i)) {
        const start = i;
        copyWhile(isWordAt);
        valueEnd = !NAMED_DELIMITERS.has(source.slice(start, i));
        continue;
      }
      valueEnd = false;
    }
    copyTo(i + 1);
  }

  if (!changed) return { source, text: source, twin: undefined, origin: undefined };
  const unread = source.slice(unflushed);
  origin.push(length);
  return { source, text: text + unread, twin: twinNeeded ? twin + unread : undefined, origin };
}

/**
 * Whether `source[at]` starts an identifier or continues one, by math.js's own
 * test — except `×` and `÷`, which math.js counts as letters and this module
 * reads as operators.
 */
function isIdentifierChar(source: string, at: number): boolean {
  const c = source.charAt(at);
  return c !== '×' && c !== '÷' && parse.isAlpha(c, source.charAt(at - 1), source.charAt(at + 1));
}

/**
 * Whether the `.` at `at` is a decimal mark: math.js's `isDecimalMark`, judged
 * on the text the scan writes. A read `**`, `×`, `÷`, or `−` after the `.` is
 * written with a space before it, so only a typed `*`, `/`, or `^` makes the
 * `.` part of an operator.
 */
function isDecimalMark(source: string, at: number): boolean {
  if (source[at] !== '.') return false;
  const next = source[at + 1];
  if (next === '*') return source[at + 2] === '*';
  return next !== '/' && next !== '^';
}

/** Index just past the string literal opening at `start`, or the end of an unterminated one. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let at = start + 1;
  while (at < source.length && source[at] !== quote) at += source[at] === '\\' ? 2 : 1;
  return Math.min(at + 1, source.length);
}

/**
 * The math.js syntax errors that quote the token starting at their `(char N)`,
 * as the text before and after the token.
 */
const QUOTED_TOKEN_ERRORS = [
  ['Unexpected operator ', ''],
  ['Unexpected part "', '"'],
  ['Syntax error in part "', '"'],
] as const;

/**
 * The message of a math.js parse error on the reading's text, with its
 * `(char N)` — and a token it quotes from that position — naming the caller's
 * text instead.
 */
export function parseErrorMessage(err: unknown, reading: NotationReading): string {
  const message = err instanceof Error ? err.message : String(err);
  const { origin, source, text } = reading;
  const char = (err as { char?: unknown } | null)?.char;
  if (origin === undefined || typeof char !== 'number') return message;
  const suffix = ` (char ${char})`;
  if (!message.endsWith(suffix)) return message;
  const at = char - 1;
  const callerAt = origin[at] ?? source.length;
  let body = message.slice(0, -suffix.length);
  for (const [open, close] of QUOTED_TOKEN_ERRORS) {
    if (!body.startsWith(open) || !body.endsWith(close)) continue;
    const token = body.slice(open.length, body.length - close.length);
    if (text.startsWith(token, at)) {
      body = `${open}${source.slice(callerAt, origin[at + token.length])}${close}`;
    }
    break;
  }
  return `${body} (char ${callerAt + 1})`;
}

/** A scalar-only operator: the math.js function it reads as, and what to write instead. */
interface ScalarOperator {
  readonly hint: string;
  readonly literals: readonly string[];
  readonly message: string;
  /** The function its twin spelling parses to. */
  readonly twinFn: string;
}

/** Keyed by the math.js function the caller's spelling parses to. */
const SCALAR_OPERATORS: ReadonlyMap<string, ScalarOperator> = new Map([
  [
    'multiply',
    {
      twinFn: 'dotMultiply',
      message: '"×" multiplies scalars only, and an operand here is a vector or matrix.',
      hint: 'Write cross(a, b) for the cross product, or * for the dot or matrix product.',
      literals: ['cross(a, b)', '*'],
    },
  ],
  [
    'pow',
    {
      twinFn: 'dotPow',
      message: '"**" raises scalars only, and an operand here is a vector or matrix.',
      hint: 'Write ^ for the matrix power, or .^ for the element-wise power.',
      literals: ['^', '.^'],
    },
  ],
]);

/** `type_mismatch` for a vector or matrix operand of `×` or `**`. */
function scalarOperandError(operator: ScalarOperator): McpError {
  return validationError(
    `${operator.message} ${operator.hint}`,
    { reason: 'type_mismatch', recovery: { hint: operator.hint } },
    { literals: operator.literals },
  );
}

/** `parse_failed` when the twin does not line up with the parse tree. */
function unreadable(options?: { cause: unknown }): McpError {
  return validationError(
    'Could not tell which operands "×" or "**" apply to in this expression. Write * for multiplication and ^ for powers.',
    { reason: 'parse_failed' },
    { literals: ['*', '^'], ...options },
  );
}

/** Every node of a tree, in `traverse` order. */
function nodesOf(tree: MathNode): MathNode[] {
  const nodes: MathNode[] = [];
  tree.traverse((node) => {
    nodes.push(node);
  });
  return nodes;
}

/** Unary operators that keep a matrix a matrix of the same shape. */
const SHAPE_KEEPING_OPERATORS = new Set(['unaryMinus', 'unaryPlus', 'ctranspose']);

/**
 * Whether a node is a matrix literal or a range, inside any parentheses, signs,
 * and transposes (`-[1, 2]`, `[1, 2; 3, 4]'`).
 */
function isCollectionLiteral(node: MathNode): boolean {
  let inner = node;
  while (true) {
    if (isParenthesisNode(inner)) inner = inner.content;
    else if (isOperatorNode(inner) && SHAPE_KEEPING_OPERATORS.has(inner.fn)) {
      inner = inner.args[0] as MathNode;
    } else break;
  }
  return isArrayNode(inner) || isRangeNode(inner);
}

/**
 * Hold every `×` and `**` in the tree to scalar operands. The twin parses to
 * the same shape with `dotMultiply` / `dotPow` where the caller wrote `×` /
 * `**`, so zipping the two in `traverse` order finds the nodes they produced;
 * a twin that fails to parse or differs in shape fails closed with
 * `parse_failed`. A matrix-literal or range operand fails at once, in every
 * operation. Any other operand is checked when it evaluates: its node's
 * `_compile` is wrapped, as the size guard's metering is, so a vector or
 * matrix value fails with `type_mismatch`. Both walks recurse once per level of
 * the tree, so a tree nested past the call stack throws the engine's stack
 * overflow, for the caller to classify.
 *
 * @param parseTwin Parses the twin with the instance that parsed `tree`; a
 *   declared error it throws (input nested too deeply) passes through as is.
 */
export function guardScalarOperators(
  tree: MathNode,
  twin: string | undefined,
  parseTwin: (text: string) => MathNode,
): void {
  if (twin === undefined) return;
  let twinTree: MathNode;
  try {
    twinTree = parseTwin(twin);
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw unreadable({ cause: err });
  }
  const twinNodes = nodesOf(twinTree);
  const nodes = nodesOf(tree);
  if (twinNodes.length !== nodes.length) throw unreadable();
  nodes.forEach((node, k) => {
    const twinNode = twinNodes[k] as MathNode;
    if (node.type !== twinNode.type) throw unreadable();
    if (!isOperatorNode(node) || !isOperatorNode(twinNode) || node.fn === twinNode.fn) return;
    const operator = SCALAR_OPERATORS.get(node.fn);
    if (operator?.twinFn !== twinNode.fn) throw unreadable();
    for (const operand of node.args) {
      if (isCollectionLiteral(operand)) throw scalarOperandError(operator);
      requireScalar(operand, operator);
    }
  });
}

/** Wrap a node's `_compile` so its evaluated value must not be a vector or matrix. */
function requireScalar(node: MathNode, operator: ScalarOperator): void {
  type CompiledNode = (...args: unknown[]) => unknown;
  const target = node as unknown as {
    _compile(math: unknown, argNames: unknown): CompiledNode;
  };
  const compile = target._compile.bind(target);
  target._compile = (math, argNames) => {
    const evaluate = compile(math, argNames);
    return (...args: unknown[]) => {
      const value = evaluate(...args);
      if (isCollection(value)) throw scalarOperandError(operator);
      return value;
    };
  };
}
