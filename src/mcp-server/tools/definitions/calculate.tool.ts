/**
 * @fileoverview Calculate tool — evaluate, simplify, or differentiate math expressions.
 * Single tool covering 100% of the server's purpose.
 * @module mcp-server/tools/definitions/calculate.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMathService } from '@/services/math/math-service.js';
import { MAX_EVALUATION_ELEMENTS, MAX_MATRIX_ELEMENTS } from '@/services/math/size-guard.js';

export const calculateTool = tool('calculate', {
  description:
    'Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. One expression per call. Supports arithmetic, trigonometry, statistics, matrices, complex numbers, units, and combinatorics.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    expression: z
      .string()
      .min(1)
      .describe(
        `One mathematical expression per call — neither \`;\` nor newlines separate statements. Inside matrices, \`;\` separates rows (e.g. \`[1, 2; 3, 4]\`). Supports arithmetic (+, -, *, /, ^, %), functions across arithmetic/trig (sin, cos, sqrt, log, abs, round), statistics (mean, median, std, variance — std and variance return the sample (n − 1) form by default; pass "uncorrected" for the population form, e.g. \`std([2, 4, 6], "uncorrected")\`), combinatorics (factorial, permutations, combinations), and matrix (det, inv, transpose), plus constants (pi, e, phi, i), units (5 kg to lbs), and variables (when scope is provided). Standard notation \`ln\` and \`arc*\` (e.g. \`arcsin\`, \`arctan\`) is accepted alongside the math.js names \`log\` and \`asin\`/\`atan\`; common synonyms such as \`stdev\`, \`permute\`, \`nCr\`, and \`length\`/\`len\` resolve to their math.js names (\`std\`, \`permutations\`, \`combinations\`, \`count\`).`,
      ),
    operation: z
      .enum(['evaluate', 'simplify', 'derivative'])
      .default('evaluate')
      .describe(
        'Operation to perform. "evaluate" computes a numeric result (default). "simplify" reduces an algebraic expression symbolically (e.g., "2x + 3x" -> "5 * x"). Supports algebraic and trigonometric identities. When the simplifier cannot reduce the expression further (e.g. rational expressions requiring polynomial factoring), the result is returned unchanged and unchanged: true is set in the output. "derivative" computes the symbolic derivative (requires the variable parameter).',
      ),
    variable: z
      .union([
        z.literal('').describe('Empty string — treated as omitted.'),
        z
          .string()
          .max(50)
          .regex(
            /^[a-zA-Z_][a-zA-Z0-9_]*$/,
            'Variable name must be alphanumeric (a-z, A-Z, 0-9, _).',
          )
          .describe('Variable identifier (alphanumeric and underscores, max 50 chars).'),
      ])
      .optional()
      .describe(
        'Variable to differentiate with respect to. Required when operation is "derivative". Empty string is treated as omitted. Example: "x".',
      ),
    scope: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'Variable assignments for evaluate; simplify and derivative ignore them. Example: { "x": 5, "y": 3 } makes "x + y" evaluate to 8.',
      ),
    precision: z
      .union([
        z.literal('').describe('Empty string — treated as omitted.'),
        z.number().int().min(1).max(16).describe('Significant digits (integer, 1–16).'),
      ])
      .optional()
      .describe(
        'Significant digits (1–16) for numeric results. Omit for full precision. Empty string is treated as omitted. Fraction results always print exactly, and symbolic operations (simplify, derivative) ignore it.',
      ),
    numericType: z
      .enum(['number', 'BigNumber', 'Fraction'])
      .default('number')
      .describe(
        'Numeric type for evaluate. "number" (default): 64-bit IEEE 754 float — fastest, about 16 significant digits; a value past about 1.8e308 (171!, 2^1024, exp(1000)) overflows and fails with undefined_result. "BigNumber": decimal with 64 significant digits and a much wider exponent range, slower than "number" — retry an overflow with it; results are 64-digit approximations (10000!/9999! returns 9999.99…96, which precision: 16 rounds to 10000). Division by zero, 0/0, and log(0) are undefined in every numeric type, so another numeric type does not fix them. "Fraction": exact rational arithmetic (0.1 + 0.2 returns 3/10); fails with fraction_unsupported when the result has no exact rational value (sqrt(2), sin(1), log(3)), the expression calls a function Fraction mode cannot compute (sqrt(4), 5!, combinations(5, 2)), or it uses a value Fraction mode holds only as a rounded float (pi, e, 2^(1/2), a complex number with a non-integer part, number(x), random()) — use "number" or "BigNumber" for those. A unit conversion with an irrational factor (30 deg to rad) returns a close rational approximation, not an exact value. Ignored for symbolic operations (simplify, derivative).',
      ),
  }),
  output: z.object({
    result: z.string().describe('The computed result as a string.'),
    resultType: z
      .string()
      .describe(
        'Type of result as reported by math.js. Common values: number, BigNumber, Fraction, Complex, DenseMatrix, SparseMatrix, Array, Unit, string, boolean. Symbolic operations return "string".',
      ),
    expression: z.string().describe('The original expression as received.'),
    operation: z
      .enum(['evaluate', 'simplify', 'derivative'])
      .describe('The operation that was applied.'),
    scopeVars: z
      .array(z.string())
      .optional()
      .describe(
        'Keys from the scope that were active during evaluation. Omitted when no scope was provided and for symbolic operations, which ignore scope. Values are omitted to keep output compact.',
      ),
    precisionUsed: z
      .number()
      .optional()
      .describe(
        'The precision value supplied for evaluate. Fraction results print exactly regardless. Omitted when no precision was supplied or the operation is symbolic.',
      ),
    unchanged: z
      .boolean()
      .optional()
      .describe(
        "Present only for simplify operations. true means the simplifier returned the expression unchanged — it could not reduce it further (e.g. rational expressions requiring polynomial factoring are beyond math.js's built-in simplifier). false means simplification made progress. Omitted for evaluate and derivative.",
      ),
  }),
  errors: [
    {
      reason: 'empty_expression',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Expression is empty or whitespace-only.',
      recovery: 'Provide a non-empty math expression in the expression parameter.',
    },
    {
      reason: 'expression_too_long',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Expression exceeds the configured max length (CALC_MAX_EXPRESSION_LENGTH).',
      recovery: 'Shorten the expression or split it into multiple separate calls.',
    },
    {
      reason: 'multiple_expressions',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Expression holds more than one statement — a `;` or newline at the top level, outside brackets, parentheses, and string literals.',
      recovery: 'Send one expression per call; issue separate calls for each statement.',
    },
    {
      reason: 'reserved_scope_key',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Scope contains a reserved JS property name (`__proto__`, `constructor`, etc.).',
      recovery: 'Rename the variable to avoid reserved JavaScript property names.',
    },
    {
      reason: 'disallowed_result_type',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The result is a function (e.g. a bare `sin`, or `f(x) = x^2`) or a help() object, or the expression converts a function to a string (e.g. `cos.toString()`) — security guard.',
      recovery:
        'Rewrite the expression to produce a value (number, matrix, unit) instead of a function or its source; for function documentation, read the calculator://help resource.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: `The result exceeds the configured max size (CALC_MAX_RESULT_LENGTH), or the expression would build a matrix or string over the per-call limit (${MAX_MATRIX_ELEMENTS.toLocaleString('en-US')} elements or characters), or more than ${MAX_EVALUATION_ELEMENTS.toLocaleString('en-US')} in total across one evaluation.`,
      recovery:
        'Reduce precision, narrow the input range, or compute smaller subproblems separately.',
    },
    {
      reason: 'undefined_result',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The result is Infinity, -Infinity, or NaN anywhere in it (including matrix elements, unit magnitudes, and object values): an undefined operation such as 1/0, 0/0, or log(0), or a value that overflowed its numeric range (e.g. 171! or 2^1024 under numericType "number").',
      recovery:
        'Division by zero, 0/0, and log(0) are undefined in every numericType, so fix the expression; for an overflow (large powers, factorials, exp), retry with numericType "BigNumber".',
    },
    {
      reason: 'fraction_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'numericType is "Fraction" and the result has no exact rational value (e.g. sqrt(2), sin(1), log(3)), the expression calls a function Fraction mode cannot compute, even for a rational result (e.g. sqrt(4), 5!, combinations(5, 2)), or it uses a value Fraction mode holds only as a rounded 64-bit float (e.g. pi, e, 2^(1/2), a complex number with a non-integer part, number(x), random()).',
      recovery:
        'Retry with numericType "number" or "BigNumber" — both compute these functions and values, including irrational and transcendental results.',
    },
    {
      reason: 'parse_failed',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'mathjs could not parse the expression, or it names an undefined symbol, function, or unit, or calls a function disabled for security.',
      recovery:
        'Check syntax for balanced parentheses, valid operators, and correct function and unit names; pass variable values through scope.',
    },
    {
      reason: 'operation_as_function',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The expression calls `evaluate`, `simplify`, or `derivative` — those are operations, selected with the `operation` parameter.',
      recovery:
        'Send the inner expression as `expression` with `operation` set to that function name; for `derivative`, also pass `variable`.',
    },
    {
      reason: 'type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An operand has the wrong type or unit for the operation — a bare number added to a unit, mismatched units, a unit in an exponent, a non-numeric string in arithmetic, or a function used as a value (`5 min`, where `min` is the minimum function; that case carries its own recovery hint).',
      recovery:
        'Attach the same unit to the bare operand (`5 kg + 3 kg`) or strip it (`number(5 kg, "kg") + 3`), keep exponents unitless, and use numbers instead of strings.',
    },
    {
      reason: 'evaluation_failed',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The expression parsed but could not be computed — wrong argument count, a value outside the function domain, a singular matrix, mismatched matrix dimensions, or an index out of range — or simplify/derivative cannot process part of it (e.g. a function with no derivative rule).',
      recovery:
        'The syntax is valid — fix the argument the error message names (its count, value range, or matrix dimensions) and retry.',
    },
    {
      reason: 'derivative_missing_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: '`operation` is `derivative` but `variable` was not provided.',
      recovery: 'Pass the variable parameter (e.g., "x") when operation is "derivative".',
    },
    {
      reason: 'evaluation_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: 'Expression evaluation exceeded the configured timeout (CALC_EVALUATION_TIMEOUT_MS).',
      retryable: false,
      recovery:
        'Simplify the expression or reduce computational complexity to fit within the timeout.',
    },
  ],

  handler(input, ctx) {
    const math = getMathService();
    const { expression, operation, scope } = input;
    const variable = input.variable || undefined;
    const precision = typeof input.precision === 'number' ? input.precision : undefined;
    const numericType = input.numericType;

    switch (operation) {
      case 'evaluate':
        ctx.log.info('Evaluated expression', { expression, numericType });
        return {
          ...math.evaluateExpression(expression, ctx, scope, precision, numericType),
          expression,
          operation,
          // Omit context fields that carry no signal: scopeVars only when a scope
          // was supplied, precisionUsed only when a precision was applied (#14).
          ...(scope ? { scopeVars: Object.keys(scope) } : {}),
          ...(precision !== undefined ? { precisionUsed: precision } : {}),
        };
      case 'simplify': {
        const simplifyResult = math.simplifyExpression(expression, ctx);
        ctx.log.info('Simplified expression', { expression, unchanged: simplifyResult.unchanged });
        // Symbolic operations never carry scope/precision context — omit both.
        // Always include unchanged so callers can detect no-op simplifications (#1).
        return {
          result: simplifyResult.result,
          resultType: simplifyResult.resultType,
          expression,
          operation,
          unchanged: simplifyResult.unchanged,
        };
      }
      case 'derivative':
        if (!variable) {
          throw ctx.fail(
            'derivative_missing_variable',
            "The 'variable' parameter is required when operation is 'derivative'.",
            { ...ctx.recoveryFor('derivative_missing_variable') },
          );
        }
        ctx.log.info('Differentiated expression', { expression, variable });
        // Symbolic operations never carry scope/precision context — omit both.
        return {
          ...math.differentiateExpression(expression, variable, ctx),
          expression,
          operation,
        };
      default:
        throw new Error(`Unhandled operation: ${operation as string}`);
    }
  },

  format: (output) => {
    const lines = [
      `**Expression:**${labeled(output.expression)}`,
      `**Operation:** ${output.operation}`,
      `**Result:**${labeled(output.result)}`,
      `**Type:** ${output.resultType}`,
    ];
    if (output.unchanged !== undefined) {
      // Present only for simplify — unchanged: true means the simplifier made no progress.
      lines.push(
        output.unchanged
          ? '**Simplified:** unchanged — expression could not be reduced further'
          : '**Simplified:** reduced (unchanged: false)',
      );
    }
    // Symbolic operations ignore scope and precision, so only evaluate reports them.
    if (output.operation === 'evaluate') {
      const scopeVars = output.scopeVars?.length
        ? output.scopeVars.map(literal).join(', ')
        : 'none';
      lines.push(`**Scope variables:** ${scopeVars}`);
      lines.push(`**Precision:** ${output.precisionUsed ?? 'full'}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Length of the longest run of consecutive backticks in `value` (0 when it has none). */
