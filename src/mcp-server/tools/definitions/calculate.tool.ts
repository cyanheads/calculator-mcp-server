/**
 * @fileoverview Calculate tool — evaluate, simplify, or differentiate math expressions.
 * Single tool covering 100% of the server's purpose.
 * @module mcp-server/tools/definitions/calculate.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { DEFAULT_MAX_EXPRESSION_LENGTH } from '@/config/server-config.js';
import { CONTRACT_HINT_CODE, getMathService } from '@/services/math/math-service.js';
import {
  MAX_BERNOULLI_INDEX,
  MAX_EVALUATION_ELEMENTS,
  MAX_MATRIX_ELEMENTS,
  MAX_STIRLING_N,
} from '@/services/math/size-guard.js';

/** The default expression length limit as the description and contract state it. */
const DEFAULT_LENGTH = DEFAULT_MAX_EXPRESSION_LENGTH.toLocaleString('en-US');

export const calculateTool = tool('calculate', {
  description:
    'Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. One expression per call. Supports arithmetic, trigonometry, statistics, matrices, linear systems, polynomial roots, complex numbers, units, combinatorics, calendar dates (quoted YYYY-MM-DD strings), and numeric definite integrals.',
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
        `One mathematical expression per call, at most ${DEFAULT_LENGTH} characters by default — neither \`;\` nor newlines separate statements. Inside matrices, \`;\` separates rows (e.g. \`[1, 2; 3, 4]\`). Supports arithmetic (+, -, *, /, ^, %), functions across arithmetic/trig (sin, cos, sqrt, log, abs, round), statistics (mean, median, std, variance — std and variance return the sample (n − 1) form by default; pass "uncorrected" for the population form, e.g. \`std([2, 4, 6], "uncorrected")\`), combinatorics (factorial, permutations, combinations), matrices (det, inv, transpose, eigs, eigenvalues, and \`lusolve(A, b)\` for A·x = b), polynomial roots (\`polynomialRoot\` takes the coefficients constant term first, degree 3 or less: \`polynomialRoot(8, -6, 1)\` for x^2 - 6x + 8 returns \`[4, 2]\`; there is no roots or solve function), constants (pi, e, phi, i), units (5 kg to lbs), and variables (when scope is provided). Dimension arguments are one-based. Dates are quoted "YYYY-MM-DD" strings, years 0000–9999 (an unquoted 2026-10-26 is subtraction): \`dateDiff(start, end, unit)\`, \`dateAdd(date, count, unit)\`, \`weekday(date)\`, \`isoWeek(date)\`, and \`daysInMonth(year, month)\`, with unit "days" (default), "weeks", "months", or "years". \`integrate(f, x, a, b)\` estimates a definite integral over finite bounds, under numericType "number" only. Standard notation is accepted: \`ln\` and \`arc*\` (e.g. \`arcsin\`, \`arctan\`) for \`log\` and \`asin\`/\`atan\`, and, outside strings, \`**\` for \`^\`, \`×\` for \`*\`, \`÷\` for \`/\`, \`−\` for \`-\`, and \`°\`, \`°C\`, \`°F\` for deg, degC, degF (\`×\` and \`**\` take scalar operands only). Synonyms run the math.js function in every operation: \`average\`/\`avg\` (mean), \`stdev\`/\`stddev\` (std), \`permute\`/\`nPr\` (permutations), \`choose\`/\`nCr\` (combinations), \`length\`/\`len\` (count), \`eig\` (eigs), and \`integral\` (integrate); \`eig\` and \`integral\`, like \`ln\` and \`arc*\`, work only when called.`,
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
        'Variable assignments for evaluate; simplify and derivative ignore them. Example: { "x": 5, "y": 3 } makes "x + y" evaluate to 8. Values take the selected numericType: "BigNumber" reads each value from its shortest decimal form ({ "x": 1e16, "y": 1 } makes "(x + y) - x" return 1), and "Fraction" reads it as the matching decimal literal (0.1 reads as 1/10). JSON rounds a number past about 17 significant digits before it arrives; write a longer number in the expression instead.',
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
        'Numeric type for evaluate. "number" (default): 64-bit IEEE 754 float — fastest, about 16 significant digits; a value past about 1.8e308 (171!, 2^1024, exp(1000)) overflows and fails with undefined_result. "BigNumber": decimal with 64 significant digits and decimal exponents up to 9e15, slower than "number" — retry a "number" overflow with it; results are 64-digit approximations (10000!/9999! returns 9999.99…96, which precision: 16 rounds to 10000). Under "BigNumber", erf, lgamma, and zeta have no implementation, gamma and ! take only integers, and an inverse trig or hyperbolic function outside its real domain (asin(2)) fails with undefined_result where "number" returns a complex value — use "number" for those. Division by zero, 0/0, and log(0) are undefined in every numeric type, so another numeric type does not fix them. "Fraction": exact rational arithmetic (0.1 + 0.2 returns 3/10), including integer combinatorics (5! returns 120/1) and roots and fractional powers with a rational value (sqrt(9/4) returns 3/2, (9/4)^(3/2) returns 27/8), and complex powers and roots whose parts are integers ((1+2i)^2 returns -3 + 4i); fails with fraction_unsupported when the result has no exact rational value (sqrt(2), 2^(1/2), sin(1), log(3)), the expression calls a function Fraction mode cannot compute (log2(8), stirlingS2(5, 2)), or it uses a value Fraction mode holds only as a rounded float (pi, e, a complex number with a non-integer part, number(x), random()) — use "number" or "BigNumber" for those. A unit conversion with an irrational factor (30 deg to rad) returns a close rational approximation, not an exact value. integrate() works under "number" only; the numeric results of date functions are plain integers in every numeric type. Ignored for symbolic operations (simplify, derivative).',
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
      when: `Expression exceeds the configured max length (CALC_MAX_EXPRESSION_LENGTH, default ${DEFAULT_LENGTH} characters).`,
      recovery: 'Shorten the expression or split it into multiple separate calls.',
    },
    {
      reason: 'expression_too_deep',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The expression nests deeper than the call stack allows while it is parsed, checked, or computed — many nested parentheses, brackets, or function calls, or a long chain of unary or postfix operators. The depth that fits depends on the runtime.',
      recovery: `Reduce the nesting, write a long sum or product as ${CONTRACT_HINT_CODE.expression_too_deep[0]} or ${CONTRACT_HINT_CODE.expression_too_deep[1]}, or split the expression into separate calls.`,
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
      when: `The result exceeds the configured max size (CALC_MAX_RESULT_LENGTH), the expression would build a matrix, range, or string over the per-call limit (${MAX_MATRIX_ELEMENTS.toLocaleString('en-US')} elements or characters, the digits of a Fraction factorial, binomial, or power included) or more than ${MAX_EVALUATION_ELEMENTS.toLocaleString('en-US')} in total across one evaluation, or an argument passes a function's size limit (stirlingS2 and bellNumbers take n up to ${MAX_STIRLING_N.number.toLocaleString('en-US')}, or ${MAX_STIRLING_N.BigNumber} with a BigNumber argument; bernoulli takes an even n up to ${MAX_BERNOULLI_INDEX.toLocaleString('en-US')}).`,
      recovery:
        'Reduce precision, narrow the input range, or compute smaller subproblems separately.',
    },
    {
      reason: 'undefined_result',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The result is Infinity, -Infinity, or NaN anywhere in it (including matrix elements, unit magnitudes, and object values): an undefined operation such as 1/0, 0/0, or log(0), a value that overflowed its numeric range (e.g. 171! or 2^1024 under numericType "number", exp(1e17) under "BigNumber"), or under "BigNumber" an inverse trig or hyperbolic function outside its real domain (e.g. asin(2)). Under "BigNumber" the failure carries its own recovery hint.',
      recovery:
        'Division by zero, 0/0, and log(0) are undefined in every numericType, so fix the expression; for an overflow (large powers, factorials, exp), retry with numericType "BigNumber".',
    },
    {
      reason: 'fraction_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'numericType is "Fraction" and the result has no exact rational value (e.g. sqrt(2), 2^(1/2), sin(1), log(3)), the expression calls a function Fraction mode cannot compute, even for a rational result (e.g. log2(8), stirlingS2(5, 2)), or it uses a value Fraction mode holds only as a rounded 64-bit float (e.g. pi, e, a complex number with a non-integer part, number(x), random()). integrate() under "Fraction" carries its own hint to retry with "number".',
      recovery:
        'Retry with numericType "number" or "BigNumber" — both compute these functions and values, including irrational and transcendental results.',
    },
    {
      reason: 'parse_failed',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'math.js could not parse the expression (a "(char N)" position counts characters of the expression as sent), including a "×" or "**" whose operands could not be told apart; or it names an undefined symbol, function, or unit, or calls a function disabled for security. A call to roots or solve (which names polynomialRoot and lusolve instead) and, under evaluate, a call to now() or today() (the calculator reads no clock) carry their own recovery hints.',
      recovery:
        'Check syntax for balanced parentheses, valid operators, and correct function and unit names; pass variable values through scope.',
    },
    {
      reason: 'operation_as_function',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The expression calls `evaluate`, `simplify`, or `derivative` — those are operations, selected with the `operation` parameter.',
      recovery:
        'Send the argument of the call as expression, with operation set to the function name; for derivative, send its second argument as variable.',
    },
    {
      reason: 'type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An operand has the wrong type or unit for the operation — a bare number added to a unit, mismatched units, a unit in an exponent, or a non-numeric string in arithmetic. Four cases carry their own recovery hint: a function used as a value (`5 min`, where `min` is the minimum function), a vector or matrix operand of `×` or `**`, a 64-bit float of more than 15 significant digits meeting a BigNumber, and under numericType "BigNumber" a function with no BigNumber implementation (`erf`).',
      recovery: `Attach the same unit to the bare operand (${CONTRACT_HINT_CODE.type_mismatch[0]}) or strip it (${CONTRACT_HINT_CODE.type_mismatch[1]}), keep exponents unitless, and use numbers instead of strings.`,
    },
    {
      reason: 'evaluation_failed',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The expression parsed but could not be computed — wrong argument count, a value outside the function domain, a singular matrix passed to inv or an inconsistent system passed to lusolve (a consistent singular system returns one of its solutions), mismatched matrix dimensions, an index out of range, or a zero range step; a date argument that is not a quoted YYYY-MM-DD calendar date (an unquoted date reads as subtraction), a fractional count, an unknown unit, or a date result outside years 0000–9999; an integrate() call with infinite bounds, a non-symbol variable, a quoted integrand, a non-finite or non-real sample, or no convergence within 500 subintervals — or simplify/derivative cannot process part of it (e.g. a function with no derivative rule). Under numericType "BigNumber", integrate(), lgamma, zeta, and gamma or factorial at a non-integer carry their own hint to retry with "number".',
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
          ...math.evaluateExpression(expression, scope, precision, numericType),
          expression,
          operation,
          // Omit context fields that carry no signal: scopeVars only when a scope
          // was supplied, precisionUsed only when a precision was applied (#14).
          ...(scope ? { scopeVars: Object.keys(scope) } : {}),
          ...(precision !== undefined ? { precisionUsed: precision } : {}),
        };
      case 'simplify': {
        const simplifyResult = math.simplifyExpression(expression);
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
          );
        }
        ctx.log.info('Differentiated expression', { expression, variable });
        // Symbolic operations never carry scope/precision context — omit both.
        return {
          ...math.differentiateExpression(expression, variable),
          expression,
          operation,
        };
      default:
        throw internalError(`Unhandled operation: ${operation as string}`);
    }
  },

  format: (output) => {
    const lines = [
      `**Expression:** ${escapeMarkdownInline(output.expression)}`,
      `**Operation:** ${output.operation}`,
      `**Result:** ${escapeMarkdownInline(output.result)}`,
      `**Type:** ${escapeMarkdownInline(output.resultType)}`,
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
        ? output.scopeVars.map(escapeMarkdownInline).join(', ')
        : 'none';
      lines.push(`**Scope variables:** ${scopeVars}`);
      lines.push(`**Precision:** ${output.precisionUsed ?? 'full'}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