function longestBacktickRun(value: string): number {
  return Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
}

/**
 * Render caller-influenced text so a CommonMark reader sees it byte-for-byte:
 * a code span whose fence is one backtick longer than the value's longest
 * backtick run, space-padded when the value starts or ends with a backtick or
 * space (CommonMark strips one padding space from each side). A value made only
 * of spaces is never stripped, so it goes unpadded; an empty value cannot be a
 * code span and renders as a plain marker. A value with a line break goes in a
 * fenced block on its own lines, sized the same way. No backslash escaping:
 * `*`, `_`, `^`, and `[` are math syntax and must survive a copy. CommonMark
 * normalizes a carriage return to a line feed, so a value holding one (only an
 * expression or scope key can — math.js escapes it in results) reads back with
 * `\n` in its place; `structuredContent` keeps the exact bytes.
 */
function literal(value: string): string {
  if (value === '') return '(empty)';
  const run = longestBacktickRun(value);
  if (/[\r\n]/.test(value)) {
    const fence = '`'.repeat(Math.max(3, run + 1));
    return `\n${fence}\n${value}\n${fence}\n`;
  }
  const fence = '`'.repeat(run + 1);
  const pad = /^[` ]|[` ]$/.test(value) && !/^ +$/.test(value) ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A labeled value: a code span after the label, or a fenced block below it. */
function labeled(value: string): string {
  const rendered = literal(value);
  return rendered.startsWith('\n') ? rendered.slice(0, -1) : ` ${rendered}`;
}
